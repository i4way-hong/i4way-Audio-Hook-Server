// filepath: app/audiohook/test/stt/ws-handshake-ping.test.ts
import { WebSocketServer } from 'ws';
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

describe('STT WebSocket Forwarder handshake/ping', () => {
  let wss: WebSocketServer;
  let url = '';
  const messages: Array<string | Buffer> = [];
  let pingCount = 0;

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
          messages.push(data);
        } else {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
          messages.push(Buffer.from(buf));
        }
      });
      ws.on('ping', () => {
        pingCount += 1;
      });
    });
  });

  afterAll((done) => {
    wss.close(() => done());
  });

  test('sends INIT, binary, periodic ping, then BYE on stop', async () => {
    type SttCfgOverride = { applyOverrides: (p: Partial<import('../../src/utils/stt-config').SttConfigState>) => () => void };
    const INIT = JSON.stringify({ type: 'init', sampleRate: 8000 });
    const BYE = JSON.stringify({ type: 'bye' });
    const restore = (sttConfig as unknown as SttCfgOverride).applyOverrides({
      endpoint: url,
      enabled: true,
      protocol: 'websocket',
      encoding: 'L16',
      rate: 8000,
      mono: true,
      wsInitJson: INIT,
      wsPingSec: 0.05, // 50ms
      wsByeJson: BYE,
    });

    const logger = createTestLogger();
    const fwd = createSttForwarder('websocket', logger);
    await fwd.start();

    // send one binary frame
    const channels: readonly MediaChannel[] = ['external'];
    const samples = new Int16Array(800); // 100ms at 8k mono
    for (let i = 0; i < samples.length; i++) samples[i] = (i % 128) - 64;
    const frame = createAudioFrame(samples, { format: 'L16', rate: 8000, channels });
    const mdFrame = frame as unknown as MediaDataFrame;
    fwd.send(mdFrame);

    // wait to allow at least one ping
    await new Promise((r) => setTimeout(r, 150));

    await fwd.stop();
    restore();

    // allow server to receive bye
    await new Promise((r) => setTimeout(r, 50));

    // Assertions
    const binMsgs = messages.filter((m): m is Buffer => Buffer.isBuffer(m));
    expect(binMsgs.length).toBeGreaterThan(0);

    const textMsgs = messages
      .map((m) => (Buffer.isBuffer(m) ? m.toString('utf8') : m))
      .filter((s): s is string => typeof s === 'string');

    expect(textMsgs).toEqual(expect.arrayContaining([INIT, BYE]));
    expect(pingCount).toBeGreaterThanOrEqual(1);
  }, 10000);
});
