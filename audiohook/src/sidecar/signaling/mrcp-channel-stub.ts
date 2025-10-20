import { EventEmitter } from 'events';

export interface MrcpChannelStubOptions {
  emit: (ev: any) => void; // underlying session emitter
  latencyMs?: number; // artificial processing latency
}

/**
 * Very small placeholder for an MRCP application channel.
 * Provides send(text) which after a small delay emits a synthetic partial + final result pair.
 * Future Phase2 will replace with actual MRCP message framing over TCP.
 */
export class MrcpChannelStub {
  private closed = false;
  private readonly latencyMs: number;
  constructor(private readonly opts: MrcpChannelStubOptions) {
    this.latencyMs = opts.latencyMs ?? 80;
  }
  send(text: string) {
    if (this.closed) return;
    const now = Date.now();
    // Emit a partial immediately
    this.opts.emit({ type: 'result', stage: 'partial', text: text.slice(0, Math.min(20, text.length)), latencyMs: 0 });
    setTimeout(() => {
      if (this.closed) return;
      const latency = Date.now() - now;
      this.opts.emit({ type: 'result', stage: 'final', text, latencyMs: latency });
    }, this.latencyMs);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    // No dedicated closed event: session close already emits.
  }
  isClosed() { return this.closed; }
}
