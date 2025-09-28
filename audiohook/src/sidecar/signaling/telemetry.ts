/* Simple in-process telemetry collector for MRCP signaling skeleton */
import { EventEmitter } from 'events';
import { MrcpEvent, MrcpResultEvent, MrcpErrorEvent } from './types';

export interface MrcpTelemetrySnapshot {
  version: number;
  partialCount: number;
  finalCount: number;
  errorCount: number;
  lastFinalLatencyMs?: number;
  startedAt: number;
  resultEventsTotal: number;
  resultTextBytes: number;
  inviteRetries?: number;
  inviteTimeouts?: number;
  sipAttempts: number;
  sipSuccess: number;
  sipFail: number;
  rtspDescribeAttempts: number;
  rtspDescribeFail: number;
  rtspSetupAttempts: number;
  rtspSetupFail: number;
  fallback5004Count: number;
  sessionsSip: number;
  sessionsRtsp: number;
  lastErrorCode?: string;
  rtpPacketsReceived?: number;
}

export class MrcpTelemetry {
  private partialCount = 0;
  private finalCount = 0;
  private errorCount = 0;
  private lastFinalLatencyMs: number | undefined;
  private readonly startedAt = Date.now();
  private resultEventsTotal = 0;
  private resultTextBytes = 0;
  // new counters
  private sipAttempts = 0;
  private sipSuccess = 0;
  private sipFail = 0;
  private rtspDescribeAttempts = 0;
  private rtspDescribeFail = 0;
  private rtspSetupAttempts = 0;
  private rtspSetupFail = 0;
  private fallback5004Count = 0;
  private sessionsSip = 0;
  private sessionsRtsp = 0;
  private lastErrorCode: string | undefined;
  private inviteRetries = 0;
  private inviteTimeouts = 0;
  private rtpPacketsReceived = 0;
  private attached = false;

  hook(emitter: EventEmitter): void {
    if (this.attached) return; // prevent double counting
    this.attached = true;
    emitter.on('result', (ev: MrcpEvent) => {
      if (ev.type !== 'result') return;
      const rev = ev as MrcpResultEvent;
      this.resultEventsTotal++;
      if (rev.text) this.resultTextBytes += Buffer.byteLength(rev.text, 'utf8');
      if (rev.stage === 'partial') this.partialCount++;
      if (rev.stage === 'final') {
        this.finalCount++;
        if (typeof rev.latencyMs === 'number') this.lastFinalLatencyMs = rev.latencyMs;
      }
    });
    emitter.on('error', (ev: MrcpEvent) => {
      if (ev.type !== 'error') return;
      this.errorCount++;
      if ((ev as any).code) this.lastErrorCode = (ev as any).code;
    });
    emitter.on('rtp-packet', () => {
      this.rtpPacketsReceived++;
    });
  }

  // Explicit increment helpers (called externally during negotiation phases)
  markSessionTransport(t: 'sip' | 'rtsp') {
    if (t === 'sip') this.sessionsSip++; else this.sessionsRtsp++;
  }
  markFallback5004() { this.fallback5004Count++; }
  markSipAttempt() { this.sipAttempts++; }
  markSipSuccess() { this.sipSuccess++; }
  markSipFail() { this.sipFail++; }
  markRtspDescribeAttempt() { this.rtspDescribeAttempts++; }
  markRtspDescribeFail() { this.rtspDescribeFail++; }
  markRtspSetupAttempt() { this.rtspSetupAttempts++; }
  markRtspSetupFail() { this.rtspSetupFail++; }
  addInviteRetries(n: number) { if (n>0) this.inviteRetries += n; }
  markInviteTimeout() { this.inviteTimeouts++; }

  snapshot(): MrcpTelemetrySnapshot {
    return {
      version: 1,
      partialCount: this.partialCount,
      finalCount: this.finalCount,
      errorCount: this.errorCount,
      lastFinalLatencyMs: this.lastFinalLatencyMs,
      startedAt: this.startedAt,
  resultEventsTotal: this.resultEventsTotal,
  resultTextBytes: this.resultTextBytes,
  inviteRetries: this.inviteRetries || undefined,
  inviteTimeouts: this.inviteTimeouts || undefined,
      sipAttempts: this.sipAttempts,
      sipSuccess: this.sipSuccess,
      sipFail: this.sipFail,
      rtspDescribeAttempts: this.rtspDescribeAttempts,
      rtspDescribeFail: this.rtspDescribeFail,
      rtspSetupAttempts: this.rtspSetupAttempts,
      rtspSetupFail: this.rtspSetupFail,
      fallback5004Count: this.fallback5004Count,
      sessionsSip: this.sessionsSip,
      sessionsRtsp: this.sessionsRtsp,
      lastErrorCode: this.lastErrorCode,
      rtpPacketsReceived: this.rtpPacketsReceived || undefined,
    };
  }
}
