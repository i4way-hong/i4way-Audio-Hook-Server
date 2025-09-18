// filepath: app/audiohook/test/stt/grpc-mrcp-stub.test.ts
import { createSttForwarder } from '../../src/server/stt-forwarder';
import type { Logger } from '../../src/utils/logger';

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

describe('STT gRPC/MRCP forwarder stubs', () => {
  test('gRPC stub starts/stops without error', async () => {
    const logger = createTestLogger();
    const fwd = createSttForwarder('grpc', logger);
    await expect(fwd.start()).resolves.toBeUndefined();
    await expect(fwd.stop()).resolves.toBeUndefined();
  });

  test('MRCP stub starts/stops without error', async () => {
    const logger = createTestLogger();
    const fwd = createSttForwarder('mrcp', logger);
    await expect(fwd.start()).resolves.toBeUndefined();
    await expect(fwd.stop()).resolves.toBeUndefined();
  });
});
