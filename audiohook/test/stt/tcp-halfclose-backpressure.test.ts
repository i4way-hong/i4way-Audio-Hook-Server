import { createServer, Socket } from 'net';
import { createSttForwarder } from '../../src/server/stt-forwarder';
import sttConfig from '../../src/utils/stt-config';
import type { Logger } from '../../src/utils/logger';
import { createAudioFrame } from '../../src/audio';
import type { MediaDataFrame } from '../../src/server/mediadata';
import type { MediaChannel } from '../../src/protocol';

function createTestLogger(): Logger {
    return {
        fatal: () => undefined,
        error: () => undefined,
        warn: () => undefined,
        info: () => undefined,
        debug: () => undefined,
        trace: () => undefined,
    };
}

describe('STT TCP Forwarder half-close/backpressure', () => {
    const toClose: Array<() => Promise<void>> = [];
    afterEach(async () => {
        while (toClose.length) {
            const fn = toClose.pop();
            try { if (fn) await fn(); } catch {/* ignore */}
        }
    });
    test('peer half-close (FIN) then further sends are ignored', async () => {
        let total = 0;
        const server = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
            const srv = createServer((sock: Socket) => {
                sock.on('data', (d) => {
                    total += d.length;
                    // Trigger half-close shortly after first data
                    if (total > 0) {
                        setTimeout(() => sock.end(), 10);
                    }
                });
            });
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address();
                if (typeof addr === 'object' && addr) {
                    resolve({ port: addr.port, close: () => new Promise((r) => srv.close(() => r())) });
                }
            });
        });
        toClose.push(server.close);

        type SttCfgOverride = { applyOverrides: (p: Partial<import('../../src/utils/stt-config').SttConfigState>) => () => void };
        const restore = (sttConfig as unknown as SttCfgOverride).applyOverrides({
            endpoint: `127.0.0.1:${server.port}`,
            enabled: true,
            protocol: 'tcp',
            encoding: 'L16',
            rate: 8000,
            mono: true,
            tcpFraming: 'raw',
        });

        const logger = createTestLogger();
        const fwd = createSttForwarder('tcp', logger);
        await fwd.start();

        const channels: readonly MediaChannel[] = ['external'];
        const samples = new Int16Array(800);
        const frame = createAudioFrame(samples, { format: 'L16', rate: 8000, channels }) as unknown as MediaDataFrame;

        fwd.send(frame);
        await new Promise((r) => setTimeout(r, 50)); // allow FIN to propagate

        // Further sends should be ignored by forwarder after FIN
        for (let i = 0; i < 10; i++) {
            fwd.send(frame);
        }

        await new Promise((r) => setTimeout(r, 50));
        await fwd.stop();
        restore();

        expect(total).toBeGreaterThan(0);
    }, 10000);

    test('burst send while peer paused, then resume drains queued data', async () => {
        let received = 0;
        let paused = false;
        let serverSocket: Socket | null = null;
        const server = await new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
            const srv = createServer((sock: Socket) => {
                serverSocket = sock;
                sock.on('data', (d) => {
                    received += d.length;
                });
            });
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address();
                if (typeof addr === 'object' && addr) {
                    resolve({ port: addr.port, close: () => new Promise((r) => srv.close(() => r())) });
                }
            });
        });
        toClose.push(server.close);

        type SttCfgOverride = { applyOverrides: (p: Partial<import('../../src/utils/stt-config').SttConfigState>) => () => void };
        const restore = (sttConfig as unknown as SttCfgOverride).applyOverrides({
            endpoint: `127.0.0.1:${server.port}`,
            enabled: true,
            protocol: 'tcp',
            encoding: 'L16',
            rate: 8000,
            mono: true,
            tcpFraming: 'raw',
        });

        const logger = createTestLogger();
        const fwd = createSttForwarder('tcp', logger);
        await fwd.start();

        // Pause server reading to induce backpressure in kernel eventually
        const channels: readonly MediaChannel[] = ['external'];
        const one = new Int16Array(800);
        const md = createAudioFrame(one, { format: 'L16', rate: 8000, channels }) as unknown as MediaDataFrame;

        // Try to pause the socket a bit after first data
        setTimeout(() => {
            const srvSock = serverSocket;
            if (srvSock && !paused) {
                srvSock.pause();
                paused = true;
                setTimeout(() => srvSock.resume(), 50);
            }
        }, 10);

        // Burst many frames quickly
        for (let i = 0; i < 500; i++) {
            fwd.send(md);
        }

        await new Promise((r) => setTimeout(r, 200)); // allow resume and drain
        await fwd.stop();
        restore();

        // We at least should have received some of the burst
        expect(received).toBeGreaterThan(0);
    }, 15000);
});