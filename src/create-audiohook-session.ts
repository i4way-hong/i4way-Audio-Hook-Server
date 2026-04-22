import { FastifyRequest } from 'fastify';
import { Level as LogLevel } from 'pino';
import {
    isUuid,
    httpsignature as httpsig,
    createServerSession,
    ServerSession,
    ServerWebSocket,
    SupportedLanguages
} from '../audiohook';
import { registerConversationLookup } from './conversation-lookup';
import type WebSocket from 'ws';

const isLocal = process.env['NODE_ENV'] !== 'dev';

export type AudioHookSessionContext = {
    readonly session: ServerSession;
    readonly sessionId: string;
    readonly correlationId: string;
    readonly organizationId: string;
}

export type AudioHookSessionCreateOptions = {
    request: FastifyRequest;
    sessionLogLevel?: LogLevel;
    supportedLanguages?: SupportedLanguages;
} & ({
    ws: ServerWebSocket;
    connection?: WebSocket;  // If we have a ws, the raw connection is optional
} | {
    ws?: undefined;
    connection: WebSocket;   // If we don't have a wrapped ws, the raw connection is required
});

export const createAudioHookSession = ({ request, sessionLogLevel, supportedLanguages, ws, connection }: AudioHookSessionCreateOptions): AudioHookSessionContext => {

    const sessionId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-session-id');
    if(!sessionId || !isUuid(sessionId)) {
        throw new RangeError(`Missing or invalid "audiohook-session-id" header field. RemoteAddr: ${request.socket.remoteAddress}, Headers: ${JSON.stringify(request.headers, null, 1)}`);
    }

    const correlationId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-correlation-id');
    if(!correlationId || !isUuid(correlationId)) {
        throw new RangeError(`Missing or invalid "audiohook-correlation-id" header field. RemoteAddr: ${request.socket.remoteAddress}, Headers: ${JSON.stringify(request.headers, null, 1)}`);
    }

    const organizationId = httpsig.queryCanonicalizedHeaderField(request.headers, 'audiohook-organization-id');
    if(!organizationId || !isUuid(organizationId)) {
        throw new RangeError(`Missing or invalid "audiohook-organization-id" header field. RemoteAddr: ${request.socket.remoteAddress}, Headers: ${JSON.stringify(request.headers, null, 1)}`);
    }

    if(connection && isLocal && (connection.binaryType !== 'nodebuffer')) {
        throw new Error(`WebSocket binary type '${connection.binaryType}' not supported`);
    }

    const upstreamWs = ws ?? connection;
    if(!upstreamWs) {
        throw new Error('Missing WebSocket connection for session');
    }

    const session = createServerSession({
        ws: upstreamWs,
        id: sessionId,
        logger: request.server.log.child({ session: sessionId }, { level: sessionLogLevel ?? (isLocal ? 'debug' : 'info') }),
        supportedLanguages
    });

    registerConversationLookup(session, { logger: session.logger });

    return { session, sessionId, correlationId, organizationId };
};
