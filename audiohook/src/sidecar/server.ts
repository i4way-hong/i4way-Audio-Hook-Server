/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
import Fastify from 'fastify';
import websocketPlugin from '@fastify/websocket';
import WebSocket from 'ws';
import * as path from 'path';
import * as fs from 'fs';
import * as dgram from 'dgram';
import { EventEmitter } from 'events';
import * as net from 'net';
import * as dotenv from 'dotenv';

dotenv.config();

// 포트 범위 환경 변수
const RTP_MIN = Number(process.env['MRCP_RTP_PORT_MIN'] || 40000);
const RTP_MAX = Number(process.env['MRCP_RTP_PORT_MAX'] || 40100);

// ---------------- RTP 유틸 ----------------
class RtpSender {
    private socket: dgram.Socket | null = null;
    private seq = Math.floor(Math.random() * 65535);
    private ssrc = Math.floor(Math.random() * 0xffffffff);
    private ts = Math.floor(Math.random() * 0xffffffff);

    constructor(
        private readonly remoteIp: string,
        private readonly remotePort: number,
        private readonly payloadType: number,
        private readonly sampleRate: number,
        private readonly ptimeMs: number,
        public localPort: number,
    ) {}

    static async bindInRange(minPort: number, maxPort: number): Promise<dgram.Socket & { localPort: number }> {
        return await new Promise((resolve, reject) => {
            let port = minPort;
            const tryBind = () => {
                const sock = dgram.createSocket('udp4');
                sock.once('error', (err) => {
                    sock.close();
                    if (port < maxPort) {
                        port += 1;
                        tryBind();
                    } else {
                        reject(err);
                    }
                });
                sock.bind(port, '0.0.0.0', () => {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    (sock as any).localPort = port;
                    resolve(sock as dgram.Socket & { localPort: number });
                });
            };
            tryBind();
        });
    }

    static async bindSpecific(port: number): Promise<dgram.Socket & { localPort: number }> {
        return await new Promise((resolve, reject) => {
            const sock = dgram.createSocket('udp4');
            sock.once('error', (err) => {
                try {
                    sock.close();
                } catch {
                    // noop
                }
                reject(err);
            });
            sock.bind(port, '0.0.0.0', () => {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (sock as any).localPort = port;
                resolve(sock as dgram.Socket & { localPort: number });
            });
        });
    }

    async start(): Promise<void> {
        if (this.socket) {
            return;
        }
        if (this.localPort && this.localPort > 0) {
            try {
                const sock = await RtpSender.bindSpecific(this.localPort);
                this.socket = sock;
                this.localPort = sock.localPort;
                return;
            } catch {
                // fall back to range bind if specific port failed
            }
        }
        const sock = await RtpSender.bindInRange(RTP_MIN, RTP_MAX);
        this.socket = sock;
        this.localPort = sock.localPort;
    }

    send(payload: Buffer): void {
        if (!this.socket) {
            return;
        }
        const header = Buffer.alloc(12);
        header[0] = 0x80; // V=2
        header[1] = this.payloadType & 0x7f; // M=0, PT
        header.writeUInt16BE(this.seq & 0xffff, 2);
        header.writeUInt32BE(this.ts >>> 0, 4);
        header.writeUInt32BE(this.ssrc >>> 0, 8);
    // Buffer.concat 사용 시 TS 타입 충돌 회피 위해 수동 복사
    const u8 = new Uint8Array(header.length + payload.length);
    u8.set(header, 0);
    u8.set(payload, header.length);
    this.socket.send(u8, this.remotePort, this.remoteIp);
        // advance counters
        this.seq = (this.seq + 1) & 0xffff;
        const samplesPerPacket = Math.floor((this.sampleRate * this.ptimeMs) / 1000);
        this.ts = (this.ts + samplesPerPacket) >>> 0;
    }

    close(): void {
        try {
            this.socket?.close();
        } catch {
            // ignore
        }
        this.socket = null;
    }
}

// ---------------- MRCP 시그널링 인터페이스 (추출) ----------------
import { createStubSignaling, OpenSessionArgs, SignalingSession, MrcpSignaling } from './signaling/stub-signaling';
import { registerTelemetryProvider, unregisterTelemetryProvider, renderMetrics } from './signaling/metrics';

// ---------------- 기본 Stub 구현(후에 네이티브/외부 모듈로 교체 가능) ----------------

function getSignaling(): MrcpSignaling {
    const mode = (process.env['MRCP_SIDECAR_SIGNALING'] || 'stub').toLowerCase();
    const modPathEnv = process.env['MRCP_SIDECAR_SIGNALING_MODULE'];
    try {
        if ((mode === 'native' || mode === 'module') && modPathEnv) {
            const base = path.isAbsolute(modPathEnv)
                ? modPathEnv
                : path.resolve(process.cwd(), modPathEnv);
            const candidates = [base, `${base}.ts`, `${base}.js`, `${base}.cjs`, `${base}.mjs`];
            let resolvedFile: string | null = null;
            for (const c of candidates) {
                if (fs.existsSync(c)) {
                    resolvedFile = c;
                    break;
                }
            }
            const target = resolvedFile ?? base;
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const AnyMod = require(target);
            const mod = AnyMod?.default ?? AnyMod;
            if (mod && typeof mod.openSession === 'function') {
                // eslint-disable-next-line no-console
                console.log(`[MRCP] signaling loaded: ${mode} -> ${target}`);
                return mod as MrcpSignaling;
            }
            // eslint-disable-next-line no-console
            console.warn(`[MRCP] signaling module has no openSession(): ${target}`);
        }
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('[MRCP] signaling module load failed, fallback to stub:', e);
    }
    // eslint-disable-next-line no-console
    console.log('[MRCP] using stub signaling');
    return createStubSignaling();
}

const signaling: MrcpSignaling = getSignaling();

// ---------------- WS 사이드카 ----------------
const PORT = Number(process.env['MRCP_SIDECAR_PORT'] || 9090);
const PATHNAME = process.env['MRCP_SIDECAR_PATH'] || '/mrcp';

async function startWs() {
    const fastify = Fastify({ logger: true });
    await fastify.register(websocketPlugin);

    // /metrics (Prometheus exposition)
    fastify.get('/metrics', async (_req, reply) => {
        const body = renderMetrics();
        reply.header('Content-Type', 'text/plain; version=0.0.4');
        reply.send(body);
    });

    fastify.get(PATHNAME, { websocket: true }, (connection /* SocketStream */) => {
        const ws = connection.socket as WebSocket;
        let inited = false;
        let bytes = 0;
        let profileId = 'ah-mrcpv1';
        let endpoint = 'rtsp://127.0.0.1:8060/unimrcp';
        let codec = 'PCMU';
        let sampleRate = 8000;
        let ptimeMs = 20;
        let payloadType = 0; // PCMU
        let rtp: RtpSender | null = null;
        let sig: SignalingSession | null = null;

        let telemetryProvider: (() => any) | null = null;
        const stopAll = () => {
            try {
                if (sig) {
                    sig.close();
                }
            } catch {
                // noop
            }
            sig = null;
            rtp?.close();
            rtp = null;
            if (telemetryProvider) {
                unregisterTelemetryProvider(telemetryProvider);
                telemetryProvider = null;
            }
        };

        ws.on('message', async (data, isBinary) => {
            if (!inited) {
                // 첫 메시지는 init JSON
                try {
                    const msg = JSON.parse(isBinary ? (data as Buffer).toString() : String(data));
                    if (msg?.type !== 'init') {
                        ws.send(JSON.stringify({ type: 'error', message: 'First message must be init' }));
                        ws.close();
                        return;
                    }
                    inited = true;
                    profileId = String(msg.profileId || 'ah-mrcpv1');
                    endpoint = String(msg.endpoint || endpoint);
                    codec = String(msg.codec || 'PCMU');
                    sampleRate = Number(msg.sampleRate || 8000);
                    ptimeMs = Number(msg.ptime || 20);

                    // UniMRCP 세션 오픈(v1/v2 분기 포함)
                    sig = await signaling.openSession({ endpoint, profileId, codec, sampleRate, language: msg.language });
                    const anySig: any = sig as any;
                    if (anySig.getTelemetry) {
                        telemetryProvider = () => anySig.getTelemetry();
                        registerTelemetryProvider(telemetryProvider);
                    }
                    payloadType = sig.payloadType;

                    // RTP 소켓 생성(40000-40100 범위), 원격은 시그널링 결과 사용
                    const agreedPtime = (sig as any).ptimeMs as number | undefined;
                    if (agreedPtime && agreedPtime > 0) {
                        ptimeMs = agreedPtime;
                    }
                    rtp = new RtpSender(sig.remoteIp, sig.remotePort, payloadType, sampleRate, ptimeMs, sig.localPort ?? 0);
                    await rtp.start();

                    // 연결 이벤트 전송
                    const u = new URL(endpoint);
                    ws.send(JSON.stringify({ type: 'rtsp-connected', remote: `${u.host}${u.pathname}`, profileId }));
                    ws.send(JSON.stringify({ type: 'rtp-started', localRtpPort: rtp.localPort, payloadType }));

                    // 엔진 이벤트 브릿지
                    sig.emitter.on('result', (ev) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify(ev));
                        }
                    });
                    sig.emitter.on('closed', (ev) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify(ev));
                            ws.close();
                        }
                    });
                    sig.emitter.on('error', (ev) => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: 'error', message: ev?.message || 'engine error' }));
                        }
                    });

                    return;
                } catch (e) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Invalid init', cause: (e as Error).message }));
                    ws.close();
                    return;
                }
            }
            // 바이너리 오디오는 RTP로 전송
            if (isBinary) {
                bytes += (data as Buffer).byteLength;
                rtp?.send(data as Buffer);
                // Stub 시나리오에서 누적 바이트 기반 결과 트리거
                if (sig) {
                    try {
                        sig.emitter.emit('audio-bytes', (data as Buffer).byteLength);
                        sig.emitter.emit('rtp-packet');
                    } catch {
                        // ignore
                    }
                }
                return;
            }
            // 텍스트 메시지 처리(bye 등)
            try {
                const msg = JSON.parse(String(data));
                if (msg?.type === 'bye') {
                    // MRCP 세션과 RTP 종료
                    ws.send(JSON.stringify({ type: 'closed', reason: 'client-bye' }));
                    stopAll();
                    ws.close();
                }
            } catch {
                // ignore
            }
        });

        ws.on('close', () => {
            // 자원 정리
            stopAll();
            fastify.log.info(`WS closed. bytes=${bytes} profile=${profileId}`);
        });

        // 데모 결과는 제거(실서비스에선 엔진 이벤트를 사용)
    });

    await fastify.listen({ host: '0.0.0.0', port: PORT });
    // 실제 바인딩된 포트 (PORT=0 인 경우 OS 할당)
    const addr = fastify.server.address();
    const actualPort = typeof addr === 'object' && addr ? (addr as any).port : PORT;
    fastify.log.info(`WS sidecar listening ws://127.0.0.1:${actualPort}${PATHNAME}`);
}

// ---------------- gRPC 사이드카 ----------------
function resolveProto(): string {
    const dist = path.join(__dirname, 'proto', 'mrcp_sidecar.proto');
    if (fs.existsSync(dist)) {
        return dist;
    }
    const src = path.join(process.cwd(), 'audiohook', 'src', 'sidecar', 'proto', 'mrcp_sidecar.proto');
    return src;
}

function startGrpc() {
    let grpc: any;
    let protoLoader: any;
    try {
        grpc = require('@grpc/grpc-js');
        protoLoader = require('@grpc/proto-loader');
    } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('gRPC deps not installed. Skipping gRPC sidecar. Install @grpc/grpc-js and @grpc/proto-loader to enable.', e);
        return;
    }

    const PROTO_PATH = resolveProto();
    const packageDefinition = protoLoader.loadSync(PROTO_PATH, { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true });
    const mrcpProto = grpc.loadPackageDefinition(packageDefinition).mrcp;

    const server = new grpc.Server();
    // Unary 예시: HealthCheck
    server.addService(mrcpProto.Health.service, {
        Check: (_call: unknown, callback: (err: unknown, resp: { status: string }) => void) => {
            callback(null, { status: 'SERVING' });
        },
    });
    // Stream 예시: Audio 스트림을 받아 이벤트 스트림 반환(스켈레톤)
    server.addService(mrcpProto.MrcpSidecar.service, {
        StartSession: (call: any) => {
            // 첫 메시지로 Init를 기대
            let inited = false;
            let rtp: RtpSender | null = null;
            let sig: SignalingSession | null = null;
            call.on('data', async (msg: any) => {
                // Init
                if (!inited && msg?.init) {
                    inited = true;
                    const endpoint: string = msg.init.endpoint || 'rtsp://127.0.0.1:8060/unimrcp';
                    const profileId: string = msg.init.profile_id || 'ah-mrcpv1';
                    const codec: string = msg.init.codec || 'PCMU';
                    const sampleRate: number = msg.init.sample_rate || 8000;
                    const ptimeMs = 20;

                    sig = await signaling.openSession({ endpoint, profileId, codec, sampleRate });

                    rtp = new RtpSender(sig.remoteIp, sig.remotePort, sig.payloadType, sampleRate, ptimeMs, sig.localPort ?? 0);
                    await rtp.start();

                    const u = new URL(endpoint);
                    call.write({ event: { type: 'rtsp-connected', remote: `${u.host}${u.pathname}` } });
                    call.write({ event: { type: 'rtp-started', local_rtp_port: rtp.localPort, payload_type: sig.payloadType } });

                    sig.emitter.on('result', (ev) => call.write({ event: ev }));
                    sig.emitter.on('closed', (ev) => call.write({ event: ev }));
                    sig.emitter.on('error', (ev) => call.write({ event: { type: 'error', message: ev?.message || 'engine error' } }));
                    return;
                }
                // Audio
                if (inited && msg?.audio?.data && rtp) {
                    rtp.send(Buffer.from(msg.audio.data));
                    return;
                }
            });
            call.on('end', () => {
                rtp?.close();
                try {
                    if (sig) {
                        sig.close();
                    }
                } catch {
                    // noop
                }
                call.write({ event: { type: 'closed', reason: 'client-end' } });
                call.end();
            });
        },
    });
    const grpcPort = process.env['MRCP_SIDECAR_GRPC_PORT'] || '50051';
    server.bindAsync(`0.0.0.0:${grpcPort}`, grpc.ServerCredentials.createInsecure(), (err: unknown, port: number) => {
        if (err) {
            // eslint-disable-next-line no-console
            console.error('gRPC bind error', err);
            return;
        }
        server.start();
        // eslint-disable-next-line no-console
        console.log(`gRPC sidecar listening 0.0.0.0:${port}`);
    });
}

async function main() {
    await startWs();
    startGrpc();
}

// eslint-disable-next-line @typescript-eslint/no-floating-promises
main();
