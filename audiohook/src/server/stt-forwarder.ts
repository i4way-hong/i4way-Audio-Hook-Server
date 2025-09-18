import WebSocket from 'ws';
import sttConfig, { SttProtocol, SttEncoding, TcpFraming } from '../utils/stt-config';
import { Logger } from '../utils/logger';
import { MediaDataFrame } from './mediadata';
import { ulawFromL16 } from '../audio/ulaw';
import { Socket } from 'net';
import { resampleL16 } from '../audio/resample';
import { createAudioFrame } from '../audio';
import { TextDecoder } from 'util';

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

    constructor(logger: Logger) {
        this.logger = logger;
    }

    private maybeSendInit(): void {
        const payload = sttConfig.wsInitJson;
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

    private sendBye(): void {
        const payload = sttConfig.wsByeJson;
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

    async start(): Promise<void> {
        const url = sttConfig.endpoint;
        if (!url) {
            throw new Error('STT endpoint is not configured');
        }
        await new Promise<void>((resolve, reject) => {
            const ws = new WebSocket(url, {
                headers: {
                    ...(sttConfig.apiKey ? { Authorization: `Bearer ${sttConfig.apiKey}` } : {}),
                    ...(sttConfig.headers ?? {}),
                }
            });
            ws.on('open', () => {
                this.logger.info(`STT WS connected: ${url}`);
                this.ws = ws;
                this.maybeSendInit();
                this.schedulePing();
                resolve();
            });
            ws.on('message', (data, isBinary) => {
                try {
                    if (isBinary) {
                        const len = Buffer.isBuffer(data) ? data.length : Array.isArray(data) ? Buffer.concat(data as Buffer[]).length : (data as ArrayBuffer).byteLength;
                        this.logger.debug(`STT WS recv binary (${len} bytes)`);
                    } else {
                        const decoder = new TextDecoder('utf-8');
                        let text: string;
                        if (typeof data === 'string') {
                            text = data;
                        } else if (Buffer.isBuffer(data)) {
                            text = decoder.decode(data);
                        } else if (Array.isArray(data)) {
                            text = decoder.decode(Buffer.concat(data as Buffer[]));
                        } else {
                            text = decoder.decode(new Uint8Array(data as ArrayBuffer));
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
            });
        });
    }

    async stop(): Promise<void> {
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
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
        if (payload) {
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

    constructor(logger: Logger) {
        this.logger = logger;
    }

    // 수신 텍스트 미리보기 로그
    private logTcpTextPreview(buf: Buffer) {
        try {
            const decoder = new TextDecoder('utf-8');
            const text = decoder.decode(buf);
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
                return Buffer.concat([h, buf]);
            }
            case 'newline': {
                return Buffer.concat([buf, Buffer.from('\n')]);
            }
            case 'raw':
            default:
                return buf;
        }
    }

    async start(): Promise<void> {
        const ep = sttConfig.endpoint;
        if (!ep) {
            throw new Error('STT endpoint is not configured');
        }
        const { host, port } = this.parseEndpoint(ep);
        await new Promise<void>((resolve, reject) => {
            const sock = new Socket();
            sock.setNoDelay(true);
            const onDrain = () => {
                if (!this.socket || this.waitingDrain === false) {
                    return;
                }
                while (this.writeQueue.length > 0) {
                    const chunk = this.writeQueue.shift();
                    if (!chunk) {
                        break;
                    }
                    const ok = this.socket.write(chunk);
                    if (!ok) {
                        // still backpressured; wait for next drain
                        this.waitingDrain = true;
                        return;
                    }
                }
                this.waitingDrain = false;
            };
            sock.once('connect', () => {
                this.logger.info(`STT TCP connected: ${host}:${port}`);
                this.socket = sock;
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
                        this.inboundBuffer = Buffer.concat([this.inboundBuffer, buf]);
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
                        this.inboundBuffer = Buffer.concat([this.inboundBuffer, buf]);
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
                        sock.write(hexToBuffer(sttConfig.tcpInitHex));
                    } catch {
                        // ignore
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
            });
            sock.connect(port, host);
        });
    }

    async stop(): Promise<void> {
        const s = this.socket;
        if (s) {
            // BYE
            if (sttConfig.tcpByeHex) {
                try {
                    s.write(hexToBuffer(sttConfig.tcpByeHex));
                } catch {
                    // ignore
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
            const ok = s.write(framed);
            if (!ok) {
                this.logger.debug('STT TCP backpressure: socket buffer is full');
                this.waitingDrain = true;
            }
        }
    }
}

// gRPC 포워더 스텁: 인터페이스만 구현, 후속 단계에서 실제 스트리밍 추가 예정
class GrpcForwarder implements SttForwarder {
    private readonly logger: Logger;
    private started = false;
    constructor(logger: Logger) {
        this.logger = logger;
    }
    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.logger.info('STT gRPC forwarder (stub) started');
        this.started = true;
    }
    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }
        this.logger.info('STT gRPC forwarder (stub) stopped');
        this.started = false;
    }
    send(_frame: MediaDataFrame): void {
        // no-op for now; parameter kept for interface compatibility
        void _frame;
    }
}

// MRCP 포워더 스텁: 인터페이스만 구현, 후속 단계에서 세션/RTSP/RTP 연결 예정
class MrcpForwarder implements SttForwarder {
    private readonly logger: Logger;
    private started = false;
    constructor(logger: Logger) {
        this.logger = logger;
    }
    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.logger.info('STT MRCP forwarder (stub) started');
        this.started = true;
    }
    async stop(): Promise<void> {
        if (!this.started) {
            return;
        }
        this.logger.info('STT MRCP forwarder (stub) stopped');
        this.started = false;
    }
    send(_frame: MediaDataFrame): void {
        // no-op for now; parameter kept for interface compatibility
        void _frame;
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
        case 'mrcp':
            return new MrcpForwarder(logger);
        default:
            return new NoopForwarder();
    }
}
