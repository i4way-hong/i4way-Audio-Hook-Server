/*
 Example signaling module for MRCP sidecar.
 Configure .env:
  - MRCP_SIDECAR_SIGNALING=module
  - MRCP_SIDECAR_SIGNALING_MODULE=./audiohook/src/sidecar/signaling/module-example
 Replace the logic with real UniMRCP SDK integration.
*/
import { EventEmitter } from 'events';

// Keep the minimal shape server.ts expects
type OpenSessionArgs = {
  endpoint: string;
  profileId: string;
  codec: string;
  sampleRate: number;
  language?: string;
};

type SignalingSession = {
  remoteIp: string;
  remotePort: number;
  payloadType: number;
  emitter: EventEmitter;
  close: () => void;
};

async function openSession(args: OpenSessionArgs): Promise<SignalingSession> {
  const { endpoint, profileId, codec } = args;
  const u = new URL(endpoint);
  const payloadType = codec === 'PCMU' ? 0 : 96;

  // TODO: Replace with RTSP(SDP)/SIP(SDP) negotiation using UniMRCP
  const remoteIp = process.env.MRCP_REMOTE_RTP_IP || u.hostname;
  const remotePort = Number(process.env.MRCP_REMOTE_RTP_PORT || 5004);

  const emitter = new EventEmitter();
  const timer = setTimeout(() => {
    emitter.emit('result', { type: 'result', text: `demo result via module(${profileId})` });
  }, 5000);

  const close = () => {
    clearTimeout(timer);
    emitter.emit('closed', { type: 'closed', reason: 'module-close' });
  };

  return { remoteIp, remotePort, payloadType, emitter, close };
}

export = { openSession };
