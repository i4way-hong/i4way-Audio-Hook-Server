// UniMRCP signaling shared types
import { EventEmitter } from 'events';

export interface OpenSessionArgs {
  endpoint: string;
  profileId: string; // ah-mrcpv1 | ah-mrcpv2
  codec: string; // PCMU | L16
  sampleRate: number; // 8000 | 16000 ...
  language?: string;
}

export interface SignalingSession {
  remoteIp: string;
  remotePort: number;
  payloadType: number;
  ptimeMs?: number;
  localPort?: number; // optional local RTP port (when we bind a receiver or sender locally)
  emitter: EventEmitter;
  close: () => void;
  transport?: 'sip' | 'rtsp';
  getTelemetry?: () => MrcpTelemetrySnapshot;
  getBufferedErrors?: () => MrcpErrorEvent[];
}

// Event model
export interface MrcpBaseEvent { type: 'result' | 'error' | 'closed'; }
export interface MrcpResultEvent extends MrcpBaseEvent { type: 'result'; stage?: 'partial' | 'final'; text: string; latencyMs?: number; }
export interface MrcpErrorEvent extends MrcpBaseEvent { type: 'error'; code?: string; message: string; cause?: unknown; profileId?: string; }
export interface MrcpClosedEvent extends MrcpBaseEvent { type: 'closed'; reason?: string; }
export type MrcpEvent = MrcpResultEvent | MrcpErrorEvent | MrcpClosedEvent;

export function isMrcpEvent(ev: unknown): ev is MrcpEvent {
  if (!ev || typeof ev !== 'object') return false;
  const t = (ev as any).type;
  return t === 'result' || t === 'error' || t === 'closed';
}

// ---- Error Code Enum ----
// 향후 코드 추가 시 여기서만 정의 후 사용하는 측은 MrcpErrorCode 참조
export enum MrcpErrorCode {
  SIP_NOT_IMPLEMENTED = 'SIP_NOT_IMPLEMENTED',
  SIP_INVITE_FAILED = 'SIP_INVITE_FAILED',
  RTSP_DESCRIBE_FAILED = 'RTSP_DESCRIBE_FAILED',
  RTSP_SETUP_FAILED = 'RTSP_SETUP_FAILED',
  RTSP_FALLBACK_5004 = 'RTSP_FALLBACK_5004',
}

export type KnownMrcpErrorCode = `${MrcpErrorCode}`;

// Forward-declared snapshot interface (sync with telemetry.ts). Duplicated key list kept minimal to avoid circular import.
export interface MrcpTelemetrySnapshot {
  version: number;
  partialCount: number; finalCount: number; errorCount: number; startedAt: number;
  lastFinalLatencyMs?: number; resultEventsTotal: number; resultTextBytes: number; sipAttempts: number; sipSuccess: number; sipFail: number;
  inviteRetries?: number; inviteTimeouts?: number; rtpPacketsReceived?: number;
  rtspDescribeAttempts: number; rtspDescribeFail: number; rtspSetupAttempts: number; rtspSetupFail: number;
  fallback5004Count: number; sessionsSip: number; sessionsRtsp: number; lastErrorCode?: string;
  // future extension fields may appear (use optional chaining when accessing externally)
}

