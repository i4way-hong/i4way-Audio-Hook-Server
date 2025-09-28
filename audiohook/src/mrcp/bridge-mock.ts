import { EventEmitter } from 'events';
import type { MrcpBridge, MrcpSession, MrcpSessionOptions, BridgeEvent } from './types';

class MockMrcpSession implements MrcpSession {
  readonly options: MrcpSessionOptions;
  private readonly ee = new EventEmitter();
  private bytes = 0;
  private closed = false;

  constructor(opts: MrcpSessionOptions) {
    this.options = opts;
  }

  on(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
    this.ee.on(event, listener as any);
  }
  once(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
    this.ee.once(event, listener as any);
  }
  off(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
    this.ee.off(event, listener as any);
  }

  startMock(endpoint: string) {
    setTimeout(() => this.ee.emit('rtsp-connected', { type: 'rtsp-connected', remote: endpoint } as BridgeEvent), 50);
    setTimeout(() => this.ee.emit('rtp-started', { type: 'rtp-started', localRtpPort: 40000, payloadType: this.options.codec === 'PCMU' ? 0 : 97 } as BridgeEvent), 120);
  }

  sendAudio(payload: Buffer): void {
    if (this.closed) return;
    this.bytes += payload.length;
    if (this.bytes >= 16000) {
      this.bytes = 0;
      const text = `mock transcript @${Date.now()}`;
      this.ee.emit('result', { type: 'result', text } as BridgeEvent);
    }
  }

  async close(reason?: string): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.ee.emit('closed', { type: 'closed', reason } as BridgeEvent);
  }
}

export class MockMrcpBridge implements MrcpBridge {
  async connect(endpoint: string, opts: MrcpSessionOptions): Promise<MrcpSession> {
    const s = new MockMrcpSession(opts);
    s.startMock(endpoint);
    return s;
  }
}
