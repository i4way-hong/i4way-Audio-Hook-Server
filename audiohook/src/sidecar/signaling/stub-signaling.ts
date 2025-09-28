import { EventEmitter } from 'events';
import * as net from 'net';

export interface OpenSessionArgs {
  endpoint: string;
  profileId: string;
  codec: string;
  sampleRate: number;
  language?: string;
}

export interface SignalingSession {
  remoteIp: string;
  remotePort: number;
  payloadType: number;
  emitter: EventEmitter;
  close: () => void;
  localPort?: number;
}

export interface MrcpSignaling {
  openSession(args: OpenSessionArgs): Promise<SignalingSession>;
}

export class StubMrcpSignaling implements MrcpSignaling {
  async openSession(args: OpenSessionArgs): Promise<SignalingSession> {
    const { endpoint, profileId, codec } = args;
    const u = new URL(endpoint);
    const isV1 = profileId.includes('v1') || u.protocol.startsWith('rtsp');
    const payloadType = codec === 'PCMU' ? 0 : 96;
    const remoteIp = process.env['MRCP_REMOTE_RTP_IP'] || u.hostname;
    const remotePort = Number(process.env['MRCP_REMOTE_RTP_PORT'] || 5004);
    const ctrlPort = Number(u.port || (isV1 ? 8060 : 5060));
    this.checkControlPort(u.hostname, ctrlPort).catch(() => {/* ignore */});

    const emitter = new EventEmitter();
    const intervalBytes = Number(process.env['MRCP_STUB_RESULT_INTERVAL_BYTES'] || 64000);
    const minIntervalMs = Number(process.env['MRCP_STUB_RESULT_MIN_INTERVAL_MS'] || 2000);
    const maxIntervalMs = Number(process.env['MRCP_STUB_RESULT_MAX_INTERVAL_MS'] || 10000);
    let bytesSinceLast = 0;
    let lastResultTs = Date.now();
    let maxTimer: NodeJS.Timeout | null = null;

    const scheduleMaxTimer = () => {
      if (maxTimer) clearTimeout(maxTimer);
      maxTimer = setTimeout(() => emitResult('timeout'), maxIntervalMs);
    };
    const emitResult = (reason: string) => {
      const now = Date.now();
      const latency = now - lastResultTs;
      emitter.emit('result', { type: 'result', text: `stub transcript (${reason}) bytes=${bytesSinceLast} latencyMs=${latency}` });
      lastResultTs = now;
      bytesSinceLast = 0;
      scheduleMaxTimer();
    };
    scheduleMaxTimer();

    emitter.on('audio-bytes', (n: number) => {
      bytesSinceLast += n;
      const since = Date.now() - lastResultTs;
      if (bytesSinceLast >= intervalBytes && since >= minIntervalMs) {
        emitResult('bytes');
      }
    });

    const close = () => {
      if (maxTimer) clearTimeout(maxTimer);
      emitter.emit('closed', { type: 'closed', reason: 'signaling-close' });
    };
    return { remoteIp, remotePort, payloadType, emitter, close };
  }

  private async checkControlPort(host: string, port: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const s = net.createConnection({ host, port, timeout: 1500 }, () => {
        s.end();
        console.log(`[MRCP] control reachable ${host}:${port}`); // eslint-disable-line no-console
        resolve();
      });
      s.on('error', (e) => {
        console.warn(`[MRCP] control not reachable ${host}:${port} - ${String((e as Error).message)}`); // eslint-disable-line no-console
        resolve();
      });
      s.on('timeout', () => {
        console.warn(`[MRCP] control timeout ${host}:${port}`); // eslint-disable-line no-console
        s.destroy();
        resolve();
      });
    });
  }
}

export function createStubSignaling(): MrcpSignaling { return new StubMrcpSignaling(); }