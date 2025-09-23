// AudioHook MRCP 포워더 골격 코드(초안)
// 참고: 실제 RTSP/MRCP/RTP 처리는 별도 브릿지 구현체가 담당. 이 파일은 포워더 어댑터만 제공.

import type { Logger } from '../utils/logger';
import type { MediaDataFrame } from './mediadata';
import sttConfig from '../utils/stt-config';
import { createAudioFrame } from '../audio';
import { resampleL16 } from '../audio/resample';
import { ulawFromL16 } from '../audio/ulaw';
import type { MrcpBridge, MrcpSession, MrcpSessionOptions } from '../mrcp/types';

export interface SttForwarderLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  send(frame: MediaDataFrame): void;
}

function buildPayload(frame: MediaDataFrame, logger: Logger, warned: { rate: boolean }): Buffer | null {
  let working: MediaDataFrame = frame;
  if (sttConfig.resampleEnabled && frame.rate !== sttConfig.rate && working.format === 'L16') {
    const chs = working.channels.length;
    const l16 = working.audio.data as Int16Array;
    const res = resampleL16(l16, working.rate, sttConfig.rate, chs);
    working = createAudioFrame(res, {
      format: 'L16',
      rate: sttConfig.rate as typeof frame.rate,
      channels: working.channels,
    }) as unknown as MediaDataFrame;
  } else if (!warned.rate && sttConfig.rate !== frame.rate) {
    warned.rate = true;
    logger.warn(`MRCP: frame rate(${frame.rate}) != configured rate(${sttConfig.rate}). Resampling is ${sttConfig.resampleEnabled ? 'enabled but source not L16' : 'disabled'}; forwarding as-is.`);
  }

  const mono = sttConfig.mono;
  const targetEnc = sttConfig.encoding; // 'L16' | 'PCMU'
  const sourceView = mono ? working.getChannelView(working.channels[0], working.format) : working.audio;

  if (targetEnc === 'PCMU') {
    if (sourceView.format === 'PCMU') {
      return Buffer.from(sourceView.data.buffer, sourceView.data.byteOffset, sourceView.data.byteLength);
    } else {
      const l16 = working.as('L16');
      const enc = ulawFromL16(l16.audio.data as Int16Array);
      return Buffer.from(enc.buffer, enc.byteOffset, enc.byteLength);
    }
  } else {
    const l16 = working.as('L16');
    const view = mono ? l16.getChannelView(working.channels[0], 'L16') : l16.audio;
    const data = view.data as Int16Array;
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  }
}

export class MrcpForwarderAdapter implements SttForwarderLike {
  private readonly logger: Logger;
  private readonly bridge: MrcpBridge;
  private session: MrcpSession | null = null;
  private warnedRateMismatch = false;

  constructor(logger: Logger, bridge: MrcpBridge) {
    this.logger = logger;
    this.bridge = bridge;
  }

  async start(): Promise<void> {
    if (this.session) return;
    const ep = sttConfig.endpoint;
    if (!ep) throw new Error('STT endpoint is not configured');

    const opts: MrcpSessionOptions = {
      resource: 'speechrecog',
      codec: sttConfig.encoding === 'PCMU' ? 'PCMU' : 'L16',
      sampleRate: (sttConfig.rate as 8000 | 16000 | 44100 | 48000),
      mono: !!sttConfig.mono,
      language: process.env['STT_MRCP_LANGUAGE'] || undefined,
      vendorHeaders: undefined,
    };

    this.session = await this.bridge.connect(ep, opts);

    this.session.on('rtsp-connected', () => this.logger.info('MRCP RTSP connected'));
    this.session.on('rtp-started', (ev) => this.logger.info(`MRCP RTP started pt=${(ev as any).payloadType}`));
    this.session.on('result', (ev) => this.logger.info(`MRCP result: ${(ev as any).text ?? ''}`));
    this.session.on('closed', (ev) => this.logger.warn(`MRCP closed: ${(ev as any).reason ?? ''}`));
    this.session.on('error', (ev) => this.logger.error(`MRCP error: ${(ev as any).message}`));
  }

  async stop(): Promise<void> {
    const s = this.session;
    if (!s) return;
    try { await s.close('forwarder-stop'); } catch { /* ignore */ }
    this.session = null;
  }

  send(frame: MediaDataFrame): void {
    const s = this.session;
    if (!s) return;
    const payload = buildPayload(frame, this.logger, { rate: this.warnedRateMismatch });
    this.warnedRateMismatch = true;
    if (payload) s.sendAudio(payload);
  }
}
