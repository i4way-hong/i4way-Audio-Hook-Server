/*
 UniMRCP signaling integration skeleton for MRCP sidecar.
 Usage:
   .env
     MRCP_SIDECAR_SIGNALING=module
     MRCP_SIDECAR_SIGNALING_MODULE=./audiohook/src/sidecar/signaling/unimrcp-signaling

 Implement the native binding in ./native (node-addon-api) or connect to an external daemon.
*/
import { EventEmitter } from 'events';
import * as dgram from 'dgram';
import * as path from 'path';
import * as net from 'net';
import { OpenSessionArgs, SignalingSession, isMrcpEvent, MrcpErrorCode } from './types';
import { performSipInvite, sendSipAck, sendSipBye } from './sip-v2';
import { performSipInviteUdp } from './sip-udp';
import { MrcpTelemetry } from './telemetry';
// SIP placeholder (performSipInvite) 는 아직 미구현 - 참조용
// import { performSipInvite } from './sip-client';
import { ResultSimulator } from './result-simulator';


// ---- Shared RTSP parsing helpers ----
interface RtspParsedHeaders {
    statusLine: string;
    headers: Record<string, string>;
    headerEnd: number; // index AFTER the header boundary
    contentLength?: number;
}

function parseRtspHeaders(accumulated: string, debug?: (...a: any[]) => void): RtspParsedHeaders | null {
    // Support both CRLFCRLF and LFLF (defensive)
    let idx = accumulated.indexOf('\r\n\r\n');
    let boundaryLen = 4;
    if (idx === -1) {
        idx = accumulated.indexOf('\n\n');
        boundaryLen = 2;
    }
    if (idx === -1) return null;
    const rawHeader = accumulated.substring(0, idx);
    if (debug) debug('raw header snippet=', rawHeader.substring(0,120).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
    const lines = rawHeader.split(/\r?\n/).filter(Boolean);
    const statusLine = lines.shift() || '';
    const headers: Record<string,string> = {};
    for (const line of lines) {
        const cIdx = line.indexOf(':');
        if (cIdx === -1) continue;
        const k = line.substring(0, cIdx).trim().toLowerCase();
        const v = line.substring(cIdx + 1).trim();
        headers[k] = v;
    }
    let contentLength: number | undefined;
    if (headers['content-length']) {
        const n = Number(headers['content-length']);
        if (Number.isFinite(n) && n >= 0) contentLength = n; else if (debug) debug('invalid content-length header value=', headers['content-length']);
    }
    return { statusLine, headers, headerEnd: idx + boundaryLen, contentLength };
}

type NativeRemoteInfo = {
    remoteIp: string;
    remotePort: number;
    payloadType: number;
    // opaque handle to native session
    handle: number | string;
};

type NativeBinding = {
    // Perform RTSP(SDP)/SIP(SDP) negotiation with UniMRCP client SDK.
    // Returns remote RTP and payload type. It SHOULD allocate local RTP in the configured range and include it in SDP offer.
    openSession(args: OpenSessionArgs & { rtpPortMin: number; rtpPortMax: number }): Promise<NativeRemoteInfo>;
    // Subscribe to MRCP application events and invoke callback with JSON serializable event objects.
    onEvent(handle: number | string, cb: (ev: unknown) => void): void;
    // Close session and release resources.
    closeSession(handle: number | string): Promise<void>;
};

function loadNative(): NativeBinding | null {
    try {
        // Prefer node-gyp-build convention
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const nodeGypBuild = require('node-gyp-build');
        const native = nodeGypBuild(path.join(__dirname, 'native')) as NativeBinding;
        if (native && typeof native.openSession === 'function') {
            return native;
        }
    } catch {
        // ignore
    }
    try {
        // Fallback to direct require of compiled addon
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const native = require('./native/build/Release/unimrcp.node') as NativeBinding;
        if (native && typeof native.openSession === 'function') {
            return native;
        }
    } catch {
        // ignore
    }
    return null;
}

const nativeBinding = loadNative();

/**
 * TODO Roadmap for full UniMRCP integration (Design Outline)
 * 1. RTSP (MRCPv1) Flow
 *    - DESCRIBE -> parse SDP (already prototyped)
 *    - SETUP (allocate server resources) -> expect 200 OK with session + RTP info
 *    - ANNOUNCE / DEFINE-GRAMMAR (optional) for custom grammars
 *    - RECORD / RECOGNIZE start -> server sends IN-PROGRESS / START-OF-INPUT / RECOGNITION-COMPLETE events
 *    - TEARDOWN on close
 *    Implementation Notes:
 *      - Need RTSP CSeq management, session header persistence
 *      - MRCP messages are tunneled in RTSP message body (Content-Type: application/mrcp)
 *      - Build minimal MRCP parser (start-line + headers + body) for events we care about
 * 2. SIP (MRCPv2) Flow
 *    - INVITE (Offer) -> 200 OK (Answer) -> ACK
 *    - MRCP messages over a persistent TCP channel separate from RTP (channel identified by MRCP session-id)
 *    - Similar MRCP message lifecycle as v1, different signaling framing
 * 3. Unified Abstraction
 *    - Create internal SessionContext { transport: 'rtsp'|'sip', rtp: RtpSender, mrcpChannel: Duplex }
 *    - onEvent(ev) normalizes: { type: 'result'|'error'|'closed', text?, confidences?, nbest? }
 * 4. Native vs Pure TS
 *    - Pure TS feasible for RTSP path; SIP stack integration may be easier via existing libraries or native SDK
 *    - Native binding should expose: createClient(config) -> sessionHandle; sendMrcp(sessionHandle, msg); close(sessionHandle)
 * 5. Error Handling
 *    - Timeouts: DESCRIBE / SETUP / INVITE each have individual timeout
 *    - Retry Policy (env-controlled): linear or exponential backoff for transient network errors
 * 6. Telemetry
 *    - Counters: bytesSent, packetsSent, resultsReceived, avgLatency
 *    - Hook for external metrics exporter
 * 7. Security / TLS
 *    - Future: RTSP over TLS (rtsps://), SIP over TLS (sips:), certificate pinning
 */

async function rtspDescribe(u: URL): Promise<{ remotePort: number; payloadType?: number; ptimeMs?: number }> {
    const host = u.hostname;
    const port = Number(u.port || 8060);
    const req = [
        `DESCRIBE ${u.toString()} RTSP/1.0`,
        'CSeq: 1',
        'Accept: application/sdp',
        'User-Agent: audiohook-sidecar/1.0',
        '',
        '',
    ].join('\r\n');

    return await new Promise((resolve, reject) => {
        const started = Date.now();
    const socket = net.createConnection({ host, port, timeout: 2500 });
    // String accumulation approach
    let text = '';
    let parsed: RtspParsedHeaders | null = null;

    const debugEnabled = !!process.env['MRCP_TEST_DEBUG'];
    const debug = (...a: any[]) => { if (debugEnabled) console.log('[rtspDescribe]', ...a); };
    debug('connect attempt', host, port);

        const tryParse = () => {
            if (!parsed) {
                parsed = parseRtspHeaders(text, debug);
                if (!parsed) {
                    debug('waiting header boundary. current size=', text.length, 'preview=', text.substring(0,60).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
                    return;
                }
                if (!/200/.test(parsed.statusLine)) return fail(new Error(`RTSP DESCRIBE failed: ${parsed.statusLine}`));
                if (parsed.contentLength === undefined) return fail(new Error('RTSP DESCRIBE missing Content-Length'));
                if (!Number.isFinite(parsed.contentLength) || (parsed.contentLength as number) <= 0) return fail(new Error('Invalid Content-Length'));
                debug('parsed headers contentLength=', parsed.contentLength, 'bodyOffset=', parsed.headerEnd);
            }
            if (parsed && parsed.contentLength !== undefined) {
                const bodyAvail = text.length - parsed.headerEnd;
                debug('body progress', bodyAvail, '/', parsed.contentLength);
                if (bodyAvail >= parsed.contentLength) {
                    const body = text.substring(parsed.headerEnd, parsed.headerEnd + parsed.contentLength);
                    try {
                        const { remotePort, payloadType, ptimeMs } = parseSdp(body);
                        debug('SDP parsed remotePort=', remotePort, 'payloadType=', payloadType, 'ptime=', ptimeMs);
                        cleanup();
                        resolve({ remotePort, payloadType, ptimeMs });
                    } catch (e) { fail(e as Error); }
                }
            }
        };
        const fail = (err: Error) => {
            cleanup();
            reject(err);
        };
        const cleanup = () => {
            socket.removeAllListeners();
            socket.destroy();
        };

        socket.on('connect', () => {
            debug('connected, sending DESCRIBE');
            if (debugEnabled) debug('request hex', Buffer.from(req).toString('hex'));
            socket.write(req);
        });
        socket.on('data', (chunk) => {
            const sample = chunk.slice(0, Math.min(128, chunk.length));
            const hex = sample.toString('hex');
            let cr=0, lf=0; for (const b of sample) { if (b===13) cr++; else if (b===10) lf++; }
            if (text.length === 0) {
                debug('recv first chunk', chunk.length, 'cr=', cr, 'lf=', lf, debugEnabled ? ('hexSample=' + hex) : '');
            } else {
                debug('recv chunk', chunk.length, 'accumulatedLen(before)=', text.length);
            }
            text += chunk.toString('utf8');
            tryParse();
        });
        socket.on('end', () => {
            debug('socket end event');
            tryParse();
            if (!parsed) {
                debug('string preview (first 120)=', text.substring(0,120).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
                fail(new Error('RTSP DESCRIBE connection ended before headers parsed'));
            }
        });
        socket.on('timeout', () => {
            debug('timeout after', Date.now() - started, 'ms');
            fail(new Error('RTSP DESCRIBE timeout'));
        });
        socket.on('error', (e) => {
            debug('error', (e as Error).message);
            fail(e as Error);
        });
    });
}

// RTSP SETUP: client_port(로컬 RTP 포트 범위) → server_port(원격 RTP 포트 범위) 파싱
async function rtspSetup(u: URL, clientRtpPort: number, timeoutMs = 3000): Promise<{ remotePort: number }> {
    const host = u.hostname;
    const port = Number(u.port || 8060);
    const cseq = 2; // DESCRIBE 다음 가정
    const clientPortRange = `${clientRtpPort}-${clientRtpPort + 1}`; // RTP/RTCP
    const transport = `RTP/AVP;unicast;client_port=${clientPortRange}`;
    const req = [
        `SETUP ${u.toString()} RTSP/1.0`,
        `CSeq: ${cseq}`,
        `Transport: ${transport}`,
        'User-Agent: audiohook-sidecar/1.0',
        '',
        '',
    ].join('\r\n');

    return await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port, timeout: timeoutMs });
    let text = '';
    let parsed: RtspParsedHeaders | null = null;
    const debugEnabled = !!process.env['MRCP_TEST_DEBUG'];
    const debug = (...a: any[]) => { if (debugEnabled) console.log('[rtspSetup]', ...a); };
    debug('connect attempt', host, port, 'clientRtpPort', clientRtpPort);
        socket.on('connect', () => {
            debug('connected, sending SETUP');
            if (debugEnabled) debug('request hex', Buffer.from(req).toString('hex'));
            socket.write(req);
        });
        const tryParse = () => {
            if (!parsed) {
                parsed = parseRtspHeaders(text, debug);
                if (!parsed) {
                    debug('waiting header boundary size=', text.length, 'preview=', text.substring(0,60).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
                    return;
                }
                if (!parsed.statusLine.includes('200')) {
                    socket.destroy();
                    reject(new Error(`RTSP SETUP failed: ${parsed.statusLine}`));
                    return;
                }
                const transport = parsed.headers['transport'];
                if (transport) {
                    const m = /server_port=(\d+)(?:-(\d+))?/.exec(transport);
                    if (m) {
                        const rtpPort = Number(m[1]);
                        if (!Number.isFinite(rtpPort) || rtpPort <= 0) {
                            socket.destroy();
                            reject(new Error('Invalid server_port in Transport header'));
                            return;
                        }
                        debug('parsed server_port', rtpPort);
                        socket.destroy();
                        resolve({ remotePort: rtpPort });
                        return;
                    }
                }
                socket.destroy();
                reject(new Error('No server_port in RTSP SETUP response'));
            }
        };
        socket.on('data', (chunk) => {
            const sample = chunk.slice(0, Math.min(96, chunk.length));
            const hex = sample.toString('hex');
            let cr=0, lf=0; for (const b of sample) { if (b===13) cr++; else if (b===10) lf++; }
            if (text.length === 0) {
                debug('recv first chunk', chunk.length, 'cr=', cr, 'lf=', lf, debugEnabled ? ('hexSample=' + hex) : '');
            } else {
                debug('recv chunk', chunk.length, 'accumulated', text.length);
            }
            text += chunk.toString('utf8');
            tryParse();
        });
        socket.on('timeout', () => {
            debug('timeout');
            socket.destroy();
            reject(new Error('RTSP SETUP timeout'));
        });
        socket.on('error', (e) => {
            debug('error', (e as Error).message);
            socket.destroy();
            reject(e);
        });
        socket.on('end', () => {
            debug('end event, final size', text.length);
            if (!parsed) {
                reject(new Error('RTSP SETUP connection ended before headers parsed'));
            }
        });
    });
}

async function rtspSetupWithRetry(u: URL, clientRtpPort: number, attempts = Number(process.env['MRCP_RTSP_SETUP_RETRIES'] || 2), delayMs = 80): Promise<{ remotePort: number }> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await rtspSetup(u, clientRtpPort);
        } catch (e) {
            lastErr = e;
            const msg = (e as Error).message || '';
            if (i < attempts - 1 && (msg.includes('timeout') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED'))) {
                await new Promise(r => setTimeout(r, delayMs));
                continue;
            }
            break;
        }
    }
    throw lastErr;
}

export function parseSdp(sdp: string): { remotePort: number; payloadType?: number; ptimeMs?: number } {
    // Find m=audio line and optional a=ptime
    let ptimeMs: number | undefined;
    const lines = sdp.split(/\r?\n/);
    for (const line of lines) {
        if (line.startsWith('a=ptime:')) {
            const v = Number(line.substring('a=ptime:'.length).trim());
            if (Number.isFinite(v) && v > 0) {
                ptimeMs = v;
            }
        }
    }
    for (const line of lines) {
        if (line.startsWith('m=audio')) {
            // m=audio <port> RTP/AVP <pt> [pt2 ...]
            const parts = line.split(/\s+/);
            if (parts.length >= 4) {
                const remotePort = Number(parts[1]);
                const pt = Number(parts[3]);
                if (!Number.isFinite(remotePort) || remotePort <= 0) {
                    throw new Error('Invalid SDP m=audio port');
                }
                return { remotePort, payloadType: Number.isFinite(pt) ? pt : undefined, ptimeMs };
            }
        }
    }
    throw new Error('No m=audio line in SDP');
}

function isSipProfile(profileId: string, endpoint: string): boolean {
    return profileId.includes('v2') || endpoint.startsWith('sip:');
}

function allocLocalRtpPort(min: number, max: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const tryPort = (p: number) => {
            const s = net.createConnection({ host: '127.0.0.1', port: p }, () => {
                // If connect succeeds, port is in use (TCP). Try next.
                s.destroy();
                if (p < max) {
                    tryPort(p + 1);
                } else {
                    reject(new Error('No free RTP port'));
                }
            });
            s.on('error', () => {
                // Assume free for UDP usage
                resolve(p);
            });
        };
        tryPort(Number(process.env['MRCP_RTP_PORT_MIN'] || 40000));
    });
}

// ---- 초기 OPTIONS/DESCRIBE 시뮬레이션 보조 (RTSP) ----
// 향후 실제 RTSP 핸드셰이크 확장 시 재사용될 수 있는 placeholder
async function rtspOptions(u: URL, timeoutMs = 1500): Promise<void> {
    const host = u.hostname;
    const port = Number(u.port || 8060);
    const req = [
        `OPTIONS ${u.toString()} RTSP/1.0`,
        'CSeq: 1',
        'User-Agent: audiohook-sidecar/1.0',
        '',
        '',
    ].join('\r\n');
    await new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host, port, timeout: timeoutMs });
        let buf = '';
        sock.on('connect', () => sock.write(req));
        sock.on('data', (d) => {
            buf += d.toString();
            if (buf.includes('\r\n\r\n')) {
                if (!buf.startsWith('RTSP/1.0 200')) {
                    reject(new Error('RTSP OPTIONS non-200'));
                } else {
                    resolve();
                }
                sock.destroy();
            }
        });
        sock.on('timeout', () => {
            reject(new Error('RTSP OPTIONS timeout'));
            sock.destroy();
        });
        sock.on('error', (e) => {
            reject(e);
        });
    });
}

// TODO: SIP INVITE O/A 시뮬레이션 placeholder (추후 구현)

function buildSdpOffer(localIp: string, localPort: number, payloadType: number): string {
    const sdp = [
        'v=0',
        `o=- 0 0 IN IP4 ${localIp}`,
        's=AudioHook',
        `c=IN IP4 ${localIp}`,
        't=0 0',
        `m=audio ${localPort} RTP/AVP ${payloadType}`,
        'a=rtpmap:0 PCMU/8000',
    ].join('\r\n');
    return sdp + '\r\n';
}

async function rtspDescribeWithRetry(u: URL, attempts = Number(process.env['MRCP_RTSP_DESCRIBE_RETRIES'] || 3), delayMs = 80) {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await rtspDescribe(u);
    } catch (e) {
      lastErr = e;
      const msg = (e as Error).message || '';
      if (i < attempts - 1 && (msg.includes('ECONNREFUSED') || msg.includes('timeout'))) {
        await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      break;
    }
  }
  throw lastErr;
}

async function sipInvite(u: URL, localIp: string, localPort: number, payloadType: number): Promise<{ remotePort: number; payloadType?: number; ptimeMs?: number }> {
    // Simplified SIP INVITE transaction to fetch SDP answer from 200 OK
    const host = u.hostname;
    const port = Number(u.port || 5060);
    const viaBranch = `z9hG4bK-${Math.random().toString(16).slice(2)}`;
    const callId = `${Date.now()}@${localIp}`;
    const fromTag = Math.random().toString(16).slice(2);
    const to = `sip:${host}`;
    const from = `sip:audiohook@${localIp}`;
    const contact = `sip:audiohook@${localIp}`;
    const cseq = 1;
    const sdp = buildSdpOffer(localIp, localPort, payloadType);
    const lines = [
        `INVITE ${to} SIP/2.0`,
        `Via: SIP/2.0/UDP ${localIp};branch=${viaBranch}`,
        'Max-Forwards: 70',
        `To: <${to}>`,
        `From: <${from}>;tag=${fromTag}`,
        `Call-ID: ${callId}`,
        `CSeq: ${cseq} INVITE`,
        `Contact: <${contact}>`,
        'Content-Type: application/sdp',
        `Content-Length: ${Buffer.byteLength(sdp)}`,
        '',
        sdp,
    ];
    const req = lines.join('\r\n');

    return await new Promise((resolve, reject) => {
        const socket = net.createConnection({ host, port, timeout: 3000 });
        let buf = '';
        socket.on('connect', () => socket.write(req));
        socket.on('data', (chunk) => {
            buf += chunk.toString();
            if (buf.includes('\r\n\r\n')) {
                const [header, body] = buf.split(/\r\n\r\n/);
                const statusLine = header.split('\r\n')[0] || '';
                if (!statusLine.includes('200')) {
                    reject(new Error(`SIP INVITE failed: ${statusLine}`));
                    socket.destroy();
                    return;
                }
                try {
                    const { remotePort, payloadType: pt, ptimeMs } = parseSdp(body || '');
                    resolve({ remotePort, payloadType: pt, ptimeMs });
                } catch (e) {
                    reject(e);
                }
                socket.destroy();
            }
        });
        socket.on('error', (e) => reject(e));
        socket.on('timeout', () => {
            reject(new Error('SIP INVITE timeout'));
            socket.destroy();
        });
    });
}

async function performSipInviteWithRetry(endpoint: string, localIp: string, localPort: number, payloadType: number, telemetry: MrcpTelemetry): Promise<ReturnType<typeof performSipInvite>> {
    const maxRetries = Number(process.env['MRCP_SIP_INVITE_RETRIES'] || 1); // total attempts = maxRetries
    let attempt = 0;
    let lastErr: any;
    while (attempt < maxRetries) {
        attempt++;
        try {
            telemetry.markSipAttempt();
            const res = await performSipInvite(endpoint, localIp, localPort, payloadType, Number(process.env['MRCP_SIP_INVITE_TIMEOUT_MS'] || 4000));
            if (attempt > 1) {
                telemetry.addInviteRetries(attempt - 1); // count prior failed attempts as retries
            }
            return res;
        } catch (e) {
            const msg = (e as Error).message || '';
            if (msg.includes('timeout')) {
                telemetry.markInviteTimeout();
            }
            lastErr = e;
            if (attempt >= maxRetries) break;
        }
    }
    // record retries count (attempts -1) if >1
    if (attempt > 1) {
        telemetry.addInviteRetries(attempt - 1);
    }
    throw lastErr;
}

export async function openSession(args: OpenSessionArgs): Promise<SignalingSession> {
    const payloadType = args.codec === 'PCMU' ? 0 : 96;
    const emitter = new EventEmitter();
        const errorBuffer: any[] = [];
        const pushErrorBuffer = (ev: any) => {
            errorBuffer.push(ev);
            if (errorBuffer.length > 10) errorBuffer.shift();
        };
    // Ensure that internal error emissions before the caller attaches listeners do not crash the process.
    // Tests can still observe errors by adding their own listener; this default no-op prevents 'unhandled error' exceptions.
    if (emitter.listenerCount('error') === 0) {
        emitter.on('error', (ev) => { pushErrorBuffer(ev); /* default swallow */ });
    }

    const telemetry = new MrcpTelemetry();
    // Attach telemetry hook immediately so early negotiation errors (e.g. fallback 5004) are captured.
    telemetry.hook(emitter);
    // Native binding 사용은 환경변수로 강제 비활성화 가능
    if (nativeBinding && !process.env['MRCP_DISABLE_NATIVE'] && !process.env['MRCP_FORCE_RTSP']) {
        const rtpPortMin = Number(process.env['MRCP_RTP_PORT_MIN'] || 40000);
        const rtpPortMax = Number(process.env['MRCP_RTP_PORT_MAX'] || 40100);
        const info = await nativeBinding.openSession({ ...args, rtpPortMin, rtpPortMax });

        // Bridge native events to JS emitter
        nativeBinding.onEvent(info.handle, (ev) => {
            try {
                if (isMrcpEvent(ev)) {
                    emitter.emit(ev.type, ev);
                }
            } catch (e) {
                emitter.emit('error', { type: 'error', message: 'invalid native event', cause: e });
            }
        });

        telemetry.hook(emitter);
        const close = async () => {
            try {
                await nativeBinding.closeSession(info.handle);
            } catch (e) {
                emitter.emit('error', { type: 'error', message: 'closeSession failed', cause: e });
            }
            emitter.emit('closed', { type: 'closed', reason: 'client-close' });
        };
            return { remoteIp: info.remoteIp, remotePort: info.remotePort, payloadType: info.payloadType, emitter, close, getTelemetry: () => telemetry.snapshot(), getBufferedErrors: () => [...errorBuffer] };
    }

    // Fallback: RTSP DESCRIBE + SETUP (or SIP) negotiation to obtain server RTP port
    const u = new URL(args.endpoint);
    const min = Number(process.env['MRCP_RTP_PORT_MIN'] || 40000);
    const max = Number(process.env['MRCP_RTP_PORT_MAX'] || 40100);
    const localPort = await allocLocalRtpPort(min, max);
    const localIp = '127.0.0.1';

    // SIP (MRCPv2) 경로 우선 시도: 성공 시 RTSP 로직 건너뜀
    if (isSipProfile(args.profileId, args.endpoint)) {
        // Feature flag: try UDP first if enabled
        let sipRes: Awaited<ReturnType<typeof performSipInvite>> | undefined;
        const wantUdp = !!process.env['MRCP_ENABLE_SIP_V2'];
        if (wantUdp) {
            telemetry.markSipAttempt();
            try {
                const udpRes = await performSipInviteUdp({ endpoint: args.endpoint, localIp, localRtpPort: localPort, payloadType });
                // unify shape with TCP result (already similar)
                sipRes = udpRes as any;
                telemetry.markSipSuccess();
            } catch (e) {
                telemetry.markSipFail();
                emitter.emit('error', { type: 'error', code: MrcpErrorCode.SIP_INVITE_FAILED, message: 'SIP UDP INVITE failed – trying TCP', cause: (e as Error).message, profileId: args.profileId });
            }
        }
        if (!sipRes) {
            try {
                const tcpRes = await performSipInviteWithRetry(args.endpoint, localIp, localPort, payloadType, telemetry);
                sipRes = tcpRes as any;
                telemetry.markSipSuccess();
            } catch (e) {
                telemetry.markSipFail();
                emitter.emit('error', { type: 'error', code: MrcpErrorCode.SIP_INVITE_FAILED, message: 'SIP INVITE failed – attempting RTSP fallback', cause: (e as Error).message, profileId: args.profileId });
            }
        }
        if (sipRes) {
            const pt = sipRes.payloadType ?? payloadType;
            const sim = new ResultSimulator(emitter, {
                partialIntervalMs: Number(process.env['MRCP_RESULT_PARTIAL_INTERVAL_MS'] || 1200),
                finalAfterMs: Number(process.env['MRCP_RESULT_FINAL_AFTER_MS'] || 7000),
                textPool: (process.env['MRCP_RESULT_TEXT'] || 'hello world,quick test,audio hook demo').split(/[,;]/).map(s => s.trim()).filter(Boolean),
            });
            telemetry.hook(emitter);
            sim.start();
            if (sipRes.dialog) {
                sendSipAck(localIp, sipRes.dialog);
            }
            const close = () => {
                try { if (sipRes!.dialog) sendSipBye(localIp, sipRes!.dialog); } catch { /* ignore */ }
                sim.stop();
                emitter.emit('closed', { type: 'closed', reason: 'skeleton-close' });
            };
            telemetry.markSessionTransport('sip');
            return { remoteIp: new URL(args.endpoint).hostname, remotePort: sipRes.remotePort, payloadType: pt, emitter, close, ptimeMs: sipRes.ptimeMs, transport: 'sip', getTelemetry: () => telemetry.snapshot(), getBufferedErrors: () => [...errorBuffer] };
        }
        // else fall through to RTSP
    }

    try {
        // 1) DESCRIBE로 SDP 획득
        let desc;
        try {
            telemetry.markRtspDescribeAttempt();
            desc = await rtspDescribeWithRetry(u);
        } catch (e) {
            telemetry.markRtspDescribeFail();
            emitter.emit('error', { type: 'error', code: MrcpErrorCode.RTSP_DESCRIBE_FAILED, message: 'RTSP DESCRIBE failed', cause: (e as Error).message });
            throw e; // 상위 catch -> fallback 5004
        }
        const sdpPort = desc.remotePort; // SDP 내 m=audio 포트 (SETUP 전이므로 server_port와 다를 수 있음)
        const agreedPtime = desc.ptimeMs;

        // 2) SETUP으로 server_port 획득
        let remotePort = sdpPort;
        try {
            telemetry.markRtspSetupAttempt();
            const setupAns = await rtspSetupWithRetry(u, localPort);
            remotePort = setupAns.remotePort;
        } catch (e) {
            telemetry.markRtspSetupFail();
            emitter.emit('error', { type: 'error', code: MrcpErrorCode.RTSP_SETUP_FAILED, message: 'RTSP SETUP failed, using SDP port', cause: (e as Error).message });
        }

        const pt = desc.payloadType ?? payloadType;
        const sim = new ResultSimulator(emitter, {
            partialIntervalMs: Number(process.env['MRCP_RESULT_PARTIAL_INTERVAL_MS'] || 1200),
            finalAfterMs: Number(process.env['MRCP_RESULT_FINAL_AFTER_MS'] || 7000),
            textPool: (process.env['MRCP_RESULT_TEXT'] || 'hello world,quick test,audio hook demo').split(/[,;]/).map(s => s.trim()).filter(Boolean),
        });
        telemetry.hook(emitter);
        sim.start();
        let rtpListen: dgram.Socket | null = null;
        let localRtpPort: number | undefined;
        if (process.env['MRCP_ENABLE_RTP_LISTEN']) {
            // Bind a UDP socket to observe inbound RTP (best-effort)
            try {
                rtpListen = dgram.createSocket('udp4');
                await new Promise<void>((resolve, reject) => {
                    rtpListen!.once('error', reject);
                    rtpListen!.bind(0, '0.0.0.0', () => {
                        localRtpPort = (rtpListen!.address() as any).port;
                        resolve();
                    });
                });
                rtpListen.on('message', (msg) => {
                    // Very light validation: RTP header V=2
                    if (msg.length >= 12 && (msg[0] >> 6) === 2) {
                        emitter.emit('rtp-packet', { bytes: msg.length });
                    }
                });
            } catch (e) {
                emitter.emit('error', { type: 'error', message: 'rtp-listen failed', cause: (e as Error).message });
                try { rtpListen?.close(); } catch { /* ignore */ }
                rtpListen = null;
            }
        }

        const close = () => {
            sim.stop();
            try { rtpListen?.close(); } catch { /* ignore */ }
            rtpListen = null;
            emitter.emit('closed', { type: 'closed', reason: 'skeleton-close' });
        };
        telemetry.markSessionTransport('rtsp');
        return { remoteIp: u.hostname, remotePort, payloadType: pt, emitter, close, ptimeMs: agreedPtime, transport: 'rtsp', localPort: localRtpPort, getTelemetry: () => telemetry.snapshot(), getBufferedErrors: () => [...errorBuffer] };
    } catch (e) {
        if (process.env['MRCP_DISABLE_FALLBACK5004']) {
            // 사용자가 명시적으로 fallback 비활성화: 에러 throw
            throw new Error(`RTSP negotiation failed (fallback disabled): ${(e as Error).message}`);
        }
        // 최종 폴백: 기본 포트 5004 사용
        const remotePort = 5004;
        telemetry.markFallback5004();
        emitter.emit('error', { type: 'error', code: MrcpErrorCode.RTSP_FALLBACK_5004, message: 'RTSP negotiation failed, fallback to default 5004', cause: (e as Error).message });
        const timer = setTimeout(() => {
            emitter.emit('result', { type: 'result', text: 'demo transcript (fallback-5004)' });
        }, 6000);
        const close = () => {
            clearTimeout(timer);
            emitter.emit('closed', { type: 'closed', reason: 'skeleton-close' });
        };
        telemetry.markSessionTransport('rtsp');
        return { remoteIp: u.hostname, remotePort, payloadType, emitter, close, transport: 'rtsp', getTelemetry: () => telemetry.snapshot(), getBufferedErrors: () => [...errorBuffer] };
    }
}

// Named exports (CommonJS interop handled by TS compiler config)
export default { openSession };
