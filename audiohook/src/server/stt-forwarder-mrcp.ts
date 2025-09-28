// AudioHook MRCP 포워더 골격 코드(초안)
// 참고: 실제 RTSP/MRCP/RTP 처리는 별도 브릿지 구현체가 담당. 이 파일은 포워더 어댑터만 제공.

import { ulawFromL16 } from '../audio/ulaw';
import { createAudioFrame } from '../audio';
import { resampleL16 } from '../audio/resample';
import type { MediaDataFrame } from './mediadata';
import sttConfig, { SttEncoding } from '../utils/stt-config';
import type { Logger } from '../utils/logger';
import type { MrcpBridge, MrcpSession, MrcpSessionOptions, BridgeEvent } from '../mrcp/types';
import * as path from 'path';

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
    const targetEnc: SttEncoding = sttConfig.encoding;
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

export class MrcpSttForwarder {
    private readonly logger: Logger;
    private readonly bridge: MrcpBridge;
    private session: MrcpSession | null = null;
    private warnedRateMismatch = false;

    constructor(logger: Logger, bridge: MrcpBridge) {
        this.logger = logger;
        this.bridge = bridge;
    }

    async start(): Promise<void> {
        if (this.session) {
            return;
        }
        const ep = sttConfig.endpoint;
        if (!ep) {
            throw new Error('STT endpoint is not configured');
        }
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
        this.session.on('rtp-started', (ev: BridgeEvent) => {
            if (ev.type === 'rtp-started') {
                this.logger.info(`MRCP RTP started pt=${ev.payloadType}`);
            }
        });
        this.session.on('result', (ev: BridgeEvent) => {
            if (ev.type === 'result') {
                this.logger.info(`MRCP result: ${ev.text ?? ''}`);
            }
        });
        this.session.on('closed', (ev: BridgeEvent) => {
            if (ev.type === 'closed') {
                this.logger.warn(`MRCP closed: ${ev.reason ?? ''}`);
            }
        });
        this.session.on('error', (ev: BridgeEvent) => {
            if (ev.type === 'error') {
                this.logger.error(`MRCP error: ${ev.message}`);
            }
        });
    }

    async stop(): Promise<void> {
        const s = this.session;
        if (!s) {
            return;
        }
        try {
            await s.close('forwarder-stop');
        } catch {
            // ignore
        }
        this.session = null;
    }

    send(frame: MediaDataFrame): void {
        const s = this.session;
        if (!s) {
            return;
        }
        const payload = buildPayload(frame, this.logger, { rate: this.warnedRateMismatch });
        this.warnedRateMismatch = true;
        if (payload) {
            s.sendAudio(payload);
        }
    }
}

export function createMrcpBridge(logger: Logger): MrcpBridge {
    const envValue = process.env['STT_MRCP_BRIDGE'];
    if (envValue) {
        // 지원 별칭: sidecar / umc / mock
        const alias: Record<string, string> = {
            sidecar: '../mrcp/bridge-sidecar',
            'bridge-sidecar': '../mrcp/bridge-sidecar',
            umc: '../mrcp/bridge-umc',
            'bridge-umc': '../mrcp/bridge-umc',
            mock: '../mrcp/bridge-mock',
            'bridge-mock': '../mrcp/bridge-mock',
        };

        // 시도 우선순위 목록 구성
        const tried = new Set<string>();
        const candidates: string[] = [];
        const pushUnique = (p?: string) => { if (p && !tried.has(p)) { tried.add(p); candidates.push(p); } };

        pushUnique(envValue);
        pushUnique(alias[envValue]);

        // 상대경로 오입력 보정: './audiohook/src/mrcp/bridge-sidecar' 처럼 현재 파일 기준 중복 prefix 제거
        if (/audiohook[\\/]+src[\\/]+mrcp[\\/]bridge-/.test(envValue) && !envValue.startsWith('..')) {
            // 현재 파일 위치: .../audiohook/src/server -> 상위로 한 단계 올라가 mrcp
            const idx = envValue.lastIndexOf('bridge-');
            if (idx !== -1) {
                const filePart = envValue.substring(envValue.indexOf('bridge-'));
                pushUnique('../mrcp/' + filePart.replace(/\.ts$/, ''));
            }
        }

        // 절대경로 아니고 ./ 로 시작하지 않고 확장자 없는 단순 이름이면 ../mrcp/<name> 추가
        if (!path.isAbsolute(envValue) && !envValue.startsWith('.') && !alias[envValue]) {
            pushUnique(path.join(__dirname, '..', 'mrcp', envValue));
            pushUnique(path.join(__dirname, '..', 'mrcp', `bridge-${envValue}`));
        }

        // 확장자 변형(.ts/.js) 시도
        const extended: string[] = [];
        for (const c of candidates) {
            if (!/\.(ts|js)$/.test(c)) {
                extended.push(c + '.ts', c + '.js');
            }
        }
        for (const e of extended) pushUnique(e);

        for (const modPath of candidates) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const loaded = require(modPath);
                const bridge: MrcpBridge = loaded?.default ?? loaded;
                if (bridge && typeof bridge.connect === 'function') {
                    logger.info(`Using custom MRCP bridge: ${modPath}`);
                    return bridge;
                }
                logger.warn(`STT_MRCP_BRIDGE candidate '${modPath}' did not export a valid bridge`);
            } catch (e) {
                logger.warn(`Failed to load STT_MRCP_BRIDGE candidate '${modPath}': ${(e as Error).message}`);
            }
        }
        logger.warn('All STT_MRCP_BRIDGE candidates failed; falling back to mock');
    }
    // fallback to mock bridge
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { MockMrcpBridge } = require('../mrcp/bridge-mock');
    return new MockMrcpBridge();
}
