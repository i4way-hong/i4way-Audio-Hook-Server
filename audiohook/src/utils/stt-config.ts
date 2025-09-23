import { EventEmitter } from 'events';
import { readFileSync, existsSync, watch } from 'fs';
import { resolve } from 'path';
import dotenv from 'dotenv';

export type SttProtocol = 'websocket' | 'tcp' | 'grpc' | 'mrcp';
export type SttEncoding = 'L16' | 'PCMU';

export type TcpFraming = 'raw' | 'len32' | 'newline';
export type WsMode = 'binary' | 'json-base64';

export type SttConfigState = {
    enabled: boolean;
    protocol: SttProtocol | string; // 런타임 검증을 위해 string 허용
    endpoint: string; // ws(s)://... or host:port
    apiKey?: string | null;
    headers?: Record<string, string> | null;
    encoding: SttEncoding;
    rate: 8000 | 16000 | 44100 | 48000;
    mono: boolean;
    // WebSocket handshake/ping/bye
    wsInitJson?: string | null;
    wsPingSec?: number | null;
    wsByeJson?: string | null;
    wsMode?: WsMode | string;
    wsSubprotocol?: string | null;
    wsJsonAudioKey?: string | null;
    // TCP framing/handshake/bye
    tcpFraming?: TcpFraming | string;
    tcpInitHex?: string | null;
    tcpByeHex?: string | null;
    // TCP TLS
    tcpTlsEnabled?: boolean;
    tcpTlsRejectUnauthorized?: boolean;
    tcpTlsServername?: string | null;
    tcpTlsCaFile?: string | null;
    tcpTlsCertFile?: string | null;
    tcpTlsKeyFile?: string | null;
    // Resampling toggle
    resampleEnabled?: boolean;
    // Reconnect
    reconnectEnabled?: boolean;
    reconnectInitialMs?: number | null;
    reconnectMaxMs?: number | null;
    reconnectFactor?: number | null;
    // Vendor plugin
    vendorPlugin?: string | null;
    vendorParams?: string | null;
};

const DEFAULTS: SttConfigState = {
    enabled: false,
    protocol: 'websocket',
    endpoint: '',
    apiKey: null,
    headers: null,
    encoding: 'L16',
    rate: 8000,
    mono: true,
    wsInitJson: null,
    wsPingSec: null,
    wsByeJson: null,
    wsMode: 'binary',
    wsSubprotocol: null,
    wsJsonAudioKey: 'audio',
    tcpFraming: 'raw',
    tcpInitHex: null,
    tcpByeHex: null,
    tcpTlsEnabled: false,
    tcpTlsRejectUnauthorized: true,
    tcpTlsServername: null,
    tcpTlsCaFile: null,
    tcpTlsCertFile: null,
    tcpTlsKeyFile: null,
    resampleEnabled: false,
    reconnectEnabled: false,
    reconnectInitialMs: 500,
    reconnectMaxMs: 10000,
    reconnectFactor: 2.0,
    vendorPlugin: null,
    vendorParams: null,
};

function parseBoolean(val: string | undefined, defaultValue: boolean): boolean {
    if (val === undefined) {
        return defaultValue;
    }
    if (/^(1|true|yes|on)$/i.test(val)) {
        return true;
    }
    if (/^(0|false|no|off)$/i.test(val)) {
        return false;
    }
    return defaultValue;
}

function parseNumber(val: string | undefined): number | null {
    if (val === undefined || val === '') {
        return null;
    }
    const n = Number(val);
    return Number.isFinite(n) ? n : null;
}

function parseHeaders(val: string | undefined): Record<string, string> | null {
    if (!val) {
        return null;
    }
    try {
        const obj = JSON.parse(val);
        if (obj && typeof obj === 'object') {
            const out: Record<string, string> = {};
            for (const [k, v] of Object.entries(obj)) {
                if (typeof v === 'string') {
                    out[k] = v;
                }
            }
            return out;
        }
    } catch {
        // ignore
    }
    return null;
}

function parseTcpFraming(val: string | undefined): TcpFraming | undefined {
    if (!val) {
        return undefined;
    }
    if (val === 'raw' || val === 'len32' || val === 'newline') {
        return val;
    }
    return undefined;
}

function parseWsMode(val: string | undefined): WsMode | undefined {
    if (!val) {
        return undefined;
    }
    if (val === 'binary' || val === 'json-base64') {
        return val;
    }
    return undefined;
}

function loadFromEnvFile(envPath: string): Partial<SttConfigState> {
    try {
        if (!existsSync(envPath)) {
            return {};
        }
        const buf = readFileSync(envPath);
        const parsed = dotenv.parse(buf);
        const rateStr = parsed['STT_RATE'];
        const rate = rateStr ? (parseInt(rateStr, 10) as 8000 | 16000 | 44100 | 48000) : DEFAULTS.rate;
        return {
            enabled: parseBoolean(parsed['STT_ENABLED'], DEFAULTS.enabled),
            protocol: (parsed['STT_PROTOCOL'] as SttProtocol) ?? DEFAULTS.protocol,
            endpoint: parsed['STT_ENDPOINT'] ?? DEFAULTS.endpoint,
            apiKey: parsed['STT_API_KEY'] ?? null,
            headers: parseHeaders(parsed['STT_HEADERS']),
            encoding: (parsed['STT_ENCODING'] as SttEncoding) ?? DEFAULTS.encoding,
            rate,
            mono: parseBoolean(parsed['STT_MONO'], DEFAULTS.mono),
            wsInitJson: parsed['STT_WS_INIT_JSON'] ?? DEFAULTS.wsInitJson,
            wsPingSec: parseNumber(parsed['STT_WS_PING_SEC']) ?? DEFAULTS.wsPingSec,
            wsByeJson: parsed['STT_WS_BYE_JSON'] ?? DEFAULTS.wsByeJson,
            wsMode: parseWsMode(parsed['STT_WS_MODE']) ?? DEFAULTS.wsMode,
            wsSubprotocol: parsed['STT_WS_SUBPROTOCOL'] ?? DEFAULTS.wsSubprotocol,
            wsJsonAudioKey: parsed['STT_WS_JSON_AUDIO_KEY'] ?? DEFAULTS.wsJsonAudioKey,
            tcpFraming: parseTcpFraming(parsed['STT_TCP_FRAMING']) ?? DEFAULTS.tcpFraming,
            tcpInitHex: parsed['STT_TCP_INIT_HEX'] ?? DEFAULTS.tcpInitHex,
            tcpByeHex: parsed['STT_TCP_BYE_HEX'] ?? DEFAULTS.tcpByeHex,
            tcpTlsEnabled: parseBoolean(parsed['STT_TCP_TLS'], DEFAULTS.tcpTlsEnabled ?? false),
            tcpTlsRejectUnauthorized: parseBoolean(parsed['STT_TCP_TLS_REJECT_UNAUTHORIZED'], DEFAULTS.tcpTlsRejectUnauthorized ?? true),
            tcpTlsServername: parsed['STT_TCP_TLS_SERVERNAME'] ?? DEFAULTS.tcpTlsServername,
            tcpTlsCaFile: parsed['STT_TCP_TLS_CA_FILE'] ?? DEFAULTS.tcpTlsCaFile,
            tcpTlsCertFile: parsed['STT_TCP_TLS_CERT_FILE'] ?? DEFAULTS.tcpTlsCertFile,
            tcpTlsKeyFile: parsed['STT_TCP_TLS_KEY_FILE'] ?? DEFAULTS.tcpTlsKeyFile,
            resampleEnabled: parseBoolean(parsed['STT_RESAMPLE_ENABLED'], DEFAULTS.resampleEnabled ?? false),
            reconnectEnabled: parseBoolean(parsed['STT_RECONNECT_ENABLED'], DEFAULTS.reconnectEnabled ?? false),
            reconnectInitialMs: parseNumber(parsed['STT_RECONNECT_INITIAL_MS']) ?? DEFAULTS.reconnectInitialMs,
            reconnectMaxMs: parseNumber(parsed['STT_RECONNECT_MAX_MS']) ?? DEFAULTS.reconnectMaxMs,
            reconnectFactor: parseNumber(parsed['STT_RECONNECT_FACTOR']) ?? DEFAULTS.reconnectFactor,
            vendorPlugin: parsed['STT_VENDOR_PLUGIN'] ?? DEFAULTS.vendorPlugin,
            vendorParams: parsed['STT_VENDOR_PARAMS'] ?? DEFAULTS.vendorParams,
        };
    } catch {
        return {};
    }
}

function loadFromProcessEnv(): Partial<SttConfigState> {
    const res: Partial<SttConfigState> = {};
    if (process.env['STT_ENABLED'] !== undefined) {
        res.enabled = parseBoolean(process.env['STT_ENABLED'], DEFAULTS.enabled);
    }
    if (process.env['STT_PROTOCOL'] !== undefined) {
        res.protocol = process.env['STT_PROTOCOL'] as SttProtocol;
    }
    if (process.env['STT_ENDPOINT'] !== undefined) {
        res.endpoint = process.env['STT_ENDPOINT'] as string;
    }
    if (process.env['STT_API_KEY'] !== undefined) {
        res.apiKey = process.env['STT_API_KEY'] as string;
    }
    if (process.env['STT_HEADERS'] !== undefined) {
        res.headers = parseHeaders(process.env['STT_HEADERS']);
    }
    if (process.env['STT_ENCODING'] !== undefined) {
        res.encoding = process.env['STT_ENCODING'] as SttEncoding;
    }
    if (process.env['STT_RATE'] !== undefined) {
        const r = parseInt(process.env['STT_RATE'] as string, 10) as 8000 | 16000 | 44100 | 48000;
        res.rate = r;
    }
    if (process.env['STT_MONO'] !== undefined) {
        res.mono = parseBoolean(process.env['STT_MONO'], DEFAULTS.mono);
    }
    if (process.env['STT_WS_INIT_JSON'] !== undefined) {
        res.wsInitJson = process.env['STT_WS_INIT_JSON'] ?? null;
    }
    if (process.env['STT_WS_PING_SEC'] !== undefined) {
        res.wsPingSec = parseNumber(process.env['STT_WS_PING_SEC'] ?? undefined) ?? null;
    }
    if (process.env['STT_WS_BYE_JSON'] !== undefined) {
        res.wsByeJson = process.env['STT_WS_BYE_JSON'] ?? null;
    }
    if (process.env['STT_WS_MODE'] !== undefined) {
        res.wsMode = parseWsMode(process.env['STT_WS_MODE']);
    }
    if (process.env['STT_WS_SUBPROTOCOL'] !== undefined) {
        res.wsSubprotocol = process.env['STT_WS_SUBPROTOCOL'] ?? null;
    }
    if (process.env['STT_WS_JSON_AUDIO_KEY'] !== undefined) {
        res.wsJsonAudioKey = process.env['STT_WS_JSON_AUDIO_KEY'] ?? null;
    }
    if (process.env['STT_TCP_FRAMING'] !== undefined) {
        res.tcpFraming = parseTcpFraming(process.env['STT_TCP_FRAMING']);
    }
    if (process.env['STT_TCP_INIT_HEX'] !== undefined) {
        res.tcpInitHex = process.env['STT_TCP_INIT_HEX'] ?? null;
    }
    if (process.env['STT_TCP_BYE_HEX'] !== undefined) {
        res.tcpByeHex = process.env['STT_TCP_BYE_HEX'] ?? null;
    }
    if (process.env['STT_TCP_TLS'] !== undefined) {
        res.tcpTlsEnabled = parseBoolean(process.env['STT_TCP_TLS'], DEFAULTS.tcpTlsEnabled ?? false);
    }
    if (process.env['STT_TCP_TLS_REJECT_UNAUTHORIZED'] !== undefined) {
        res.tcpTlsRejectUnauthorized = parseBoolean(process.env['STT_TCP_TLS_REJECT_UNAUTHORIZED'], DEFAULTS.tcpTlsRejectUnauthorized ?? true);
    }
    if (process.env['STT_TCP_TLS_SERVERNAME'] !== undefined) {
        res.tcpTlsServername = process.env['STT_TCP_TLS_SERVERNAME'] ?? null;
    }
    if (process.env['STT_TCP_TLS_CA_FILE'] !== undefined) {
        res.tcpTlsCaFile = process.env['STT_TCP_TLS_CA_FILE'] ?? null;
    }
    if (process.env['STT_TCP_TLS_CERT_FILE'] !== undefined) {
        res.tcpTlsCertFile = process.env['STT_TCP_TLS_CERT_FILE'] ?? null;
    }
    if (process.env['STT_TCP_TLS_KEY_FILE'] !== undefined) {
        res.tcpTlsKeyFile = process.env['STT_TCP_TLS_KEY_FILE'] ?? null;
    }
    if (process.env['STT_RESAMPLE_ENABLED'] !== undefined) {
        res.resampleEnabled = parseBoolean(process.env['STT_RESAMPLE_ENABLED'], DEFAULTS.resampleEnabled ?? false);
    }
    if (process.env['STT_RECONNECT_ENABLED'] !== undefined) {
        res.reconnectEnabled = parseBoolean(process.env['STT_RECONNECT_ENABLED'], DEFAULTS.reconnectEnabled ?? false);
    }
    if (process.env['STT_RECONNECT_INITIAL_MS'] !== undefined) {
        res.reconnectInitialMs = parseNumber(process.env['STT_RECONNECT_INITIAL_MS'] ?? undefined) ?? null;
    }
    if (process.env['STT_RECONNECT_MAX_MS'] !== undefined) {
        res.reconnectMaxMs = parseNumber(process.env['STT_RECONNECT_MAX_MS'] ?? undefined) ?? null;
    }
    if (process.env['STT_RECONNECT_FACTOR'] !== undefined) {
        res.reconnectFactor = parseNumber(process.env['STT_RECONNECT_FACTOR'] ?? undefined) ?? null;
    }
    if (process.env['STT_VENDOR_PLUGIN'] !== undefined) {
        res.vendorPlugin = process.env['STT_VENDOR_PLUGIN'] ?? null;
    }
    if (process.env['STT_VENDOR_PARAMS'] !== undefined) {
        res.vendorParams = process.env['STT_VENDOR_PARAMS'] ?? null;
    }
    return res;
}

// 설정 검증 및 정규화
function isValidProtocol(p: unknown): p is SttProtocol {
    return p === 'websocket' || p === 'tcp' || p === 'grpc' || p === 'mrcp';
}
function sanitizeHex(val: string | null | undefined): string | null {
    if (!val) {
        return null;
    }
    const cleaned = val.replace(/[^0-9a-fA-F]/g, '');
    if (cleaned.length === 0 || (cleaned.length % 2) !== 0) {
        console.warn(`[stt-config] Invalid hex string, ignoring (len=${cleaned.length}, even=${(cleaned.length % 2) === 0})`);
        return null;
    }
    return cleaned.toLowerCase();
}
function validateAndNormalize(input: SttConfigState): SttConfigState {
    const out: SttConfigState = { ...input };
    if (!isValidProtocol(out.protocol)) {
        console.warn(`[stt-config] Invalid protocol: ${String(out.protocol)}. Falling back to websocket.`);
        out.protocol = 'websocket';
    }
    if (out.wsPingSec !== null && out.wsPingSec !== undefined) {
        if (!Number.isFinite(out.wsPingSec) || out.wsPingSec <= 0) {
            console.warn(`[stt-config] Non-positive or NaN WS ping seconds(${String(out.wsPingSec)}); disabling ping`);
            out.wsPingSec = null;
        }
    }
    // ws mode
    if (out.wsMode !== undefined && out.wsMode !== 'binary' && out.wsMode !== 'json-base64') {
        console.warn(`[stt-config] Unknown WS mode: ${String(out.wsMode)}. Using binary.`);
        out.wsMode = 'binary';
    }
    // tcp framing
    if (out.tcpFraming !== undefined && out.tcpFraming !== 'raw' && out.tcpFraming !== 'len32' && out.tcpFraming !== 'newline') {
        console.warn(`[stt-config] Unknown TCP framing: ${String(out.tcpFraming)}. Using raw.`);
        out.tcpFraming = 'raw';
    }
    // hex payloads
    out.tcpInitHex = sanitizeHex(out.tcpInitHex);
    out.tcpByeHex = sanitizeHex(out.tcpByeHex);
    // reconnect bounds
    if (out.reconnectInitialMs && out.reconnectInitialMs < 10) {
        out.reconnectInitialMs = 10;
    }
    if (out.reconnectMaxMs && out.reconnectMaxMs < (out.reconnectInitialMs ?? 10)) {
        out.reconnectMaxMs = out.reconnectInitialMs;
    }
    return out;
}

class SttConfig extends EventEmitter {
    private envPath: string;
    private state: SttConfigState;
    private stopWatch: (() => void) | null = null;

    constructor(envPath?: string) {
        super();
        this.envPath = envPath ?? resolve(process.cwd(), '.env');
        const loaded = { ...DEFAULTS, ...loadFromEnvFile(this.envPath), ...loadFromProcessEnv() } as SttConfigState;
        this.state = validateAndNormalize(loaded);
        this.startWatching();
    }

    private startWatching(): void {
        // In test environments, avoid creating fs.watch to prevent open handle leaks in Jest.
        if (process.env['JEST_WORKER_ID'] !== undefined || process.env['NODE_ENV'] === 'test') {
            this.stopWatch = null;
            return;
        }
        try {
            const watcher = watch(this.envPath, { persistent: true }, () => this.reload());
            this.stopWatch = () => watcher.close();
        } catch {
            this.stopWatch = null;
        }
    }

    private reload(): void {
        const prev = { ...this.state } as SttConfigState;
        const fromFile = loadFromEnvFile(this.envPath);
        const fromProc = loadFromProcessEnv();
        const merged: SttConfigState = {
            enabled: (fromFile.enabled ?? fromProc.enabled ?? prev.enabled) as boolean,
            protocol: (fromFile.protocol ?? fromProc.protocol ?? prev.protocol) as SttProtocol,
            endpoint: (fromFile.endpoint ?? fromProc.endpoint ?? prev.endpoint) as string,
            apiKey: (fromFile.apiKey ?? fromProc.apiKey ?? prev.apiKey) as string | null,
            headers: (fromFile.headers ?? fromProc.headers ?? prev.headers) as Record<string, string> | null,
            encoding: (fromFile.encoding ?? fromProc.encoding ?? prev.encoding) as SttEncoding,
            rate: (fromFile.rate ?? fromProc.rate ?? prev.rate) as 8000 | 16000 | 44100 | 48000,
            mono: (fromFile.mono ?? fromProc.mono ?? prev.mono) as boolean,
            wsInitJson: (fromFile.wsInitJson ?? fromProc.wsInitJson ?? prev.wsInitJson) as string | null,
            wsPingSec: (fromFile.wsPingSec ?? fromProc.wsPingSec ?? prev.wsPingSec) as number | null,
            wsByeJson: (fromFile.wsByeJson ?? fromProc.wsByeJson ?? prev.wsByeJson) as string | null,
            wsMode: (fromFile.wsMode ?? fromProc.wsMode ?? prev.wsMode) as WsMode,
            wsSubprotocol: (fromFile.wsSubprotocol ?? fromProc.wsSubprotocol ?? prev.wsSubprotocol) as string | null,
            wsJsonAudioKey: (fromFile.wsJsonAudioKey ?? fromProc.wsJsonAudioKey ?? prev.wsJsonAudioKey) as string | null,
            tcpFraming: (fromFile.tcpFraming ?? fromProc.tcpFraming ?? prev.tcpFraming) as TcpFraming,
            tcpInitHex: (fromFile.tcpInitHex ?? fromProc.tcpInitHex ?? prev.tcpInitHex) as string | null,
            tcpByeHex: (fromFile.tcpByeHex ?? fromProc.tcpByeHex ?? prev.tcpByeHex) as string | null,
            tcpTlsEnabled: (fromFile.tcpTlsEnabled ?? fromProc.tcpTlsEnabled ?? prev.tcpTlsEnabled) as boolean,
            tcpTlsRejectUnauthorized: (fromFile.tcpTlsRejectUnauthorized ?? fromProc.tcpTlsRejectUnauthorized ?? prev.tcpTlsRejectUnauthorized) as boolean,
            tcpTlsServername: (fromFile.tcpTlsServername ?? fromProc.tcpTlsServername ?? prev.tcpTlsServername) as string | null,
            tcpTlsCaFile: (fromFile.tcpTlsCaFile ?? fromProc.tcpTlsCaFile ?? prev.tcpTlsCaFile) as string | null,
            tcpTlsCertFile: (fromFile.tcpTlsCertFile ?? fromProc.tcpTlsCertFile ?? prev.tcpTlsCertFile) as string | null,
            tcpTlsKeyFile: (fromFile.tcpTlsKeyFile ?? fromProc.tcpTlsKeyFile ?? prev.tcpTlsKeyFile) as string | null,
            resampleEnabled: (fromFile.resampleEnabled ?? fromProc.resampleEnabled ?? prev.resampleEnabled) as boolean,
            reconnectEnabled: (fromFile.reconnectEnabled ?? fromProc.reconnectEnabled ?? prev.reconnectEnabled) as boolean,
            reconnectInitialMs: (fromFile.reconnectInitialMs ?? fromProc.reconnectInitialMs ?? prev.reconnectInitialMs) as number | null,
            reconnectMaxMs: (fromFile.reconnectMaxMs ?? fromProc.reconnectMaxMs ?? prev.reconnectMaxMs) as number | null,
            reconnectFactor: (fromFile.reconnectFactor ?? fromProc.reconnectFactor ?? prev.reconnectFactor) as number | null,
            vendorPlugin: (fromFile.vendorPlugin ?? fromProc.vendorPlugin ?? prev.vendorPlugin) as string | null,
            vendorParams: (fromFile.vendorParams ?? fromProc.vendorParams ?? prev.vendorParams) as string | null,
        };
        const next = validateAndNormalize(merged);
        if (
            next.enabled !== prev.enabled ||
            next.protocol !== prev.protocol ||
            next.endpoint !== prev.endpoint ||
            next.apiKey !== prev.apiKey ||
            JSON.stringify(next.headers) !== JSON.stringify(prev.headers) ||
            next.encoding !== prev.encoding ||
            next.rate !== prev.rate ||
            next.mono !== prev.mono ||
            next.wsInitJson !== prev.wsInitJson ||
            next.wsPingSec !== prev.wsPingSec ||
            next.wsByeJson !== prev.wsByeJson ||
            next.wsMode !== prev.wsMode ||
            next.wsSubprotocol !== prev.wsSubprotocol ||
            next.wsJsonAudioKey !== prev.wsJsonAudioKey ||
            next.tcpFraming !== prev.tcpFraming ||
            next.tcpInitHex !== prev.tcpInitHex ||
            next.tcpByeHex !== prev.tcpByeHex ||
            next.tcpTlsEnabled !== prev.tcpTlsEnabled ||
            next.tcpTlsRejectUnauthorized !== prev.tcpTlsRejectUnauthorized ||
            next.tcpTlsServername !== prev.tcpTlsServername ||
            next.tcpTlsCaFile !== prev.tcpTlsCaFile ||
            next.tcpTlsCertFile !== prev.tcpTlsCertFile ||
            next.tcpTlsKeyFile !== prev.tcpTlsKeyFile ||
            next.resampleEnabled !== prev.resampleEnabled ||
            next.reconnectEnabled !== prev.reconnectEnabled ||
            next.reconnectInitialMs !== prev.reconnectInitialMs ||
            next.reconnectMaxMs !== prev.reconnectMaxMs ||
            next.reconnectFactor !== prev.reconnectFactor ||
            next.vendorPlugin !== prev.vendorPlugin ||
            next.vendorParams !== prev.vendorParams
        ) {
            this.state = next;
            this.emit('update', next, prev);
        }
    }

    onUpdate(listener: (next: SttConfigState, prev: SttConfigState) => void): () => void {
        this.on('update', listener);
        return () => this.off('update', listener);
    }

    get enabled(): boolean {
        return this.state.enabled;
    }
    get protocol(): SttProtocol {
        return (isValidProtocol(this.state.protocol) ? this.state.protocol : 'websocket');
    }
    get endpoint(): string {
        return this.state.endpoint;
    }
    get apiKey(): string | null | undefined {
        return this.state.apiKey;
    }
    get headers(): Record<string, string> | null | undefined {
        return this.state.headers;
    }
    get encoding(): SttEncoding {
        return this.state.encoding;
    }
    get rate(): 8000 | 16000 | 44100 | 48000 {
        return this.state.rate;
    }
    get mono(): boolean {
        return this.state.mono;
    }
    get wsInitJson(): string | null | undefined {
        return this.state.wsInitJson;
    }
    get wsPingSec(): number | null | undefined {
        return this.state.wsPingSec;
    }
    get wsByeJson(): string | null | undefined {
        return this.state.wsByeJson;
    }
    get wsMode(): WsMode {
        return (this.state.wsMode === 'json-base64') ? 'json-base64' : 'binary';
    }
    get wsSubprotocol(): string | null | undefined {
        return this.state.wsSubprotocol ?? null;
    }
    get wsJsonAudioKey(): string {
        return (this.state.wsJsonAudioKey ?? 'audio');
    }
    get tcpFraming(): TcpFraming | undefined {
        return (this.state.tcpFraming === 'raw' || this.state.tcpFraming === 'len32' || this.state.tcpFraming === 'newline') ? this.state.tcpFraming : 'raw';
    }
    get tcpInitHex(): string | null | undefined {
        return this.state.tcpInitHex;
    }
    get tcpByeHex(): string | null | undefined {
        return this.state.tcpByeHex;
    }
    get tcpTlsEnabled(): boolean | undefined {
        return this.state.tcpTlsEnabled;
    }
    get tcpTlsRejectUnauthorized(): boolean | undefined {
        return this.state.tcpTlsRejectUnauthorized;
    }
    get tcpTlsServername(): string | null | undefined {
        return this.state.tcpTlsServername;
    }
    get tcpTlsCaFile(): string | null | undefined {
        return this.state.tcpTlsCaFile;
    }
    get tcpTlsCertFile(): string | null | undefined {
        return this.state.tcpTlsCertFile;
    }
    get tcpTlsKeyFile(): string | null | undefined {
        return this.state.tcpTlsKeyFile;
    }
    get resampleEnabled(): boolean | undefined {
        return this.state.resampleEnabled;
    }
    get reconnectEnabled(): boolean | undefined {
        return this.state.reconnectEnabled;
    }
    get reconnectInitialMs(): number | null | undefined {
        return this.state.reconnectInitialMs;
    }
    get reconnectMaxMs(): number | null | undefined {
        return this.state.reconnectMaxMs;
    }
    get reconnectFactor(): number | null | undefined {
        return this.state.reconnectFactor;
    }
    get vendorPlugin(): string | null | undefined {
        return this.state.vendorPlugin;
    }
    get vendorParams(): string | null | undefined {
        return this.state.vendorParams;
    }

    // 테스트 및 런타임 오버라이드 지원: 부분 설정을 적용하고 update 이벤트를 발생시킵니다.
    // 반환된 함수를 호출하면 이전 상태로 복구합니다.
    applyOverrides(partial: Partial<SttConfigState>): () => void {
        const prev = { ...this.state } as SttConfigState;
        const merged = { ...this.state, ...partial } as SttConfigState;
        const next = validateAndNormalize(merged);
        this.state = next;
        this.emit('update', next, prev);
        return () => {
            const cur = { ...this.state } as SttConfigState;
            this.state = prev;
            this.emit('update', this.state, cur as SttConfigState);
        };
    }
}

const sttConfig = new SttConfig();
export default sttConfig;
// SttConfigState is already exported as a type declaration above; no re-export needed.
