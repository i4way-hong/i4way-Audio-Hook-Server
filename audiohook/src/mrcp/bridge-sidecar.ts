import { EventEmitter } from 'events';
import WebSocket from 'ws';
import * as os from 'os';
import type { MrcpBridge, MrcpSession, MrcpSessionOptions, BridgeEvent } from './types';

interface SidecarInitMessage {
    type: 'init';
    endpoint: string; // e.g., rtsp://host:port/unimrcp (v1) or sip 서버 힌트
    profileId: string; // ah-mrcpv1 | ah-mrcpv2 | custom
    resource: MrcpSessionOptions['resource'];
    codec: MrcpSessionOptions['codec'];
    sampleRate: MrcpSessionOptions['sampleRate'];
    mono: boolean;
    language?: string;
    vendorHeaders?: Record<string, string>;
}

interface SidecarByeMessage {
    type: 'bye';
    reason?: string;
}

type SidecarEvent =
    | { type: 'rtsp-connected'; remote: string }
    | { type: 'rtp-started'; localRtpPort: number; payloadType: number }
    | { type: 'result'; text?: string; nbest?: unknown; confidences?: number[] }
    | { type: 'error'; message: string; cause?: unknown }
    | { type: 'closed'; reason?: string };

class SidecarSession implements MrcpSession {
    public options: MrcpSessionOptions;
    private readonly emitter = new EventEmitter();
    private readonly ws: WebSocket;
    private readonly sendQueue: Array<Buffer | string> = [];
    private isOpen = false;

    constructor(private endpoint: string, opts: MrcpSessionOptions, url: string, profileId: string) {
        this.options = opts;
        this.ws = new WebSocket(url);

        this.ws.on('open', () => {
            this.isOpen = true;
            const init: SidecarInitMessage = {
                type: 'init',
                endpoint: this.endpoint,
                profileId,
                resource: opts.resource,
                codec: opts.codec,
                sampleRate: opts.sampleRate,
                mono: opts.mono,
                language: opts.language,
                vendorHeaders: opts.vendorHeaders,
            };
            this.ws.send(JSON.stringify(init));
            // 큐 비움
            for (const msg of this.sendQueue.splice(0)) {
                this.ws.send(msg);
            }
        });

        this.ws.on('message', (data, isBinary) => {
            try {
                if (isBinary) {
                    // 향후 바이너리 이벤트가 필요하면 처리
                    return;
                }
                const evt = JSON.parse(data.toString()) as SidecarEvent;
                this.forward(evt);
            } catch (e) {
                const errEv: BridgeEvent = { type: 'error', message: 'Invalid message from sidecar', cause: e };
                this.emitter.emit('error', errEv);
            }
        });

        this.ws.on('error', (err) => {
            const errEv: BridgeEvent = { type: 'error', message: 'Sidecar socket error', cause: err };
            this.emitter.emit('error', errEv);
        });

        this.ws.on('close', () => {
            const closed: BridgeEvent = { type: 'closed', reason: 'sidecar-closed' };
            this.emitter.emit('closed', closed);
        });
    }

    private forward(evt: SidecarEvent) {
        switch (evt.type) {
            case 'rtsp-connected':
            case 'rtp-started':
            case 'result':
            case 'closed':
                this.emitter.emit(evt.type, evt as unknown as BridgeEvent);
                break;
            case 'error': {
                const errEv: BridgeEvent = { type: 'error', message: evt.message, cause: evt.cause };
                this.emitter.emit('error', errEv);
                break;
            }
        }
    }

    on(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
        this.emitter.on(event, listener);
    }
    once(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
        this.emitter.once(event, listener);
    }
    off(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
        this.emitter.off(event, listener);
    }

    sendAudio(payload: Buffer): void {
        // 바이너리 프레임으로 직접 전송
        if (this.isOpen && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(payload);
        } else {
            this.sendQueue.push(payload);
        }
    }

    async close(reason?: string): Promise<void> {
        const bye: SidecarByeMessage = { type: 'bye', reason };
        const text = JSON.stringify(bye) + os.EOL;
        if (this.isOpen && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(text);
            this.ws.close();
        } else {
            this.sendQueue.push(text);
            try {
                this.ws.close();
            } catch (e) {
                // ignore
            }
        }
    }
}

export class SidecarBridge implements MrcpBridge {
    async connect(endpoint: string, opts: MrcpSessionOptions): Promise<MrcpSession> {
        const url = process.env['MRCP_SIDECAR_URL'] || 'ws://127.0.0.1:9090/mrcp';
        const profileId = process.env['STT_MRCP_PROFILE'] || 'ah-mrcpv1';
        return new SidecarSession(endpoint, opts, url, profileId);
    }
}

// default export: 인스턴스
const bridge = new SidecarBridge();
export default bridge;
