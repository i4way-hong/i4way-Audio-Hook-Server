// filepath: app/audiohook/test/stt/sidecar-stub-multi-result.test.ts
import WebSocket from 'ws';
import { once } from 'events';

/**
 * 이 테스트는 sidecar stub signaling이 누적 바이트 기반으로 다중 result 이벤트를
 * 방출하는지 검증한다. 환경 변수를 aggressive 하게 낮춰 빠른 사이클을 만든다.
 */

describe('Sidecar stub multiple result emission', () => {
  const OLD_ENV = { ...process.env };
  let sidecarProc: import('child_process').ChildProcess | null = null;

  beforeAll(async () => {
    jest.setTimeout(15000);
  process.env['MRCP_SIDECAR_SIGNALING'] = 'stub';
  process.env['MRCP_SIDECAR_PORT'] = '0'; // dynamic
  process.env['MRCP_STUB_RESULT_INTERVAL_BYTES'] = '2000'; // 2KB마다 결과
  process.env['MRCP_STUB_RESULT_MIN_INTERVAL_MS'] = '50';
  process.env['MRCP_STUB_RESULT_MAX_INTERVAL_MS'] = '2000';

    // sidecar 서버를 child process로 실행 (ts-node/ts-node-dev 없이 컴파일 환경 가정)
    // 여기서는 런타임이 이미 ts-jest 환경이므로 직접 server.ts를 require 할 수도 있지만
    // 독립성 위해 별도 node 프로세스 사용.
    const { spawn } = require('child_process');
    // Use ts-node/register to execute TS directly in child for tests
    sidecarProc = spawn(process.execPath, ['-r', 'ts-node/register', require.resolve('../../src/sidecar/server.ts')], {
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const procRef = sidecarProc; // non-null after spawn
  procRef?.stdout?.on('data', (d: Buffer) => process.stdout.write('[sidecar-stdout] ' + d.toString()));
  procRef?.stderr?.on('data', (d: Buffer) => process.stderr.write('[sidecar-stderr] ' + d.toString()));

    // 포트 open 대기: 간단히 소량의 로그나 지연
    await new Promise((res, rej) => {
      const to = setTimeout(res, 1200); // 1.2초 대기
      sidecarProc?.once('exit', (code) => {
        clearTimeout(to);
        rej(new Error('sidecar exited early code=' + code));
      });
    });
  });

  afterAll(async () => {
    process.env = { ...OLD_ENV };
    if (sidecarProc && !sidecarProc.killed) {
      sidecarProc.kill();
    }
  });

  test('emits at least two result events', async () => {
    // 동적 포트 탐색: Fastify JSON 로그 내 "Server listening at http://0.0.0.0:<port>" 패턴 사용
    const port = await new Promise<number>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('no sidecar listen log')), 4000);
      sidecarProc?.stdout?.on('data', (d: Buffer) => {
        const s = d.toString();
        // Try to extract from either raw text or JSON line
        let m = /Server listening at http:\/\/0\.0\.0\.0:(\d+)/.exec(s);
        if (!m) {
          try {
            const obj = JSON.parse(s);
            if (obj && typeof obj.msg === 'string') {
              m = /Server listening at http:\/\/0\.0\.0\.0:(\d+)/.exec(obj.msg);
            }
          } catch { /* ignore JSON parse errors */ }
        }
        if (m) { clearTimeout(to); resolve(Number(m[1])); }
      });
    });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/mrcp`);
    const results: any[] = [];
    const closed: any[] = [];

    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        const msg = JSON.parse(String(data));
        if (msg.type === 'result') {
          results.push(msg);
        } else if (msg.type === 'closed') {
          closed.push(msg);
        }
      } catch {
        // ignore
      }
    });

    await once(ws, 'open');

    ws.send(JSON.stringify({
      type: 'init',
      profileId: 'ah-mrcpv1',
      endpoint: 'rtsp://127.0.0.1:8060/unimrcp',
      codec: 'PCMU',
      sampleRate: 8000,
      ptime: 20,
    }));

    // 2KB interval이므로 3~4회 트리거 되도록 10KB 정도 보냄
    const totalBytes = 10 * 1024;
    const chunk = Buffer.alloc(400, 0xff); // 400 bytes
    let sent = 0;
    while (sent < totalBytes) {
      ws.send(chunk, { binary: true });
      sent += chunk.length;
      await new Promise(r => setTimeout(r, 5)); // 약간 쉬어 stub 타이머 조건 만족
    }

    // 결과 수집 대기
    await new Promise(r => setTimeout(r, 800));

    ws.send(JSON.stringify({ type: 'bye' }));
    await new Promise(r => setTimeout(r, 200));

    try { ws.close(); } catch { /* noop */ }

    // 최소 2개 이상 결과 발생 검증
    expect(results.length).toBeGreaterThanOrEqual(2);
    // 결과들이 latency / bytes 문구 포함 여부 확인(형식 점검 용)
    expect(results[0].text).toMatch(/stub transcript/);
  });
});
