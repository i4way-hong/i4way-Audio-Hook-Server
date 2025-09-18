import { WebSocketServer } from 'ws';
import { createSttForwarder } from '../../src/server/stt-forwarder';
import sttConfig from '../../src/utils/stt-config';
import type { Logger } from '../../src/utils/logger';
import { createAudioFrame } from '../../src/audio';
import type { MediaDataFrame } from '../../src/server/mediadata';
import type { MediaChannel } from '../../src/protocol';

function createTestLogger(): Logger {
    const log: Logger = {
        fatal: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
    };
    return log;
}

describe('STT WebSocket Forwarder (echo server)', () => {
    let wss: WebSocketServer;
    let url = '';
    const received: Buffer[] = [];

    beforeAll((done) => {
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
            ws.on('message', (data) => {
                if (typeof data === 'string') {
                    // ignore JSON init/bye
                } else {
                    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
                    received.push(Buffer.from(buf));
                }
            });
        });
    });

    afterAll((done) => {
        wss.close(() => done());
    });

    test('forwards binary audio frames', async () => {
        type SttCfgOverride = { applyOverrides: (p: Partial<import('../../src/utils/stt-config').SttConfigState>) => () => void };
        const restore = (sttConfig as unknown as SttCfgOverride).applyOverrides({
            endpoint: url,
            enabled: true,
            protocol: 'websocket',
            encoding: 'L16',
            rate: 8000,
            mono: true,
            wsInitJson: null,
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

        expect(received.length).toBeGreaterThan(0);
        const total = Buffer.concat(received);
        expect(total.length).toBeGreaterThan(0);
    }, 10000);
});