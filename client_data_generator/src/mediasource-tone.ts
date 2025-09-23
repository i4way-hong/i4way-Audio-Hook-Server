import { EventEmitter } from 'events';
import {
    MediaChannels,
    MediaParameter,
    MediaParameters,
    MediaRate,
    MediaSource,
    MediaSourceState,
    OnMediaSourceAudioHandler,
    OnMediaSourceClosedHandler,
    OnMediaSourceDiscardedHandler,
    OnMediaSourceEndHandler,
    OnMediaSourceErrorHandler,
    OnMediaSourcePausedHandler,
    OnMediaSourceResumedHandler,
    StreamDuration,
} from '../../audiohook';
import { ulawFromL16 } from '../../audiohook';

// 200ms tone frames at 8kHz sample rate in u-law
const toneFrameDurationMs = 200;
const TONE_SAMPLE_RATE = 8000 as const;

// 동적 프레임 생성: startSample부터 count 샘플 생성, 채널 수에 따라 인터리브된 PCMU 프레임 반환
function makeUlawToneFrame(startSample: number, count: number, channels: number): Uint8Array {
    const RATE = TONE_SAMPLE_RATE;
    const AMP = 10000;
    if (channels <= 1) {
        const l16 = new Int16Array(count);
        const w1 = 2 * Math.PI * 1000 / RATE; // 1 kHz
        for (let i = 0; i < count; i++) {
            const n = startSample + i;
            l16[i] = Math.round(AMP * Math.sin(w1 * n));
        }
        return ulawFromL16(l16);
    }
    // 스테레오: CH0=1kHz 연속, CH1=1.6kHz 비프(400ms 주기, 50% duty)
    const ch0 = new Int16Array(count);
    const ch1 = new Int16Array(count);
    const w0 = 2 * Math.PI * 1000 / RATE;  // 1 kHz
    const w1 = 2 * Math.PI * 2600 / RATE;  // 2.6 kHz
    const gatePeriod = Math.round(0.4 * RATE); // 400ms
    for (let i = 0; i < count; i++) {
        const n = startSample + i;
        ch0[i] = Math.round(AMP * Math.sin(w0 * n));
        const gated = (Math.floor(n / gatePeriod) % 2) === 0; // on/off
        ch1[i] = gated ? Math.round(AMP * Math.sin(w1 * n)) : 0;
    }
    const u0 = ulawFromL16(ch0);
    const u1 = ulawFromL16(ch1);
    const out = new Uint8Array(count * 2);
    for (let i = 0, s = 0; i < count; i++, s += 2) {
        out[s] = u0[i];
        out[s + 1] = u1[i];
    }
    return out;
}

class MediaSourceTone1kHz extends EventEmitter implements MediaSource {
    readonly offeredMedia: MediaParameters;
    selectedMedia: MediaParameter | null = null;
    state: MediaSourceState = 'PREPARING';
    private sampleRate: MediaRate = 8000;
    private samplePos = 0;
    private pauseStartPos = 0;
    private audioTimer: NodeJS.Timeout | null = null;
    private frameDurationMs: number;
    private readonly sampleEndPos: number;

    constructor(maxDuration?: StreamDuration, customMedia?: MediaParameters) {
        super();
        const channels: MediaChannels[] = [['external', 'internal'], ['external'], ['internal']];
        this.offeredMedia = (customMedia) ? customMedia : channels.map(channels => ({ type: 'audio', format: 'PCMU', channels, rate: this.sampleRate }));
        this.frameDurationMs = toneFrameDurationMs;
        this.sampleEndPos = Math.trunc((maxDuration?.seconds ?? 7*24*3600) * this.sampleRate);
    }

    startStreaming(selectedMedia: MediaParameter | null, discardTo?: StreamDuration, startPaused?: boolean): void {
        if(this.state !== 'PREPARING') {
            throw new Error(`Cannot start stream in state '${this.state}'`);
        }
        if(this.audioTimer) {
            clearInterval(this.audioTimer);
        }
        this.selectedMedia = selectedMedia;

        if(discardTo) {
            const samplesPerFrame = Math.trunc(this.frameDurationMs*this.sampleRate/1000);
            const newSamplePosRaw = Math.round(discardTo.seconds*this.sampleRate);
            let newSamplePos = Math.floor(newSamplePosRaw/samplesPerFrame)*samplesPerFrame;
            newSamplePos = Math.min(this.sampleEndPos, newSamplePos);
            if(this.samplePos < newSamplePos) {
                const start = StreamDuration.fromSamples(this.samplePos, this.sampleRate);
                const discarded = StreamDuration.fromSamples(newSamplePos - this.samplePos, this.sampleRate);
                this.samplePos = newSamplePos;
                this.state = 'DISCARDING';
                this.emit('discarded', start, discarded);
            }
        }

        if(startPaused) {
            this.state = 'PAUSED';
            this.pauseStartPos = this.samplePos;
            this.emit('paused');
        } else {
            this.state = 'STREAMING';
        }

        this._startStreamTimer();
    }
    private _startStreamTimer(): void {
        // Note: We run the timer even if we're paused, but don't emit the audio frames
        let handler: () => void;
        const samplesPerFrame = Math.trunc((this.frameDurationMs*this.sampleRate)/1000);
        if(this.selectedMedia) {
            const channels = this.selectedMedia.channels.length;
            handler = () => {
                const sampleCount = Math.min(this.sampleEndPos - this.samplePos, samplesPerFrame);
                if(this.state === 'STREAMING') {
                    if(sampleCount > 0) {
                        const frame = makeUlawToneFrame(this.samplePos, sampleCount, channels);
                        this.emit('audio', frame);
                    }
                }
                this.samplePos += sampleCount;
                if(this.samplePos >= this.sampleEndPos) {
                    this._signalEnd();
                }
            };
        } else {
            handler = () => {
                this.samplePos = Math.min(this.samplePos + samplesPerFrame, this.sampleEndPos);
                if(this.samplePos >= this.sampleEndPos) {
                    this._signalEnd();
                }
            };
        }
        setImmediate(handler);
        this.audioTimer = setInterval(handler, this.frameDurationMs);
    }

    private _signalEnd(): void {
        if(this.audioTimer) {
            clearInterval(this.audioTimer);
            this.audioTimer = null;
        }
        if((this.state !== 'END') && (this.state !== 'CLOSED')) { 
            this.state = 'END';
            this.emit('end', StreamDuration.fromSamples(this.samplePos, this.sampleRate));
        }
    }

    async close(): Promise<void> {
        if (this.audioTimer) {
            this._signalEnd();
        }
        if(this.state !== 'CLOSED') {
            this.state = 'CLOSED';
            this.emit('closed');
        }
        this.removeAllListeners();
    }

    pause(): void {
        if(this.state === 'PAUSED') {
            this.emit('paused');
        } else if(this.state === 'STREAMING') {
            this.state = 'PAUSED';
            this.pauseStartPos = this.samplePos;
            this.emit('paused');
        }
    }

    resume(): void {
        if(this.state === 'PAUSED') {
            this.state = 'STREAMING';
            const start = StreamDuration.fromSamples(this.pauseStartPos, this.sampleRate);
            const discarded = StreamDuration.fromSamples(this.samplePos - this.pauseStartPos, this.sampleRate);
            this.emit('resumed', start, discarded);
        } else if(this.state === 'STREAMING') {
            this.emit('resumed', this.position, StreamDuration.zero);
        }
    }

    get position(): StreamDuration {
        return StreamDuration.fromSamples(this.samplePos, this.sampleRate);
    }

    override emit(eventName: 'audio', ...args: Parameters<OmitThisParameter<OnMediaSourceAudioHandler>>): boolean;
    override emit(eventName: 'discarded', ...args: Parameters<OmitThisParameter<OnMediaSourceDiscardedHandler>>): boolean;
    override emit(eventName: 'paused', ...args: Parameters<OmitThisParameter<OnMediaSourcePausedHandler>>): boolean;
    override emit(eventName: 'resumed', ...args: Parameters<OmitThisParameter<OnMediaSourceResumedHandler>>): boolean;
    override emit(eventName: 'end', ...args: Parameters<OmitThisParameter<OnMediaSourceEndHandler>>): boolean;
    override emit(eventName: 'error', ...args: Parameters<OmitThisParameter<OnMediaSourceErrorHandler>>): boolean;
    override emit(eventName: 'closed', ...args: Parameters<OmitThisParameter<OnMediaSourceClosedHandler>>): boolean;
    override emit(eventName: string, ...args: unknown[]): boolean {
        return super.emit(eventName, ...args);
    }
}

export const createToneMediaSource = (maxDuration?: StreamDuration, customMedia?: MediaParameters): MediaSource => {
    return new MediaSourceTone1kHz(maxDuration, customMedia);
};
