import { createServer, Socket } from 'net';
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

describe('STT TCP Forwarder (echo server)', () => {
    const receivedRaw: Buffer[] = [];
    const receivedLen32: Buffer[] = [];
    const receivedNewline: Buffer[] = [];

    function startTcpEcho(onData: (b: Buffer) => void): Promise<{port:number, close: () => Promise<void>}> {
        return new Promise((resolve) => {
            const srv = createServer((sock: Socket) => {
                sock.on('data', (data: Buffer) => {
                    onData(Buffer.from(data));
                });
            });
            srv.listen(0, '127.0.0.1', () => {
                const addr = srv.address();
                if (typeof addr === 'object' && addr) {
                    resolve({
                        port: addr.port,
                        close: () => new Promise<void>(r => srv.close(() => r()))
                    });
                }
            });
        });
    }

    async function sendAndStop(proto: 'raw'|'len32'|'newline', port: number, collector: Buffer[]): Promise<void> {
        type SttCfgOverride = { applyOverrides: (p: Partial<import('../../src/utils/stt-config').SttConfigState>) => () => void };
        const endpoint = `127.0.0.1:${port}`;
        const restore = (sttConfig as unknown as SttCfgOverride).applyOverrides({
            endpoint,
            enabled: true,
            protocol: 'tcp',
            encoding: 'L16',
            rate: 8000,
            mono: true,
            tcpFraming: proto,
            tcpInitHex: null,
            tcpByeHex: null,
        });
        const logger = createTestLogger();
        const fwd = createSttForwarder('tcp', logger);
        await fwd.start();

        const channels: readonly MediaChannel[] = ['external'];
        const samples = new Int16Array(800);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = (i % 128) - 64;
        }
        const frame = createAudioFrame(samples, { format: 'L16', rate: 8000, channels });
        const mdFrame = frame as unknown as MediaDataFrame;

        fwd.send(mdFrame);
        await new Promise((r) => setTimeout(r, 100));
        await fwd.stop();
        restore();

        // give server a moment to receive remaining data
        await new Promise((r) => setTimeout(r, 50));
        expect(collector.length).toBeGreaterThan(0);
    }

    test('tcp framing raw', async () => {
        const server = await startTcpEcho((b) => receivedRaw.push(b));
        try {
            await sendAndStop('raw', server.port, receivedRaw);
        } finally {
            await server.close();
        }
    }, 10000);

    test('tcp framing len32', async () => {
        const server = await startTcpEcho((b) => receivedLen32.push(b));
        try {
            await sendAndStop('len32', server.port, receivedLen32);
            // very basic framing validation: first 4 bytes are length
            const total = Buffer.concat(receivedLen32);
            expect(total.length).toBeGreaterThan(4);
            const len = total.readUInt32BE(0);
            expect(len).toBeGreaterThan(0);
            expect(len).toBeLessThan(total.length);
        } finally {
            await server.close();
        }
    }, 10000);

    test('tcp framing newline', async () => {
        const server = await startTcpEcho((b) => receivedNewline.push(b));
        try {
            await sendAndStop('newline', server.port, receivedNewline);
            const total = Buffer.concat(receivedNewline);
            expect(total[total.length - 1]).toBe(0x0A); // \n
        } finally {
            await server.close();
        }
    }, 10000);
});
