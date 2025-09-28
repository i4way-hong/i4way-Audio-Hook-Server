import { EventEmitter } from 'events';
import { MrcpResultEvent } from './types';

export interface ResultSimulatorOptions {
  partialIntervalMs: number;
  finalAfterMs: number;
  textPool: string[];
}

export class ResultSimulator {
  private partialTimer: NodeJS.Timeout | null = null;
  private finalTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly startTs = Date.now();
  constructor(private readonly emitter: EventEmitter, private readonly opts: ResultSimulatorOptions) {}

  private pick(): string {
    const { textPool } = this.opts;
    return textPool[Math.floor(Math.random() * textPool.length)] || 'demo';
  }

  start(): void {
    const { partialIntervalMs, finalAfterMs } = this.opts;
    const schedulePartial = () => {
      this.partialTimer = setTimeout(() => {
        if (this.closed) return;
        const ev: MrcpResultEvent = { type: 'result', stage: 'partial', text: this.pick() };
        this.emitter.emit('result', ev);
        schedulePartial();
      }, partialIntervalMs);
    };
    schedulePartial();
    this.finalTimer = setTimeout(() => {
      if (this.closed) return;
      if (this.partialTimer) clearTimeout(this.partialTimer);
      const latency = Date.now() - this.startTs;
      const ev: MrcpResultEvent = { type: 'result', stage: 'final', text: this.pick(), latencyMs: latency };
      this.emitter.emit('result', ev);
    }, finalAfterMs);
  }

  stop(): void {
    this.closed = true;
    if (this.partialTimer) clearTimeout(this.partialTimer);
    if (this.finalTimer) clearTimeout(this.finalTimer);
  }
}
