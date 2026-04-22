/**
 * External conversation lookup helper.
 */
import dotenv from 'dotenv';
import { isNullUuid, type ServerSession, type Uuid, type Logger } from '../audiohook';

dotenv.config();

const LOOKUP_BASE_URL = process.env['CONVERSATION_LOOKUP_URL'] || '';
const QUERY_PARAM = process.env['CONVERSATION_LOOKUP_QUERY_PARAM'] || 'conversation_id';
const REQUEST_TIMEOUT_MS = Math.max(0, parseInt(process.env['CONVERSATION_LOOKUP_TIMEOUT_MS'] || '3000', 10));
const CACHE_SECONDS = Math.max(0, parseInt(process.env['CONVERSATION_LOOKUP_CACHE_SECONDS'] || '30', 10));
const RETRY_ATTEMPTS = Math.max(0, parseInt(process.env['CONVERSATION_LOOKUP_RETRY_ATTEMPTS'] || '0', 10));
const RETRY_DELAY_MS = Math.max(0, parseInt(process.env['CONVERSATION_LOOKUP_RETRY_DELAY_MS'] || '1500', 10));

const CONVERSATION_RECORDS_SYMBOL = Symbol.for('audiohook.conversationLookup.records');
const CONVERSATION_ID_SYMBOL = Symbol.for('audiohook.conversationLookup.conversationId');

export type ConversationRecord = Record<string, unknown>;
export type ConversationLookupResult = ConversationRecord[];

type ConversationMetadataCarrier = {
    [CONVERSATION_RECORDS_SYMBOL]?: ConversationLookupResult | undefined;
    [CONVERSATION_ID_SYMBOL]?: string | undefined;
};

type RetryController = { cancelled: boolean };

const cache: Map<string, { expires: number; data: ConversationLookupResult }> = new Map();
const sessionStore: WeakMap<ServerSession, ConversationLookupResult> = new WeakMap();
const retryControllers: WeakMap<ServerSession, RetryController> = new WeakMap();

const isLookupEnabled = LOOKUP_BASE_URL.length > 0;

const now = () => Date.now();
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function performLookup(conversationId: string, logger?: Logger): Promise<ConversationLookupResult | null> {
    logger?.debug?.(`[conversation-lookup] Looking up conversationId=${conversationId}`);
    if (!isLookupEnabled) {
        return null;
    }
    if (!conversationId || isNullUuid(conversationId as unknown as Uuid)) {
        return null;
    }
    logger?.debug?.('[conversation-lookup] Pass 1');
    if (CACHE_SECONDS > 0) {
        const cached = cache.get(conversationId);
        if (cached && cached.expires > now()) {
            return cached.data;
        }
    }
    logger?.debug?.('[conversation-lookup] Pass 2');
    let requestUrl: URL;
    try {
        requestUrl = new URL(LOOKUP_BASE_URL);
    } catch (err) {
        logger?.warn?.(`Conversation lookup URL invalid: ${String(err)}`);
        return null;
    }
    logger?.debug?.('[conversation-lookup] Pass 3');
    requestUrl.searchParams.set(QUERY_PARAM, conversationId);

    const controller = new AbortController();
    const timeoutHandle = REQUEST_TIMEOUT_MS > 0
        ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
        : null;

    try {
        const response = await fetch(requestUrl, {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        });
        if (!response.ok) {
            logger?.warn?.(`Conversation lookup failed for ${conversationId}: HTTP ${response.status}`);
            return null;
        }
        const payload = await response.json();
        const result: ConversationLookupResult = Array.isArray(payload) ? payload : [payload];
        if (CACHE_SECONDS > 0) {
            cache.set(conversationId, { data: result, expires: now() + CACHE_SECONDS * 1000 });
        }
        logger?.debug?.(`[conversation-lookup] result = ${JSON.stringify(result)}`);
        return result;
    } catch (err) {
        if ((err as Error)?.name === 'AbortError') {
            logger?.warn?.(`Conversation lookup timed out for ${conversationId} after ${REQUEST_TIMEOUT_MS}ms`);
        } else {
            logger?.warn?.(`Conversation lookup error for ${conversationId}: ${String(err)}`);
        }
        return null;
    } finally {
        if (timeoutHandle) {
            clearTimeout(timeoutHandle);
        }
    }
}

export async function lookupConversation(conversationId: string, logger?: Logger): Promise<ConversationLookupResult | null> {
    return performLookup(conversationId, logger);
}

function cancelLookupRetry(session: ServerSession): void {
    const controller = retryControllers.get(session);
    if (controller) {
        controller.cancelled = true;
        retryControllers.delete(session);
    }
}

function startLookupRetry(options: {
    session: ServerSession;
    carrier: ConversationMetadataCarrier;
    conversationId: string;
    logger?: Logger;
}): void {
    if (RETRY_ATTEMPTS <= 0) {
        return;
    }
    const { session, carrier, conversationId, logger } = options;
    cancelLookupRetry(session);
    const controller: RetryController = { cancelled: false };
    retryControllers.set(session, controller);

    const run = async () => {
        for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
            if (controller.cancelled) {
                break;
            }
            if (RETRY_DELAY_MS > 0) {
                await delay(RETRY_DELAY_MS);
            }
            if (controller.cancelled) {
                break;
            }
            const records = await performLookup(conversationId, logger);
            if (controller.cancelled) {
                break;
            }
            if (records && records.length > 0) {
                sessionStore.set(session, records);
                Reflect.set(carrier, CONVERSATION_RECORDS_SYMBOL, records);
                logger?.info?.(`[conversation-lookup] conversationId=${conversationId} records=${records.length} (retry ${attempt}/${RETRY_ATTEMPTS})`);
                retryControllers.delete(session);
                return;
            }
            logger?.debug?.(`[conversation-lookup] retry attempt=${attempt}/${RETRY_ATTEMPTS} returned 0 records for conversationId=${conversationId}`);
        }
        logger?.warn?.(`[conversation-lookup] retries exhausted for conversationId=${conversationId}`);
        retryControllers.delete(session);
    };

    void run();
}

export function registerConversationLookup(session: ServerSession, options?: { logger?: Logger }): void {
    session.addOpenHandler(async ({ openParams }) => {
        const conversationId = openParams.conversationId;
        const carrier = session as ConversationMetadataCarrier;
        const logger = options?.logger ?? session.logger;

        if (conversationId && !isNullUuid(conversationId)) {
            Reflect.set(carrier, CONVERSATION_ID_SYMBOL, conversationId);
        } else {
            Reflect.deleteProperty(carrier, CONVERSATION_ID_SYMBOL);
        }

        if (!isLookupEnabled || !conversationId || isNullUuid(conversationId)) {
            Reflect.deleteProperty(carrier, CONVERSATION_RECORDS_SYMBOL);
            sessionStore.delete(session);
            return async () => {
                cancelLookupRetry(session);
                sessionStore.delete(session);
                Reflect.deleteProperty(carrier, CONVERSATION_RECORDS_SYMBOL);
                if (!conversationId || isNullUuid(conversationId)) {
                    Reflect.deleteProperty(carrier, CONVERSATION_ID_SYMBOL);
                }
            };
        }

        const records = await performLookup(conversationId, logger);
        if (!records || records.length === 0) {
            sessionStore.delete(session);
            Reflect.deleteProperty(carrier, CONVERSATION_RECORDS_SYMBOL);
            startLookupRetry({ session, carrier, conversationId, logger });
            return async () => {
                cancelLookupRetry(session);
                sessionStore.delete(session);
                Reflect.deleteProperty(carrier, CONVERSATION_RECORDS_SYMBOL);
                Reflect.deleteProperty(carrier, CONVERSATION_ID_SYMBOL);
            };
        }

        sessionStore.set(session, records);
        Reflect.set(carrier, CONVERSATION_RECORDS_SYMBOL, records);
        logger.info?.(`[conversation-lookup] conversationId=${conversationId} records=${records.length}`);
        return async () => {
            cancelLookupRetry(session);
            sessionStore.delete(session);
            Reflect.deleteProperty(carrier, CONVERSATION_RECORDS_SYMBOL);
            Reflect.deleteProperty(carrier, CONVERSATION_ID_SYMBOL);
        };
    });
}

export function getConversationRecords(session: ServerSession): ConversationLookupResult | undefined {
    const direct = sessionStore.get(session);
    if (direct) {
        return direct;
    }
    const carrier = session as ConversationMetadataCarrier;
    return Reflect.get(carrier, CONVERSATION_RECORDS_SYMBOL);
}

export function clearConversationRecords(session: ServerSession): void {
    sessionStore.delete(session);
    const carrier = session as ConversationMetadataCarrier;
    Reflect.deleteProperty(carrier, CONVERSATION_RECORDS_SYMBOL);
    Reflect.deleteProperty(carrier, CONVERSATION_ID_SYMBOL);
}
