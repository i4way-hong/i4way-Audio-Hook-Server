import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { MrcpBridge, MrcpSession, MrcpSessionOptions, BridgeEvent } from './types';

class UmcSession implements MrcpSession {
    public options: MrcpSessionOptions;
    private readonly emitter = new EventEmitter();
    private readonly endpoint: URL;
    private readonly chunks: Buffer[] = [];

    constructor(endpoint: string, opts: MrcpSessionOptions) {
        // endpoint 예: rtsp://127.0.0.1:8060/unimrcp
        this.endpoint = new URL(endpoint);
        this.options = opts;
        // 즉시 연결 이벤트 유사 전송
        const rtspEv: BridgeEvent = { type: 'rtsp-connected', remote: `${this.endpoint.host}${this.endpoint.pathname}` };
        this.emitter.emit('rtsp-connected', rtspEv);
        const payloadType = opts.codec === 'PCMU' ? 0 : 96;
        const rtpEv: BridgeEvent = { type: 'rtp-started', localRtpPort: 0, payloadType };
        this.emitter.emit('rtp-started', rtpEv);
    }

    on(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
        this.emitter.on(event, listener);
    }
    once(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
        this.emitter.once(event, listener);
    }
    off(event: BridgeEvent['type'], listener: (ev: BridgeEvent) => void): void {
        this.emitter.off(event, listener);
    }

    sendAudio(payload: Buffer): void {
        this.chunks.push(Buffer.from(payload));
    }

    async close(reason?: string): Promise<void> {
        void reason;
        // WAV 파일 생성 (필요 시 향후 프로필에서 참조)
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'umc-'));
        const wavPath = path.join(tmpDir, `input_${Date.now()}.wav`);
        const data = Buffer.concat(this.chunks);
        const channels = this.options.mono ? 1 : 1; // 현재 포워더는 모노 전송 권장
        writeWav(wavPath, data, this.options.codec, this.options.sampleRate, channels);

        // 인터랙티브 모드: unimrcpclient.exe 사용
        const root = process.env['UNIMRCP_ROOT'];
        const profile = process.env['UMC_PROFILE'] || 'asr-default';
        const logLevel = process.env['UMC_LOG_LEVEL'] || '6';
        const exe = resolveInteractiveClientExe();
        if (!root) {
            const errEv: BridgeEvent = { type: 'error', message: 'UNIMRCP_ROOT is not set. Cannot run unimrcpclient.', cause: null };
            this.emitter.emit('error', errEv);
            const closed: BridgeEvent = { type: 'closed', reason: 'umc-missing-root' };
            this.emitter.emit('closed', closed);
            try {
                fs.unlinkSync(wavPath);
            } catch {
                // ignore
            }
            try {
                fs.rmdirSync(tmpDir);
            } catch {
                // ignore
            }
            return;
        }

        // 참고: UniMRCP 데모는 입력 파일을 프로필/설정에서 정의해야 함. 현재는 연결/동작 확인 목적.
        const args: string[] = ['-r', root];
        const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'] });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => {
            stdout += d.toString();
        });
        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });

        // 인터랙티브 커맨드 전송
        const cmds = [`loglevel ${logLevel}`, `run recog ${profile}`, 'quit'];
        for (const c of cmds) {
            child.stdin.write(c + os.EOL);
        }
        child.stdin.end();

        const exitCode: number = await new Promise((resolve) => {
            child.on('close', (code) => resolve(code ?? -1));
        });

        if (exitCode !== 0) {
            const errEv: BridgeEvent = { type: 'error', message: `unimrcpclient exited with code ${exitCode}`, cause: stderr || stdout };
            this.emitter.emit('error', errEv);
        } else {
            const text = extractTranscript(stdout) || extractTranscript(stderr);
            if (text && !isBanner(text)) {
                const resEv: BridgeEvent = { type: 'result', text };
                this.emitter.emit('result', resEv);
            } else {
                const errEv: BridgeEvent = { type: 'error', message: 'No ASR result found in client output', cause: stdout };
                this.emitter.emit('error', errEv);
            }
        }
        const closed: BridgeEvent = { type: 'closed', reason: 'umc-finished' };
        this.emitter.emit('closed', closed);

        try {
            fs.unlinkSync(wavPath);
        } catch {
            // ignore
        }
        try {
            fs.rmdirSync(tmpDir);
        } catch {
            // ignore
        }
    }
}

export class UmcBridge implements MrcpBridge {
    async connect(endpoint: string, opts: MrcpSessionOptions): Promise<MrcpSession> {
        // endpoint는 client-profiles.xml과 일치해야 함. 여기서는 umc가 profile을 사용하므로 검증만 수행.
        if (!endpoint.startsWith('rtsp://')) {
            throw new Error('UMC bridge requires RTSP endpoint (e.g., rtsp://127.0.0.1:8060/unimrcp)');
        }
        return new UmcSession(endpoint, opts);
    }
}

function resolveInteractiveClientExe(): string {
    const envPath = process.env['UNIMRCP_CLIENT_EXE'] || process.env['UMC_CLIENT_EXE'];
    if (envPath && fs.existsSync(envPath)) {
        return envPath;
    }
    if (process.platform === 'win32') {
        return 'C:/Program Files/UniMRCP/bin/unimrcpclient.exe';
    }
    return '/usr/local/bin/unimrcpclient';
}

function extractTranscript(output: string): string | undefined {
    // UniMRCP 클라이언트 출력에서 간단한 패턴 추출
    const lines = output.split(/\r?\n/);
    for (const ln of lines) {
        const m1 = ln.match(/You said\s*:\s*(.+)$/i);
        if (m1) {
            return m1[1].trim();
        }
        const m2 = ln.match(/RESULT\s*[:=-]\s*(.+)$/i);
        if (m2) {
            return m2[1].trim();
        }
    }
    return undefined;
}

function isBanner(text: string): boolean {
    return /Arsen\s+Chaloyan/i.test(text) || /Licensed under the Apache/i.test(text);
}

function writeWav(filePath: string, raw: Buffer, codec: 'PCMU' | 'L16', sampleRate: number, channels: number): void {
    if (codec === 'PCMU') {
        const fmt = 7; // mu-law
        const bitsPerSample = 8;
        const blockAlign = channels * (bitsPerSample / 8);
        const byteRate = sampleRate * blockAlign;
        const header = buildWavHeader(raw.byteLength, fmt, channels, sampleRate, byteRate, blockAlign, bitsPerSample);
        const out = Buffer.concat([header, raw]);
        fs.writeFileSync(filePath, out);
    } else {
        // PCM16 LE
        const fmt = 1;
        const bitsPerSample = 16;
        const blockAlign = channels * (bitsPerSample / 8);
        const byteRate = sampleRate * blockAlign;
        // 보유한 raw가 이미 little-endian 16bit라 가정
        const header = buildWavHeader(raw.byteLength, fmt, channels, sampleRate, byteRate, blockAlign, bitsPerSample);
        const out = Buffer.concat([header, raw]);
        fs.writeFileSync(filePath, out);
    }
}

function buildWavHeader(dataSize: number, audioFormat: number, channels: number, sampleRate: number, byteRate: number, blockAlign: number, bitsPerSample: number): Buffer {
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); // PCM fmt chunk size
    header.writeUInt16LE(audioFormat, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return header;
}

// default export: 인스턴스
const bridge = new UmcBridge();
export default bridge;
