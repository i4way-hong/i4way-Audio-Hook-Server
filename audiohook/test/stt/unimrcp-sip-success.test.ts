// SIP 성공 경로 테스트: mock TCP SIP 서버가 200 OK + SDP 반환
// 현재 performSipInvite는 TCP 5060 기본을 사용하므로 임의 포트에 서버 열고 sip://127.0.0.1:PORT 로 호출

import net from 'net';

jest.setTimeout(15000);

// 강제: native 비활성 & RTSP 강제 해제
process.env['MRCP_DISABLE_NATIVE'] = '1';
delete process.env['MRCP_FORCE_RTSP'];

const signalingModulePath = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
delete require.cache[signalingModulePath];
const signaling = require('../../src/sidecar/signaling/unimrcp-signaling');

function buildSip200Response(sdp: string) {
  const headers = [
    'SIP/2.0 200 OK',
    'Via: SIP/2.0/TCP 127.0.0.1',
    'To: <sip:127.0.0.1>',
    'From: <sip:audiohook@127.0.0.1>;tag=abc',
    'Call-ID: test-call',
    'CSeq: 1 INVITE',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
    '',
    sdp,
  ];
  return headers.join('\r\n');
}

describe('SIP success path', () => {
  let server: net.Server; let port: number;
  beforeAll(async () => {
    server = net.createServer((sock) => {
      let buf='';
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) {
          // 간단 검증: INVITE 문자열 포함 시 응답
          if (buf.startsWith('INVITE')) {
            const sdp = [
              'v=0',
              'o=- 0 0 IN IP4 127.0.0.1',
              's=MockSIP',
              'c=IN IP4 127.0.0.1',
              't=0 0',
              'm=audio 47000 RTP/AVP 0',
              'a=ptime:30',
              '',
            ].join('\r\n');
            const res = buildSip200Response(sdp);
            sock.write(res, () => sock.end());
          } else {
            sock.end();
          }
        }
      });
    });
    port = await new Promise<number>((resolve) => {
      server.listen(0,'127.0.0.1', () => {
        const addr = server.address();
        resolve((addr as any).port);
      });
    });
  });
  afterAll(async () => {
    await new Promise<void>(r => server.close(() => r()));
  });

  test('openSession (sip) negotiates via performSipInvite and returns SDP values', async () => {
    const endpoint = `sip://127.0.0.1:${port}/resource`; // path 부분은 현재 로직상 영향 없음
    const session = await signaling.openSession({
      endpoint,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
    expect(session.remotePort).toBe(47000); // SDP m=audio 포트
    expect(session.payloadType).toBe(0); // PCMU 고정
    expect((session as any).transport).toBe('sip');
    // ptimeMs 전달 여부 (있으면 30)
    if ((session as any).ptimeMs) {
      expect((session as any).ptimeMs).toBe(30);
    }
    session.close();
  });
});
