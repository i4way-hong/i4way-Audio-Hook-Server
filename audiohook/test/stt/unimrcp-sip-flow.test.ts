// SIP (MRCPv2) skeleton openSession test
// 이 테스트는 sip:// 엔드포인트에 대해 performSipInvite 경로가 호출되어
// SIP_INVITE_FAILED 오류 후 RTSP fallback 시도 없이 (현재 구현: sip 실패 후 rtsp fallback) rtsp\n// 모의 서버가 없을 경우 fallback 오류 흐름(5004)으로 귀결되는지 최소 검증.
// 추후 실제 SIP mock 서버 구현 시 교체.

import { once } from 'events';

jest.setTimeout(15000);

// 강제로 native 비활성 + RTSP 강제 해제 (SIP 분기 실행되도록)
delete process.env['MRCP_FORCE_RTSP'];
process.env['MRCP_DISABLE_NATIVE'] = '1';

const signalingModulePath = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
delete require.cache[signalingModulePath];
const signaling = require('../../src/sidecar/signaling/unimrcp-signaling');

// 간단: 존재하지 않는 SIP 호스트로 INVITE -> 실패 -> RTSP fallback 시도 (endpoint는 sip:// 이므로 URL 파싱 실패 없이 진행)
// 최종적으로 RTSP DESCRIBE도 실패하여 5004 fallback error code 이벤트를 기대.

describe('SIP skeleton -> fallback', () => {
  test('sip invite failure returns a session with fallback behavior (no crash)', async () => {
    const session = await signaling.openSession({
      endpoint: 'sip://127.0.0.1:50999/nonexistent',
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
    // 세션 객체는 반환되어야 하며 remotePort 숫자 보장 (RTSP fallback 또는 기본 5004)
    expect(typeof session.remotePort).toBe('number');
    // 실패 후 RTSP fallback 경로이므로 transport 는 rtsp 여야 함
    expect((session as any).transport).toBe('rtsp');
    session.close();
  });
});
