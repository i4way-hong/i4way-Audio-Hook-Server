// filepath: app/audiohook/test/stt/unimrcp-rtsp-flow.test.ts
import net from 'net';
jest.setTimeout(20000);
import { once } from 'events';

// RTSP path 강제 (nativeBinding 존재해도 우회)
process.env['MRCP_FORCE_RTSP'] = '1';
// 모듈 캐시 무효화 (다른 테스트에서 먼저 로드했을 가능성 방지)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const signalingModulePath = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
// eslint-disable-next-line @typescript-eslint/no-dynamic-delete
delete require.cache[signalingModulePath];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const signaling = require('../../src/sidecar/signaling/unimrcp-signaling');

describe('UniMRCP RTSP flow (DESCRIBE + SETUP)', () => {
  let server: net.Server;
  let port: number; // deterministic test port
  const basePort = 45000 + (process.pid % 500); // spread across 45000-45499
  const responses: string[] = [];
  let describeReceived = false;
  let setupReceived = false;

  beforeAll(async () => {
    jest.setTimeout(20000);
    port = basePort; // first test uses basePort
    server = net.createServer((sock) => {
      let buf = '';
      // connection log
      // eslint-disable-next-line no-console
      console.log('[rtsp-mock] connection from', (sock.remoteAddress + ':' + sock.remotePort));
      sock.on('data', (data) => {
        buf += data.toString();
        // 디버그: 첫 수신시 요청 헤더 hex/프리뷰 출력
        if (buf.length === data.length) {
          const hex = Buffer.from(buf.slice(0, Math.min(80, buf.length))).toString('hex');
          // eslint-disable-next-line no-console
          console.log('[rtsp-mock] recv first chunk len', data.length, 'preview', buf.split('\n')[0], 'hex', hex);
        }
        if (buf.includes('\r\n\r\n')) {
          if (!describeReceived) {
            describeReceived = true;
            const sdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Mock\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 41000 RTP/AVP 0\r\na=ptime:20\r\n';
            const bodyLen = Buffer.byteLength(sdp);
            const res = `RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: ${bodyLen}\r\nContent-Type: application/sdp\r\n\r\n${sdp}`;
            responses.push('DESCRIBE');
            // eslint-disable-next-line no-console
            console.log('[rtsp-mock] sending DESCRIBE response asciiPreview=', res.substring(0,60).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
            // eslint-disable-next-line no-console
            console.log('[rtsp-mock] sending DESCRIBE response hex=', Buffer.from(res).toString('hex').slice(0,120));
            sock.write(res, () => sock.end());
            buf = '';
          } else if (!setupReceived) {
            setupReceived = true;
            const res = 'RTSP/1.0 200 OK\r\nCSeq: 2\r\nTransport: RTP/AVP;unicast;server_port=52000-52001\r\n\r\n';
            responses.push('SETUP');
            // eslint-disable-next-line no-console
            console.log('[rtsp-mock] sending SETUP response asciiPreview=', res.substring(0,60).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
            // eslint-disable-next-line no-console
            console.log('[rtsp-mock] sending SETUP response hex=', Buffer.from(res).toString('hex').slice(0,120));
            sock.write(res, () => sock.end());
            buf = '';
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('openSession negotiates remote RTP port via DESCRIBE + SETUP', async () => {
    // 서버 accept 루프 안정화를 위해 약간의 지연 및 connect probe
    await new Promise(r => setTimeout(r, 30));
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.end(); resolve(); });
      s.on('error', reject);
    });
    // 디버그: 할당된 포트 출력 및 유효성 검사
    // (실패시 포트 미할당 문제가 원인일 수 있음)
    // eslint-disable-next-line no-console
    console.log('[rtsp-test] using port', port);
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
    const session = await signaling.openSession({
      endpoint: `rtsp://127.0.0.1:${port}/unimrcp`,
      profileId: 'ah-mrcpv1',
      codec: 'PCMU',
      sampleRate: 8000,
    });

    expect(describeReceived).toBe(true);
    expect(setupReceived).toBe(true);
    // SETUP server_port=52000-52001 → remotePort = 52000
    expect(session.remotePort).toBe(52000);
    expect(session.payloadType).toBe(0);
  expect((session as any).transport).toBe('rtsp');

    // 결과 시뮬레이션 partial 이벤트 최소 1개 수신 대기
    const partialPromise = new Promise((resolve) => {
      session.emitter.on('result', (ev: any) => {
        if (ev.stage === 'partial') {
          resolve(ev);
        }
      });
    });
    await partialPromise;

    session.close();
  });

  // Diagnostic manual DESCRIBE test: run only when MRCP_TEST_DEBUG is set.
  const manualTest = process.env['MRCP_TEST_DEBUG'] ? test : test.skip;
  manualTest('manual DESCRIBE sanity (diagnostic)', async () => {
    // 서버가 정상 ASCII RTSP 응답을 보내는지 직접 확인
    const req = [
      `DESCRIBE rtsp://127.0.0.1:${port}/unimrcp RTSP/1.0`,
      'CSeq: 1',
      'Accept: application/sdp',
      'User-Agent: diagnostic-client',
      '',
      '',
    ].join('\r\n');
    const resp: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => {
        s.write(req);
      });
      s.on('data', (d) => resp.push(d));
      s.on('end', resolve);
      s.on('error', reject);
      s.setTimeout(1500, () => { reject(new Error('timeout')); });
    });
  const ascii = resp.map(b => (b as any as Buffer).toString('utf8')).join('');
  const first = resp[0] as any as Buffer;
  // eslint-disable-next-line no-console
  console.log('[manual-describe] chunks=', resp.length, 'firstLen=', first.length);
  // eslint-disable-next-line no-console
  console.log('[manual-describe] asciiPreview=', ascii.substring(0,120).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
  // eslint-disable-next-line no-console
  console.log('[manual-describe] hexPreviewFirst=', first.slice(0,120).toString('hex'));
  expect(ascii.startsWith('RTSP/1.0 200 OK')).toBe(true);
  });

  test('SETUP failure fallback uses SDP port', async () => {
    // 새 서버: DESCRIBE만 200, SETUP은 500 에러
    await new Promise<void>((resolve) => server.close(() => resolve()));
    describeReceived = false; setupReceived = false; responses.length = 0;
    port = basePort + 1; // second test uses adjacent port
    server = net.createServer((sock) => {
      let buf = '';
      // eslint-disable-next-line no-console
      console.log('[rtsp-mock-fallback] connection from', (sock.remoteAddress + ':' + sock.remotePort));
      sock.on('data', (data) => {
        buf += data.toString();
        if (buf.length === data.length) {
          const hex = Buffer.from(buf.slice(0, Math.min(80, buf.length))).toString('hex');
          // eslint-disable-next-line no-console
          console.log('[rtsp-mock-fallback] recv first chunk len', data.length, 'preview', buf.split('\n')[0], 'hex', hex);
        }
        if (buf.includes('\r\n\r\n')) {
          if (!describeReceived) {
            describeReceived = true;
            const sdp = 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=Mock\r\nc=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 43000 RTP/AVP 0\r\n';
            const bodyLen = Buffer.byteLength(sdp);
            const res = `RTSP/1.0 200 OK\r\nCSeq: 1\r\nContent-Length: ${bodyLen}\r\nContent-Type: application/sdp\r\n\r\n${sdp}`;
            sock.write(res, () => sock.end());
            buf = '';
            // eslint-disable-next-line no-console
            console.log('[rtsp-mock-fallback] sending DESCRIBE response asciiPreview=', res.substring(0,60).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
            // eslint-disable-next-line no-console
            console.log('[rtsp-mock-fallback] sending DESCRIBE response hex=', Buffer.from(res).toString('hex').slice(0,120));
          } else if (!setupReceived) {
            setupReceived = true;
            const res = 'RTSP/1.0 500 Internal Error\r\nCSeq: 2\r\n\r\n';
            sock.write(res, () => sock.end());
            buf = '';
            // eslint-disable-next-line no-console
            console.log('[rtsp-mock-fallback] sending SETUP error response asciiPreview=', res.substring(0,60).replace(/\r/g,'\\r').replace(/\n/g,'\\n'));
            // eslint-disable-next-line no-console
            console.log('[rtsp-mock-fallback] sending SETUP error response hex=', Buffer.from(res).toString('hex').slice(0,120));
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    await new Promise(r => setTimeout(r, 30));
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: '127.0.0.1', port }, () => { s.end(); resolve(); });
      s.on('error', reject);
    });
    // eslint-disable-next-line no-console
    console.log('[rtsp-test-fallback] using port', port);
    expect(typeof port).toBe('number');
    expect(port).toBeGreaterThan(0);
    const session = await signaling.openSession({
      endpoint: `rtsp://127.0.0.1:${port}/unimrcp`,
      profileId: 'ah-mrcpv1',
      codec: 'PCMU',
      sampleRate: 8000,
    });

  // 현재 구현: DESCRIBE 성공 + SETUP 500 오류 → error 이벤트(RTSP_SETUP_FAILED) 발생하나 세션은 SDP m=audio 포트(43000)를 유지
  // (전체 협상 실패로 간주하지 않으므로 5004로 떨어지지 않음)
  expect(session.remotePort).toBe(43000);
    expect((session as any).transport).toBe('rtsp');
    session.close();
  });
});
