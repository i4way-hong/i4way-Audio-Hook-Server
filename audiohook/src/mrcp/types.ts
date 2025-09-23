// MRCP Bridge 타입 정의(초안)
// 목적: AudioHook가 내부 포워더에서 사용하기 위한 최소 인터페이스

export type MrcpResource = 'speechrecog' | 'speechsynth';
export type MrcpCodec = 'PCMU' | 'L16';

export interface MrcpSessionOptions {
  resource: MrcpResource;
  codec: MrcpCodec;
  sampleRate: 8000 | 16000 | 44100 | 48000;
  mono: boolean;
  language?: string;
  vendorHeaders?: Record<string, string>;
}

export interface RtspConnectedEvent {
  type: 'rtsp-connected';
  remote: string;
}
export interface RtpStartedEvent {
  type: 'rtp-started';
  localRtpPort: number;
  payloadType: number;
}
export interface AsrResultEvent {
  type: 'result';
  // 구현체별: N-Best JSON, 단문 텍스트 등
  nbest?: unknown;
  text?: string;
  confidences?: number[];
}
export interface BridgeClosedEvent {
  type: 'closed';
  reason?: string;
}
export interface BridgeErrorEvent {
  type: 'error';
  message: string;
  cause?: unknown;
}

export type BridgeEvent =
  | RtspConnectedEvent
  | RtpStartedEvent
  | AsrResultEvent
  | BridgeClosedEvent
  | BridgeErrorEvent;

export interface MrcpSession {
  options: MrcpSessionOptions;
  on(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void;
  once(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void;
  off(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void;
  sendAudio(payload: Buffer, opts?: { rtpTimestamp?: number }): void;
  close(reason?: string): Promise<void>;
}

export interface MrcpBridge {
  connect(endpoint: string, opts: MrcpSessionOptions): Promise<MrcpSession>;
}
