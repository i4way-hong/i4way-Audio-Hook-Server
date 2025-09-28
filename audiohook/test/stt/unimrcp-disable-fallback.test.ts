import { openSession } from '../../src/sidecar/signaling/unimrcp-signaling';

/**
 * RTSP 서버가 없고 MRCP_DISABLE_FALLBACK5004=1 설정 시 fallback 5004를 사용하지 않고 에러를 던지는지 검증.
 */

describe('RTSP fallback disable', () => {
  const OLD_ENV = { ...process.env };
  beforeEach(() => {
    jest.resetModules();
    process.env = { ...OLD_ENV };
  });
  afterAll(() => {
    process.env = OLD_ENV;
  });

  test('fallback disabled => openSession throws (no server running)', async () => {
    process.env['MRCP_DISABLE_FALLBACK5004'] = '1';
    process.env['MRCP_DISABLE_NATIVE'] = '1'; // 네이티브 경로 비활성화
    process.env['MRCP_FORCE_RTSP'] = '1'; // SIP 우회
    const endpoint = 'rtsp://127.0.0.1:59999/unimrcp'; // 의도적으로 비존재 포트
    const t0 = Date.now();
    let threw = false;
    try {
  await openSession({ endpoint, profileId: 'ah-mrcpv1', codec: 'PCMU', sampleRate: 8000 });
    } catch (e) {
      threw = true;
      const msg = (e as Error).message;
      expect(msg).toMatch(/fallback disabled/i);
    }
    const dt = Date.now() - t0;
    expect(threw).toBe(true);
    // 불필요한 장시간 대기도 없는지 (DESCRIBE 재시도 기본 3회 내 소요)
    expect(dt).toBeLessThan(5000);
  });
});
