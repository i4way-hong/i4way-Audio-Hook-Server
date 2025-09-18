// filepath: app/audiohook/test/stt/resample-matrix.test.ts
import { WebSocketServer } from 'ws';
import { createSttForwarder } from '../../src/server/stt-forwarder';
import sttConfig from '../../src/utils/stt-config';
import type { Logger } from '../../src/utils/logger';
import { createAudioFrame } from '../../src/audio';
import type { MediaDataFrame } from '../../src/server/mediadata';
import type { MediaChannel } from '../../src/protocol';

function createTestLogger(): Logger {
    return { fatal: () => undefined, error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined, trace: () => undefined };
}

describe('STT WS Resample Matrix', () => {
    let wss: WebSocketServer;
    let url = '';
    let received: Buffer[];

    beforeAll((done) => {
        received = [];
        wss = new WebSocketServer({ port: 0 }, () => {
            const addr = wss.address();
            if (typeof addr === 'object' && addr) {
                url = `ws://127.0.0.1:${addr.port}`;
            } else {
                throw new Error('No address for WSS');
            }
            done();
        });
        wss.on('connection', (ws) => {
            ws.on('message', (data, isBinary) => {
                if (!isBinary) {
                    return;
                }
                const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                received.push(Buffer.from(buf));
            });
        });
    });

    afterAll((done) => {
        wss.close(() => done());
    });

    test('L16 resample mono 16k -> 8k', async () => {
        received = [];
        type SttCfgOverride = { applyOverrides: (p: Partial<import('../../src/utils/stt-config').SttConfigState>) => () => void };
        const restore = (sttConfig as unknown as SttCfgOverride).applyOverrides({
            endpoint: url,
            enabled: true,
            protocol: 'websocket',
            encoding: 'L16',
            rate: 8000,
            mono: true,
            wsInitJson: null,
            resampleEnabled: true,
        });
        const logger = createTestLogger();
        const fwd = createSttForwarder('websocket', logger);
        await fwd.start();

        const channels: readonly MediaChannel[] = ['external'];
        const samples = new Int16Array(1600); // 100ms at 16k mono
        for (let i = 0; i < samples.length; i++) {
            samples[i] = (i % 128) - 64;
        }
        const frame = createAudioFrame(samples, { format: 'L16', rate: 16000, channels });
        const mdFrame = frame as unknown as MediaDataFrame;

        fwd.send(mdFrame);
        await new Promise((r) => setTimeout(r, 100));
        await fwd.stop();
        restore();

        const total = Buffer.concat(received);
        // Expect 100ms at 8k mono => 800 samples * 2 bytes
        expect(total.length).toBe(800 * 2);
    }, 10000);

    test('L16 resample stereo 8k -> 16k with mono=true (channel-0 selected)', async () => {
        received = [];
        type SttCfgOverride = { applyOverrides: (p: Partial<import('../../src/utils/stt-config').SttConfigState>) => () => void };
        const restore = (sttConfig as unknown as SttCfgOverride).applyOverrides({
            endpoint: url,
            enabled: true,
            protocol: 'websocket',
            encoding: 'L16',
            rate: 16000,
            mono: true,
            wsInitJson: null,
            resampleEnabled: true,
        });
        const logger = createTestLogger();
        const fwd = createSttForwarder('websocket', logger);
        await fwd.start();

        // Use valid MediaChannel names to represent two channels
        const channels: readonly MediaChannel[] = ['external', 'internal'];
        // 100ms at 8k stereo => 1600 interleaved samples
        const frames = 800; // per channel
        const samples = new Int16Array(frames * 2);
        for (let i = 0; i < frames; i++) {
            samples[i * 2 + 0] = 1000; // ch0 (external)
            samples[i * 2 + 1] = -2000; // ch1 (internal)
        }
        const frame = createAudioFrame(samples, { format: 'L16', rate: 8000, channels });
        const mdFrame = frame as unknown as MediaDataFrame;

        fwd.send(mdFrame);
        await new Promise((r) => setTimeout(r, 100));
        await fwd.stop();
        restore();

        const total = Buffer.concat(received);
        // mono=true selects channel 0 after resample -> 100ms at 16k mono => 1600 samples * 2 bytes
        expect(total.length).toBe(1600 * 2);
    }, 10000);

    test('PCMU encoding with resample 8k -> 16k mono', async () => {
        received = [];
        type SttCfgOverride = { applyOverrides: (p: Partial<import('../../src/utils/stt-config').SttConfigState>) => () => void };
        const restore = (sttConfig as unknown as SttCfgOverride).applyOverrides({
            endpoint: url,
            enabled: true,
            protocol: 'websocket',
            encoding: 'PCMU',
            rate: 16000,
            mono: true,
            wsInitJson: null,
            resampleEnabled: true,
        });
        const logger = createTestLogger();
        const fwd = createSttForwarder('websocket', logger);
        await fwd.start();

        const channels: readonly MediaChannel[] = ['external'];
        const samples = new Int16Array(800); // 100ms at 8k mono
        for (let i = 0; i < samples.length; i++) {
            samples[i] = (i % 128) - 64;
        }
        const frame = createAudioFrame(samples, { format: 'L16', rate: 8000, channels });
        const mdFrame = frame as unknown as MediaDataFrame;

        fwd.send(mdFrame);
        await new Promise((r) => setTimeout(r, 100));
        await fwd.stop();
        restore();

        const total = Buffer.concat(received);
        // PCMU is 1 byte per sample at target rate (16k) for mono
        expect(total.length).toBe(1600);
    }, 10000);
});
