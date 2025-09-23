// Vendor plugin interface for STT forwarders (WebSocket/TCP)
// Allows customizing handshake messages, payload shaping (e.g., JSON base64), and incoming result parsing.

export interface ParsedResult {
    text?: string;
    nbest?: unknown;
    [k: string]: unknown;
}

export interface SttVendorPlugin {
    // Optional: customize WebSocket INIT/BYE text frames
    wsInit?(): string | undefined;
    wsBye?(): string | undefined;
    // Optional: transform outgoing WS payload
    // - mode: 'binary' | 'json-base64'
    // - returns string for text frame or Buffer for binary frame
    transformOutgoingWs?(payload: Buffer, mode: 'binary' | 'json-base64', ctx: {
        encoding: 'L16' | 'PCMU';
        rate: number;
        mono: boolean;
        audioKey: string;
    }): string | Buffer;
    // Optional: parse incoming WS/TCP text (JSON or plain)
    parseIncomingText?(text: string): ParsedResult | undefined;
    // Optional: TCP handshake payloads
    tcpInit?(): Buffer | undefined;
    tcpBye?(): Buffer | undefined;
}

let cached: SttVendorPlugin | null | undefined;

export function getVendorPlugin(modulePath: string | null | undefined, log: (msg: string) => void): SttVendorPlugin | null {
    if (modulePath === undefined) {
        return null;
    }
    if (cached !== undefined) {
        return (cached ?? null);
    }
    if (!modulePath) {
        cached = null;
        return null;
    }
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require(modulePath);
        const plugin: SttVendorPlugin = mod?.default ?? mod;
        if (!plugin || typeof plugin !== 'object') {
            log(`[stt-vendor] Invalid plugin export from ${modulePath}`);
            cached = null;
            return null;
        }
        cached = plugin;
        return plugin;
    } catch (e) {
        log(`[stt-vendor] Failed to load plugin ${modulePath}: ${(e as Error).message}`);
        cached = null;
        return null;
    }
}
