import WebSocket from 'ws';
import sttConfig, { SttProtocol, SttEncoding, TcpFraming, WsMode } from '../utils/stt-config';
import { Logger } from '../utils/logger';
import { MediaDataFrame } from './mediadata';
import { ulawFromL16 } from '../audio/ulaw';
import { Socket } from 'net';
import tls from 'tls';
import { resampleL16 } from '../audio/resample';
import { createAudioFrame } from '../audio';
import { TextDecoder } from 'util';
import { readFileSync } from 'fs';
import { getVendorPlugin, SttVendorPlugin } from './stt-vendor-plugin';
import { createMrcpBridge, MrcpSttForwarder } from './stt-forwarder-mrcp';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import path from 'path';

export interface SttForwarder {
    start(): Promise<void>;
    stop(): Promise<void>;
    send(frame: MediaDataFrame): void;
}

class NoopForwarder implements SttForwarder {
    async start() { /* noop */ }
    async stop() { /* noop */ }
    send() { /* noop */ }
}

// 공백 유지(과거 구현 주석): 간단 L16 리샘플(선형보간) — 모노/스테레오 지원
// function resampleL16Linear(src: Int16Array, inRate: number, outRate: number, channels: number): Int16Array {
//     // deprecated: moved to audio/resample.ts
// }

// 공통 페이로드 생성: 프레임을 sttConfig에 맞춰 인코딩/채널 선택 후 Buffer로 반환
function buildPayload(frame: MediaDataFrame, logger: Logger, warned: { rate: boolean }): Buffer | null {
    let working: MediaDataFrame = frame;
    // 리샘플링: 설정 활성화이고 레이트 불일치 시 수행 (L16만 지원)
    if (sttConfig.resampleEnabled && frame.rate !== sttConfig.rate && working.format === 'L16') {
        const chs = working.channels.length;
        const l16 = working.audio.data as Int16Array;
        const res = resampleL16(l16, working.rate, sttConfig.rate, chs);
        // 리샘플 결과로 올바른 AudioFrame 생성 (메서드/게터 유지)
        working = createAudioFrame(res, {
            format: 'L16',
            rate: sttConfig.rate as typeof frame.rate,
            channels: working.channels,
        }) as unknown as MediaDataFrame;
    } else if (!warned.rate && sttConfig.rate !== frame.rate) {
        warned.rate = true;
        logger.warn(`STT: frame rate(${frame.rate}) != configured rate(${sttConfig.rate}). Resampling is ${sttConfig.resampleEnabled ? 'enabled but source not L16' : 'disabled'}; forwarding as-is.`);
    }

    const targetEnc: SttEncoding = sttConfig.encoding;
    const mono = sttConfig.mono;
    const sourceView = mono ? working.getChannelView(working.channels[0], working.format) : working.audio;

    if (targetEnc === 'PCMU') {
        if (sourceView.format === 'PCMU') {
            return Buffer.from(sourceView.data.buffer, sourceView.data.byteOffset, sourceView.data.byteLength);
        } else {
            const encoded = ulawFromL16(sourceView.data);
            return Buffer.from(encoded.buffer, encoded.byteOffset, encoded.byteLength);
        }
    } else {
        if (sourceView.format === 'L16') {
            return Buffer.from(sourceView.data.buffer, sourceView.data.byteOffset, sourceView.data.byteLength);
        } else {
            const l16Frame = working.as('L16');
            const view = mono ? l16Frame.getChannelView(working.channels[0], 'L16') : l16Frame.audio;
            const data = view.data;
            return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        }
    }
}

class WebSocketForwarder implements SttForwarder {
    private ws: WebSocket | null = null;
    private pingTimer: NodeJS.Timer | null = null;
    private readonly logger: Logger;
    private warnedRateMismatch = false;
    private vendor: SttVendorPlugin | null = null;
    private wsReconnectTimer: NodeJS.Timeout | null = null;
    private wsReconnectDelayMs: number | null = null;

    constructor(logger: Logger) {
        this.logger = logger;
        this.vendor = getVendorPlugin(sttConfig.vendorPlugin ?? null, (m) => this.logger.debug(m));
        const init = sttConfig.reconnectInitialMs ?? 500;
        this.wsReconnectDelayMs = Math.max(10, init);
    }

    private schedulePing(): void {
        const sec = sttConfig.wsPingSec;
        if (!sec || sec <= 0) {
            return;
        }
        const timer = setInterval(() => {
            try {
                this.ws?.ping();
            } catch {
                // ignore
            }
        }, sec * 1000);
        // Avoid keeping the process alive if tests forget to stop
        (timer as unknown as { unref?: () => void }).unref?.();
        this.pingTimer = timer as unknown as NodeJS.Timer;
    }

    private maybeSendInit(): void {
        let payload = this.vendor?.wsInit?.();
        if (payload === undefined || payload === null) {
            payload = sttConfig.wsInitJson ?? undefined;
        }
        if (!payload) {
            return;
        }
        try {
            this.ws?.send(payload);
            this.logger.debug('STT WS init sent');
        } catch (e) {
            this.logger.warn(`STT WS init send failed: ${(e as Error).message}`);
        }
    }

    private sendBye(): void {
        let payload = this.vendor?.wsBye?.();
        if (payload === undefined || payload === null) {
            payload = sttConfig.wsByeJson ?? undefined;
        }
        if (!payload) {
            return;
        }
        try {
            this.ws?.send(payload);
            this.logger.debug('STT WS bye sent');
        } catch {
            // ignore
        }
    }

    private resetWsBackoff(): void {
        this.wsReconnectDelayMs = sttConfig.reconnectInitialMs ?? 500;
    }

    private scheduleWsReconnect(): void {
        if (!sttConfig.reconnectEnabled) {
            return;
        }
        const max = sttConfig.reconnectMaxMs ?? 10000;
        const factor = sttConfig.reconnectFactor ?? 2.0;
        const delay = Math.min(Math.max(10, this.wsReconnectDelayMs ?? 500), max);
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
        }
        this.logger.warn(`STT WS reconnect in ${delay} ms`);
        this.wsReconnectTimer = setTimeout(() => {
            this.start().catch(() => undefined);
        }, delay);
        this.wsReconnectDelayMs = Math.min(max, Math.floor(delay * factor));
    }

    async start(): Promise<void> {
        const url = sttConfig.endpoint;
        if (!url) {
            throw new Error('STT endpoint is not configured');
        }
        await new Promise<void>((resolve, reject) => {
            // ws 라이브러리는 subprotocol 자리에 undefined가 들어오면 SyntaxError 가능하므로 인자 수를 조정
            const headers = {
                ...(sttConfig.apiKey ? { Authorization: `Bearer ${sttConfig.apiKey}` } : {}),
                ...(sttConfig.headers ?? {}),
            } as Record<string, string>;
            const subp = sttConfig.wsSubprotocol;
            let ws: WebSocket;
            if (subp && subp.trim().length > 0) {
                ws = new WebSocket(url, subp, { headers });
            } else {
                ws = new WebSocket(url, { headers });
            }
            ws.on('open', () => {
                this.logger.info(`STT WS connected: ${url}`);
                this.ws = ws;
                this.resetWsBackoff();
                this.maybeSendInit();
                this.schedulePing();
                resolve();
            });
            ws.on('message', (data, isBinary) => {
                try {
                    if (isBinary && sttConfig.wsMode === 'binary') {
                        const len = Buffer.isBuffer(data)
                            ? data.length
                            : Array.isArray(data)
                                ? (Buffer.concat(data as unknown as Uint8Array[]).length)
                                : (data as ArrayBuffer).byteLength;
                        this.logger.debug(`STT WS recv binary (${len} bytes)`);
                    } else {
                        const decoder = new TextDecoder('utf-8');
                        let text: string;
                        if (typeof data === 'string') {
                            text = data;
                        } else if (Buffer.isBuffer(data)) {
                            text = decoder.decode(new Uint8Array(data));
                        } else if (Array.isArray(data)) {
                            const merged = Buffer.concat(data as unknown as Uint8Array[]);
                            text = decoder.decode(new Uint8Array(merged));
                        } else {
                            text = decoder.decode(new Uint8Array(data as ArrayBuffer));
                        }
                        const parsed = this.vendor?.parseIncomingText?.(text);
                        if (parsed?.text) {
                            this.logger.info(`STT WS parsed text: ${parsed.text}`);
                        }
                        const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
                        const asciiOnly = process.env['STT_WS_LOG_ASCII'] === '1';
                        const safe = asciiOnly ? preview.replace(/[^\x20-\x7E]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) : preview;
                        this.logger.info(`STT WS recv text: ${safe}`);
                    }
                } catch {
                    // ignore parse/log errors
                }
            });
            ws.on('error', (err) => {
                reject(err);
            });
            ws.on('close', () => {
                this.logger.warn('STT WS closed');
                this.ws = null;
                if (this.pingTimer) {
                    clearInterval(this.pingTimer);
                    this.pingTimer = null;
                }
                this.scheduleWsReconnect();
            });
        });
    }

    async stop(): Promise<void> {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
        if (this.wsReconnectTimer) {
            clearTimeout(this.wsReconnectTimer);
            this.wsReconnectTimer = null;
        }
        this.sendBye();
        const ws = this.ws;
        if (ws) {
            try {
                ws.close();
            } catch {
                // ignore
            }
            this.ws = null;
        }
    }

    send(frame: MediaDataFrame): void {
        const ws = this.ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) {
            return;
        }
        const payload = buildPayload(frame, this.logger, { rate: this.warnedRateMismatch });
        this.warnedRateMismatch = true; // 경고는 1회만
        if (!payload) {
            return;
        }
        // Vendor transform first
        const mode: WsMode | undefined = sttConfig.wsMode as WsMode;
        const audioKey = sttConfig.wsJsonAudioKey ?? 'audio';
        const transformed = this.vendor?.transformOutgoingWs?.(payload, (mode ?? 'binary'), {
            encoding: sttConfig.encoding,
            rate: sttConfig.rate,
            mono: sttConfig.mono,
            audioKey,
        });
        if (typeof transformed === 'string' || Buffer.isBuffer(transformed)) {
            ws.send(transformed as string | Buffer);
            return;
        }
        if (mode === 'json-base64') {
            const obj = { [audioKey]: payload.toString('base64') } as Record<string, unknown>;
            ws.send(JSON.stringify(obj));
        } else {
            ws.send(payload);
        }
    }
}

function hexToBuffer(hex: string): Buffer {
    const clean = hex.replace(/[^0-9a-fA-F]/g, '');
    return Buffer.from(clean, 'hex');
}

class TcpForwarder implements SttForwarder {
    private socket: Socket | null = null;
    private readonly logger: Logger;
    private warnedRateMismatch = false;
    private writeQueue: Buffer[] = [];
    private waitingDrain = false;
    private endedByPeer = false;
    private inboundBuffer: Buffer = Buffer.alloc(0);
    private reconnectTimer: NodeJS.Timeout | null = null;
    private reconnectDelayMs: number | null = null;
    private vendor: SttVendorPlugin | null = null;

    constructor(logger: Logger) {
        this.logger = logger;
        this.vendor = getVendorPlugin(sttConfig.vendorPlugin ?? null, (m) => this.logger.debug(m));
        this.reconnectDelayMs = Math.max(10, sttConfig.reconnectInitialMs ?? 500);
    }

    // 수신 텍스트 미리보기 로그
    private logTcpTextPreview(buf: Buffer) {
        try {
            const decoder = new TextDecoder('utf-8');
            const text = decoder.decode(new Uint8Array(buf));
            const preview = text.length > 200 ? `${text.slice(0, 200)}…` : text;
            const asciiOnly = process.env['STT_WS_LOG_ASCII'] === '1';
            const safe = asciiOnly ? preview.replace(/[^\x20-\x7E]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`) : preview;
            this.logger.info(`STT TCP recv text: ${safe}`);
        } catch {
            this.logger.debug(`STT TCP recv ${buf.length} bytes (decode failed)`);
        }
    }

    private parseEndpoint(ep: string): { host: string; port: number } {
        try {
            if (/^tcp:\/\//i.test(ep)) {
                const u = new URL(ep);
                const port = parseInt(u.port, 10);
                return { host: u.hostname, port };
            }
        } catch {
            // fallthrough to host:port parsing
        }
        const m = ep.match(/^\[([^\]]+)]:(\d+)$/); // [ipv6]:port
        if (m) {
            return { host: m[1], port: parseInt(m[2], 10) };
        }
        const i = ep.lastIndexOf(':');
        if (i > 0) {
            const host = ep.substring(0, i);
            const port = parseInt(ep.substring(i + 1), 10);
            return { host, port };
        }
        throw new Error(`Invalid TCP endpoint: ${ep}`);
    }

    private frameBuffer(buf: Buffer): Buffer {
        const mode: TcpFraming | undefined = sttConfig.tcpFraming;
        switch (mode) {
            case 'len32': {
                const h = Buffer.allocUnsafe(4);
                h.writeUInt32BE(buf.length, 0);
                return Buffer.concat([h, buf] as unknown as Uint8Array[]);
            }
            case 'newline': {
                return Buffer.concat([buf, Buffer.from('\n')] as unknown as Uint8Array[]);
            }
            case 'raw':
            default:
                return buf;
        }
    }

    private resetTcpBackoff(): void {
        this.reconnectDelayMs = sttConfig.reconnectInitialMs ?? 500;
    }

    private scheduleTcpReconnect(): void {
        if (!sttConfig.reconnectEnabled) {
            return;
        }
        const max = sttConfig.reconnectMaxMs ?? 10000;
        const factor = sttConfig.reconnectFactor ?? 2.0;
        const delay = Math.min(Math.max(10, this.reconnectDelayMs ?? 500), max);
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
        }
        this.logger.warn(`STT TCP reconnect in ${delay} ms`);
        this.reconnectTimer = setTimeout(() => this.start().catch(() => undefined), delay);
        this.reconnectDelayMs = Math.min(max, Math.floor(delay * factor));
    }

    async start(): Promise<void> {
        const ep = sttConfig.endpoint;
        if (!ep) {
            throw new Error('STT endpoint is not configured');
        }
        const { host, port } = this.parseEndpoint(ep);
        await new Promise<void>((resolve, reject) => {
            const useTls = !!sttConfig.tcpTlsEnabled;
            const sock: Socket = useTls ? tls.connect({
                host,
                port,
                servername: sttConfig.tcpTlsServername ?? host,
                rejectUnauthorized: sttConfig.tcpTlsRejectUnauthorized !== false,
                ca: sttConfig.tcpTlsCaFile ? [readFileSync(sttConfig.tcpTlsCaFile)] : undefined,
                cert: sttConfig.tcpTlsCertFile ? readFileSync(sttConfig.tcpTlsCertFile) : undefined,
                key: sttConfig.tcpTlsKeyFile ? readFileSync(sttConfig.tcpTlsKeyFile) : undefined,
            }) as unknown as Socket : new Socket();
            sock.setNoDelay(true);
            sock.setKeepAlive(true, 15000);
            const onDrain = () => {
                if (!this.socket || this.waitingDrain === false) {
                    return;
                }
                while (this.writeQueue.length > 0) {
                    const chunk = this.writeQueue.shift();
                    if (!chunk) {
                        break;
                    }
                    const ok = this.socket.write(chunk as unknown as Uint8Array);
                    if (!ok) {
                        // still backpressured; wait for next drain
                        this.waitingDrain = true;
                        return;
                    }
                }
                this.waitingDrain = false;
            };
            sock.once('connect', () => {
                this.logger.info(`STT ${useTls ? 'TLS ' : ''}TCP connected: ${host}:${port}`);
                this.socket = sock;
                this.resetTcpBackoff();
                this.waitingDrain = false;
                this.endedByPeer = false;
                this.writeQueue = [];
                this.inboundBuffer = Buffer.alloc(0);
                sock.on('drain', onDrain);
                sock.once('end', () => {
                    this.logger.warn('STT TCP peer half-closed (FIN received)');
                    this.endedByPeer = true;
                });
                sock.on('data', (buf: Buffer) => {
                    // 누적 버퍼에 추가 후 프레이밍에 맞춰 파싱
                    const mode: TcpFraming | undefined = sttConfig.tcpFraming;
                    if (mode === 'len32') {
                        this.inboundBuffer = Buffer.concat([this.inboundBuffer, buf] as unknown as Uint8Array[]);
                        while (this.inboundBuffer.length >= 4) {
                            const len = this.inboundBuffer.readUInt32BE(0);
                            if (this.inboundBuffer.length < 4 + len) {
                                break;
                            }
                            const frame = this.inboundBuffer.subarray(4, 4 + len);
                            this.inboundBuffer = this.inboundBuffer.subarray(4 + len);
                            this.logTcpTextPreview(frame);
                        }
                    } else if (mode === 'newline') {
                        this.inboundBuffer = Buffer.concat([this.inboundBuffer, buf] as unknown as Uint8Array[]);
                        let idx: number;
                        while ((idx = this.inboundBuffer.indexOf(0x0A)) !== -1) { // \n
                            let line = this.inboundBuffer.subarray(0, idx);
                            // CRLF 처리: 끝이 \r이면 제거
                            if (line.length > 0 && line[line.length - 1] === 0x0D) {
                                line = line.subarray(0, line.length - 1);
                            }
                            this.logTcpTextPreview(line);
                            this.inboundBuffer = this.inboundBuffer.subarray(idx + 1);
                        }
                    } else {
                        // raw 모드: 청크 단위로 미리보기 출력
                        this.logTcpTextPreview(buf);
                    }
                });
                // INIT
                if (sttConfig.tcpInitHex) {
                    try {
                        sock.write(hexToBuffer(sttConfig.tcpInitHex) as unknown as Uint8Array);
                    } catch {
                        // ignore
                    }
                } else if (this.vendor?.tcpInit) {
                    const init = this.vendor.tcpInit();
                    if (init) {
                        try {
                            sock.write(init as unknown as Uint8Array);
                        } catch {
                            // ignore
                        }
                    }
                }
                resolve();
            });
            sock.once('error', (err) => {
                reject(err);
            });
            sock.on('close', () => {
                this.logger.warn('STT TCP closed');
                this.socket = null;
                this.waitingDrain = false;
                this.writeQueue = [];
                this.inboundBuffer = Buffer.alloc(0);
                this.scheduleTcpReconnect();
            });
            if (!useTls) {
                sock.connect(port, host);
            }
        });
    }

    async stop(): Promise<void> {
        const s = this.socket;
        if (s) {
            // BYE
            if (sttConfig.tcpByeHex) {
                try {
                    s.write(hexToBuffer(sttConfig.tcpByeHex) as unknown as Uint8Array);
                } catch {
                    // ignore
                }
            } else if (this.vendor?.tcpBye) {
                const bye = this.vendor.tcpBye();
                if (bye) {
                    try {
                        s.write(bye as unknown as Uint8Array);
                    } catch {
                        // ignore
                    }
                }
            }
            try {
                s.end();
            } catch {
                // ignore
            }
            try {
                s.destroy();
            } catch {
                // ignore
            }
            this.socket = null;
        }
        this.waitingDrain = false;
        this.writeQueue = [];
        this.endedByPeer = false;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }

    send(frame: MediaDataFrame): void {
        const s = this.socket;
        if (!s || !s.writable || this.endedByPeer) {
            return;
        }
        const payload = buildPayload(frame, this.logger, { rate: this.warnedRateMismatch });
        this.warnedRateMismatch = true; // 경고는 1회만
        if (payload) {
            const framed = this.frameBuffer(payload);
            if (this.waitingDrain || this.writeQueue.length > 0) {
                this.writeQueue.push(framed);
                return;
            }
            const ok = s.write(framed as unknown as Uint8Array);
            if (!ok) {
                this.logger.debug('STT TCP backpressure: socket buffer is full');
                this.waitingDrain = true;
            }
        }
    }
}

// gRPC 포워더 구현: proto/speech_transcription.proto 의 StreamingRecognize 호출
class GrpcForwarder implements SttForwarder {
    private readonly logger: Logger;
    private started = false;
    private client: any; // eslint-disable-line @typescript-eslint/no-explicit-any
    private stream: grpc.ClientDuplexStream<any, any> | null = null; // eslint-disable-line @typescript-eslint/no-explicit-any
    private sequence = 0;
    private initSent = false;
    private reconnecting = false;
    private reconnectAttempt = 0;
    private partialBuffer: string = '';

    constructor(logger: Logger) {
        this.logger = logger;
    }

    private buildClient() {
        if (this.client) return;
        const endpoint = sttConfig.endpoint; // host:port 혹은 dns:port 예상
        if (!endpoint) throw new Error('STT gRPC endpoint not configured (STT_ENDPOINT)');
        // proto 로딩 (캐싱 단순화)
        const def = protoLoader.loadSync(path.resolve(process.cwd(), 'proto', 'speech_transcription.proto'), {
            longs: String,
            enums: String,
            defaults: true,
            oneofs: true,
        });
        const pkg = grpc.loadPackageDefinition(def) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        const Svc = pkg.audiohook.stt.v1.SpeechTranscription;
        // TLS 여부 결정: STT_GRPC_TLS_ENABLED=true 이고 @grpc/grpc-js createSsl 활용
        const tlsEnabled = process.env['STT_GRPC_TLS_ENABLED'] ? /^(1|true|yes)$/i.test(process.env['STT_GRPC_TLS_ENABLED']) : false;
        let creds: grpc.ChannelCredentials;
        if (tlsEnabled) {
            try {
                const caFile = process.env['STT_GRPC_TLS_CA_FILE'];
                const certFile = process.env['STT_GRPC_TLS_CERT_FILE'];
                const keyFile = process.env['STT_GRPC_TLS_KEY_FILE'];
                const rootCert = caFile ? readFileSync(caFile) : undefined;
                const certChain = certFile ? readFileSync(certFile) : undefined;
                const privateKey = keyFile ? readFileSync(keyFile) : undefined;
                creds = grpc.credentials.createSsl(rootCert ?? null, privateKey, certChain);
            } catch (e) {
                this.logger.error(`STT gRPC TLS credential load failed -> falling back insecure: ${(e as Error).message}`);
                creds = grpc.credentials.createInsecure();
            }
        } else {
            creds = grpc.credentials.createInsecure();
        }
        const overrideAuthority = process.env['STT_GRPC_TLS_OVERRIDE_AUTHORITY'];
        const channelArgs: Record<string, unknown> = {};
        if (overrideAuthority) {
            channelArgs['grpc.ssl_target_name_override'] = overrideAuthority;
            channelArgs['grpc.default_authority'] = overrideAuthority;
        }
        // keepalive(옵션) 환경 변수: STT_GRPC_KEEPALIVE_MS
        const kaMsRaw = process.env['STT_GRPC_KEEPALIVE_MS'];
        if (kaMsRaw) {
            const v = parseInt(kaMsRaw, 10);
            if (!isNaN(v) && v > 0) {
                channelArgs['grpc.keepalive_time_ms'] = v;
            }
        }
        this.client = new Svc(endpoint, creds, channelArgs);
    }

    private openStream() {
        if (this.stream) return;
        this.buildClient();
        // Metadata (auth / trace)
        const md = new grpc.Metadata();
    // Embedded server token (GRPC_AUTH_TOKEN) deprecated; only honor STT_GRPC_AUTH_TOKEN
    const authToken = process.env['STT_GRPC_AUTH_TOKEN'];
        if (authToken) {
            md.set('authorization', `Bearer ${authToken}`);
        }
        // traceparent (간단: 외부에서 환경 변수 설정 시)
        const traceParent = process.env['TRACEPARENT'];
        if (traceParent) {
            md.set('traceparent', traceParent);
        }
        this.stream = this.client.StreamingRecognize(md);
    const localStream = this.stream; // capture for type narrowing
    if (!localStream) return;
        localStream.on('data', (msg: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
            try {
                if (msg.error) {
                    this.logger.warn(`STT gRPC error event code=${msg.error.code} message=${msg.error.message}`);
                } else if (msg.transcript) {
                    const t = msg.transcript;
                    if (t.is_final) {
                        // 최종 문장: 누적 + 새 텍스트 로그 후 버퍼 초기화
                        const combined = (this.partialBuffer ? this.partialBuffer + ' ' : '') + t.text;
                        this.logger.info(`STT gRPC transcript final: ${combined}`);
                        try { getVendorPlugin(sttConfig.vendorPlugin ?? null, (m)=>this.logger.debug(m))?.handleTranscript?.(combined, { final: true, raw: t }); } catch { /* ignore */ }
                        this.partialBuffer = '';
                    } else {
                        // partial 교체 (streaming engines 는 누적/비누적 두 형태 가능; 여기서는 overwrite)
                        this.partialBuffer = t.text;
                        this.logger.debug(`STT gRPC transcript partial: ${t.text}`);
                        try { getVendorPlugin(sttConfig.vendorPlugin ?? null, (m)=>this.logger.debug(m))?.handleTranscript?.(t.text, { final: false, raw: t }); } catch { /* ignore */ }
                    }
                } else if (msg.ready) {
                    // proto-loader (keepCase=false) converts server_session_id -> serverSessionId
                    const sid = msg.ready.serverSessionId ?? msg.ready.server_session_id;
                    if (sid === undefined) {
                        this.logger.warn('STT gRPC ready event received without serverSessionId field');
                    } else {
                        this.logger.info(`STT gRPC session ready id=${sid}`);
                    }
                }
            } catch {
                // ignore
            }
        });
        localStream.on('error', (err: Error) => {
            this.logger.error(`STT gRPC stream error: ${err.message}`);
            this.cleanupStream();
            this.scheduleReconnect();
        });
        localStream.on('end', () => {
            this.logger.warn('STT gRPC stream ended');
            this.cleanupStream();
            this.scheduleReconnect();
        });
        // 초기 메시지 전송 (SessionInit)
        // PCMU 샘플레이트 통일 로직:
        //  - 기본적으로 μ-law 는 8000Hz 가 표준. 일부 상위 설정에서 잘못된 레이트가 들어오면 재생 속도 문제가 발생할 수 있음.
        //  - STT_GRPC_FORCE_PCMU_8K (기본 true) 이면 PCMU 선택 시 sample_rate_hz=8000 으로 강제.
        //  - STT_GRPC_PCMU_SAMPLE_RATE 로 8000 외 값을 실험적으로 지정 가능 (force 플래그 true일 때도 우선).
        const forcePcmu = process.env['STT_GRPC_FORCE_PCMU_8K'] ? /^(1|true|yes)$/i.test(process.env['STT_GRPC_FORCE_PCMU_8K']) : true;
        const pcmuRateOverrideRaw = process.env['STT_GRPC_PCMU_SAMPLE_RATE'] ? parseInt(process.env['STT_GRPC_PCMU_SAMPLE_RATE'], 10) : 8000;
        // 허용 샘플레이트 세트 (proto 코멘트 + 일반적 44.1k)
        const ALLOWED_RATES = [8000, 16000, 44100, 48000] as const;
        function nearestAllowed(v: number): typeof ALLOWED_RATES[number] {
            if ((ALLOWED_RATES as readonly number[]).includes(v)) return v as typeof ALLOWED_RATES[number];
            let bestNum: number = ALLOWED_RATES[0];
            let bestDiff = Math.abs(v - bestNum);
            for (const r of ALLOWED_RATES) {
                const d = Math.abs(v - r);
                if (d < bestDiff) { bestNum = r; bestDiff = d; }
            }
            return bestNum as typeof ALLOWED_RATES[number];
        }
        let chosenRate: typeof ALLOWED_RATES[number] = nearestAllowed(sttConfig.rate);
        const chosenEncoding = sttConfig.encoding === 'L16' ? 'LINEAR16' : 'PCMU';
        if (chosenEncoding === 'PCMU' && forcePcmu) {
            const forced = nearestAllowed(pcmuRateOverrideRaw > 0 ? pcmuRateOverrideRaw : 8000);
            if (forced !== 8000) {
                this.logger.warn(`PCMU sample rate override in effect: ${forced} (standard=8000)`);
            } else if (chosenRate !== 8000) {
                this.logger.warn(`PCMU sample rate forced to 8000 (was ${chosenRate})`);
            }
            chosenRate = forced;
        }
        const initMsg = {
            init: {
                language_code: 'ko-KR',
                sample_rate_hz: chosenRate,
                encoding: chosenEncoding,
                enable_interim_results: true,
                single_utterance: false,
                enable_word_time_offsets: false,
                vendor_params: {},
                trace_context: process.env['TRACEPARENT'] ? { traceparent: process.env['TRACEPARENT'] } : undefined,
            },
            client_session_id: `cli-${Date.now()}`,
        };
        try {
            if (localStream) localStream.write(initMsg);
            this.initSent = true;
        } catch (e) {
            this.logger.error(`Failed to send gRPC init: ${(e as Error).message}`);
        }
    }

    private cleanupStream() {
        if (this.stream) {
            try { this.stream.removeAllListeners(); } catch { /* ignore */ }
            this.stream = null;
            this.initSent = false;
        }
    }

    private scheduleReconnect() {
        const enabled = process.env['STT_GRPC_RECONNECT_ENABLED'] ? /^(1|true|yes)$/i.test(process.env['STT_GRPC_RECONNECT_ENABLED']) : sttConfig.reconnectEnabled;
        if (!enabled || this.reconnecting) return;
        this.reconnecting = true;
        const base = process.env['STT_GRPC_RECONNECT_INITIAL_MS'] ? parseInt(process.env['STT_GRPC_RECONNECT_INITIAL_MS'], 10) : (sttConfig.reconnectInitialMs ?? 1000);
        const max = process.env['STT_GRPC_RECONNECT_MAX_MS'] ? parseInt(process.env['STT_GRPC_RECONNECT_MAX_MS'], 10) : (sttConfig.reconnectMaxMs ?? 15000);
        const factorRaw = process.env['STT_GRPC_RECONNECT_FACTOR'] ? parseFloat(process.env['STT_GRPC_RECONNECT_FACTOR']) : (sttConfig.reconnectFactor ?? 2.0);
        const jitterRaw = process.env['STT_GRPC_RECONNECT_JITTER'] ? parseFloat(process.env['STT_GRPC_RECONNECT_JITTER']) : 0.3; // 30% default
        const attempt = this.reconnectAttempt++;
        const exp = Math.pow(factorRaw, attempt);
        let delay = Math.min(max, Math.round(base * exp));
        const jitterPortion = Math.max(0, Math.min(0.99, jitterRaw));
        const jitter = Math.round(delay * jitterPortion * Math.random());
        delay = delay - Math.round(delay * jitterPortion / 2) + jitter; // center 분포
        if (delay < 10) delay = 10;
        this.logger.warn(`STT gRPC reconnect attempt=${attempt} in ${delay} ms (base=${base} max=${max} factor=${factorRaw} jitter=${jitterPortion})`);
        setTimeout(() => {
            this.reconnecting = false;
            if (!this.started) return;
            try {
                this.openStream();
                // 성공 시 attempt 리셋
                this.reconnectAttempt = 0;
            } catch (e) {
                this.logger.error(`gRPC reconnect failed: ${(e as Error).message}`);
                this.scheduleReconnect();
            }
        }, delay);
    }

    async start(): Promise<void> {
        if (this.started) return;
        this.started = true;
        this.logger.info('STT gRPC forwarder starting');
            // Dry-run 모드: 테스트에서 실제 네트워크 연결을 피하고 최소한의 초기화만 수행
            if (process.env['STT_GRPC_DRY_RUN'] && /^(1|true|yes)$/i.test(process.env['STT_GRPC_DRY_RUN'])) {
                this.logger.info('STT gRPC forwarder dry-run enabled (no connection attempt)');
                this.started = true;
                this.initSent = true; // init 전송 생략하되 이후 send() 호출이 그냥 무시되도록
                return;
            }
        try {
            this.openStream();
        } catch (e) {
            this.logger.error(`Failed to start gRPC stream: ${(e as Error).message}`);
            this.scheduleReconnect();
        }
    }

    async stop(): Promise<void> {
        if (!this.started) return;
        this.started = false;
        this.logger.info('STT gRPC forwarder stopping');
        if (this.stream) {
            try { this.stream.end(); } catch { /* ignore */ }
        }
        this.cleanupStream();
    }

    send(frame: MediaDataFrame): void {
        if (!this.started || !this.stream) return;
        const payload = buildPayload(frame, this.logger, { rate: false });
        if (!payload) return;
        // AudioChunk 메시지 전송
        const msg = {
            audio: {
                data: payload,
                sequence: this.sequence++,
                end_of_stream: false,
            }
        };
        try {
            this.stream.write(msg);
        } catch (e) {
            this.logger.error(`Failed to write audio chunk to gRPC: ${(e as Error).message}`);
        }
    }
}

export function createSttForwarder(protocol: SttProtocol, logger: Logger): SttForwarder {
    switch (protocol) {
        case 'websocket':
            return new WebSocketForwarder(logger);
        case 'tcp':
            return new TcpForwarder(logger);
        case 'grpc':
            return new GrpcForwarder(logger);
        case 'mrcp': {
            const bridge = createMrcpBridge(logger);
            const fwd = new MrcpSttForwarder(logger, bridge);
            return {
                async start() {
                    await fwd.start();
                },
                async stop() {
                    await fwd.stop();
                },
                send(frame: MediaDataFrame) {
                    fwd.send(frame);
                }
            } as SttForwarder;
        }
        default:
            return new NoopForwarder();
    }
}
