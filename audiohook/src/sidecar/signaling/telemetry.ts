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
  endedAt?: number;
  sessionDurationMs?: number;
  resultEventsTotal: number;
  resultTextBytes: number;
  inviteRetries?: number;
  inviteTimeouts?: number;
  sipAttempts: number; // aggregate (udp+tcp)
  sipSuccess: number;  // aggregate
  sipFail: number;     // aggregate
  // v2: protocol-split counters (optional for backward compat; only emitted if >0)
  sipUdpAttempts?: number;
  sipUdpSuccess?: number;
  sipUdpFail?: number;
  sipTcpAttempts?: number;
  sipTcpSuccess?: number;
  sipTcpFail?: number;
  rtspDescribeAttempts: number;
  rtspDescribeFail: number;
  rtspSetupAttempts: number;
  rtspSetupFail: number;
  fallback5004Count: number;
  sessionsSip: number;
  sessionsRtsp: number;
  sessionsClosed: number;
  lastErrorCode?: string;
  rtpPacketsReceived?: number;
  // --- Phase1/2 planned extensions (placeholders; may be undefined until implemented) ---
  sipProvisional?: number;
  sipInviteRetransmits?: number;
  sipInviteRttMsSum?: number;
  sipInviteRttMsCount?: number;
  averageInviteRttMs?: number; // derived (sum/count)
  sipCodecOffered?: number;
  sipCodecSelected?: string;
  sessionsMrcpChannel?: number;
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
  // aggregate totals (remain for backward compatibility)
  private sipAttempts = 0;
  private sipSuccess = 0;
  private sipFail = 0;
  // split counters (v2)
  private sipUdpAttempts = 0;
  private sipUdpSuccess = 0;
  private sipUdpFail = 0;
  private sipTcpAttempts = 0;
  private sipTcpSuccess = 0;
  private sipTcpFail = 0;
  private rtspDescribeAttempts = 0;
  private rtspDescribeFail = 0;
  private rtspSetupAttempts = 0;
  private rtspSetupFail = 0;
  private fallback5004Count = 0;
  private sessionsSip = 0;
  private sessionsRtsp = 0;
  private sessionsClosed = 0;
  private lastErrorCode: string | undefined;
  private inviteRetries = 0;
  private inviteTimeouts = 0;
  private rtpPacketsReceived = 0;
  private attached = false;
  private endedAt: number | undefined;
  // ---- Phase1/2 planned counters (stubs) ----
  // Phase1 TODO: wire sipProvisional, sipInviteRetransmits, sipInviteRttMs*, sipCodecOffered/Selected when SIP transaction layer lands.
  // Phase2 TODO: sessionsMrcpChannel increment after real MRCP channel open; MRCP metrics (recognizeRequests, completeEvents) to be added.
  private sipProvisional = 0; // 1xx responses
  private sipInviteRetransmits = 0;
  private sipInviteRttMsSum = 0;
  private sipInviteRttMsCount = 0;
  private sipCodecOffered = 0;
  private sipCodecSelected: string | undefined;
  private sessionsMrcpChannel = 0;

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
  markSessionClosed() {
    if (!this.endedAt) {
      this.sessionsClosed++;
      this.endedAt = Date.now();
      // debug
      try { if (process.env['MRCP_TEST_DEBUG']) console.log('[telemetry] markSessionClosed endedAt=', this.endedAt); } catch { /* ignore */ }
    } else {
      try { if (process.env['MRCP_TEST_DEBUG']) console.log('[telemetry] markSessionClosed ignored (already set)'); } catch { /* ignore */ }
    }
  }
  markFallback5004() { this.fallback5004Count++; }
  markSipAttempt(kind: 'udp' | 'tcp') {
    this.sipAttempts++;
    if (kind === 'udp') this.sipUdpAttempts++; else this.sipTcpAttempts++;
  }
  markSipSuccess(kind: 'udp' | 'tcp') {
    this.sipSuccess++;
    if (kind === 'udp') this.sipUdpSuccess++; else this.sipTcpSuccess++;
  }
  markSipFail(kind: 'udp' | 'tcp') {
    this.sipFail++;
    if (kind === 'udp') this.sipUdpFail++; else this.sipTcpFail++;
  }
  markRtspDescribeAttempt() { this.rtspDescribeAttempts++; }
  markRtspDescribeFail() { this.rtspDescribeFail++; }
  markRtspSetupAttempt() { this.rtspSetupAttempts++; }
  markRtspSetupFail() { this.rtspSetupFail++; }
  addInviteRetries(n: number) { if (n>0) this.inviteRetries += n; }
  markInviteTimeout() { this.inviteTimeouts++; }
  // ---- Phase1/2 planned mutators (no-ops until wired) ----
  markSipProvisional() { this.sipProvisional++; }
  markSipInviteRetransmit() { this.sipInviteRetransmits++; }
  addSipInviteRtt(ms: number) { if (ms>=0 && Number.isFinite(ms)) { this.sipInviteRttMsSum += ms; this.sipInviteRttMsCount++; } }
  setSipCodecOffered(count: number) { if (count>0) this.sipCodecOffered = count; }
  setSipCodecSelected(codec: string) { if (codec) this.sipCodecSelected = codec; }
  incrementMrcpChannelSessions() { this.sessionsMrcpChannel++; }

  snapshot(): MrcpTelemetrySnapshot {
    return {
      version: 2,
      partialCount: this.partialCount,
      finalCount: this.finalCount,
      errorCount: this.errorCount,
      lastFinalLatencyMs: this.lastFinalLatencyMs,
      startedAt: this.startedAt,
    endedAt: this.endedAt,
    sessionDurationMs: this.endedAt ? (this.endedAt - this.startedAt) : undefined,
  resultEventsTotal: this.resultEventsTotal,
  resultTextBytes: this.resultTextBytes,
  inviteRetries: this.inviteRetries || undefined,
  inviteTimeouts: this.inviteTimeouts || undefined,
      sipAttempts: this.sipAttempts,
      sipSuccess: this.sipSuccess,
      sipFail: this.sipFail,
      sipUdpAttempts: this.sipUdpAttempts || undefined,
      sipUdpSuccess: this.sipUdpSuccess || undefined,
      sipUdpFail: this.sipUdpFail || undefined,
      sipTcpAttempts: this.sipTcpAttempts || undefined,
      sipTcpSuccess: this.sipTcpSuccess || undefined,
      sipTcpFail: this.sipTcpFail || undefined,
      rtspDescribeAttempts: this.rtspDescribeAttempts,
      rtspDescribeFail: this.rtspDescribeFail,
      rtspSetupAttempts: this.rtspSetupAttempts,
      rtspSetupFail: this.rtspSetupFail,
      fallback5004Count: this.fallback5004Count,
      sessionsSip: this.sessionsSip,
      sessionsRtsp: this.sessionsRtsp,
  sessionsClosed: this.sessionsClosed,
      lastErrorCode: this.lastErrorCode,
      rtpPacketsReceived: this.rtpPacketsReceived || undefined,
      sipProvisional: this.sipProvisional || undefined,
      sipInviteRetransmits: this.sipInviteRetransmits || undefined,
      sipInviteRttMsSum: this.sipInviteRttMsSum || undefined,
      sipInviteRttMsCount: this.sipInviteRttMsCount || undefined,
  averageInviteRttMs: (this.sipInviteRttMsCount > 0 ? Math.round(this.sipInviteRttMsSum / this.sipInviteRttMsCount) : undefined),
      sipCodecOffered: this.sipCodecOffered || undefined,
      sipCodecSelected: this.sipCodecSelected,
      sessionsMrcpChannel: this.sessionsMrcpChannel || undefined,
    };
  }
}
