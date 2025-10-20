import { performSipInviteUdp } from '../../src/sidecar/signaling/sip-udp';
import { MrcpTelemetry } from '../../src/sidecar/signaling/telemetry';

// Harness tests for network simulator (Bundle 5)
// Uses environment-driven network simulation (drop/delay) to evaluate reliability.

const LOCAL_IP = '127.0.0.1';

function mockSipServer(responder: (raw: string) => string | null) {
  const dgram = require('dgram');
  const server = dgram.createSocket('udp4');
  const port = 40000 + Math.floor(Math.random() * 10000);
  server.on('message', (msg: Buffer, rinfo: any) => {
    const txt = msg.toString('utf8');
    // basic heuristic: only log INVITE first line
    if (/^INVITE /.test(txt)) {
      // eslint-disable-next-line no-console
      console.log('[reliability-srv] received INVITE bytes=', msg.length);
    }
    const out = responder(txt);
    if (out) {
      const buf = Buffer.from(out, 'utf8');
      server.send(buf, 0, buf.length, rinfo.port, rinfo.address, () => {
        // eslint-disable-next-line no-console
        console.log('[reliability-srv] sent 200 OK');
      });
    }
  });
  return new Promise<{ close: () => void; port: number }>((resolve) => {
    server.bind(port, () => {
      resolve({ close: () => server.close(), port });
    });
  });
}

function make200Response(req: string, sdp: string): string {
  // minimal extraction of Via + others
  const lines = req.split(/\r?\n/);
  const via = lines.find(l => l.startsWith('Via:'));
  const to = lines.find(l => l.startsWith('To:')) || 'To: <sip:dummy>'; // normally server would add tag
  const from = lines.find(l => l.startsWith('From:'));
  const callId = lines.find(l => l.startsWith('Call-ID:'));
  const cseq = lines.find(l => l.startsWith('CSeq:'));
  const contact = lines.find(l => l.startsWith('Contact:'));
  const taggedTo = to.includes('tag=') ? to : to + ';tag=srv';
  const body = sdp;
  const hdrs = [
    'SIP/2.0 200 OK',
    via!,
    to ? taggedTo : 'To: <sip:dummy>;tag=tsrv',
    from!,
    callId!,
    cseq!,
    contact || 'Contact: <sip:dummy@127.0.0.1>',
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(body)}`,
    '',
    body
  ];
  return hdrs.join('\r\n');
}

function basicSdp(remotePort: number): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=Srv',
    'c=IN IP4 127.0.0.1',
    't=0 0',
    `m=audio ${remotePort} RTP/AVP 0`,
    ''
  ].join('\r\n');
}

jest.setTimeout(25000);

// Sequential invites (easier deterministic timing with small timeouts)
async function runInvites(count: number, telemetry: MrcpTelemetry, overallTimeoutMs = 1500, t1Ms = 120) {
  const successes: any[] = [];
  const failures: Error[] = [];
  for (let i=0; i<count; i++) {
    try {
      const res = await performSipInviteUdp({
        endpoint: `sip://127.0.0.1:${(globalThis as any).__SIP_TEST_PORT__}`,
        localIp: LOCAL_IP,
        localRtpPort: 60000 + i,
        payloadType: 0,
        overallTimeoutMs,
        t1Ms,
        telemetry
      });
      successes.push(res);
    } catch (e: any) {
      if (failures.length === 0) {
        // eslint-disable-next-line no-console
        console.log('[reliability-test] first failure message=', e.message);
      }
      failures.push(e);
    }
  }
  return { successes, failures };
}

describe('SIP UDP reliability harness', () => {
  let server: { close: () => void, port: number };
  beforeAll(async () => {
    server = await mockSipServer((req) => {
      // Always respond 200 OK quickly with fixed port
      const rtpPort = 50000 + Math.floor(Math.random()*1000);
      return make200Response(req, basicSdp(rtpPort));
    });
    (globalThis as any).__SIP_TEST_PORT__ = server.port;
  process.env['MRCP_TEST_ALLOW_LOW_TIMEOUT'] = '1';
  });
  afterAll(() => {
    server.close();
  });

  test('some successes under 30% drop', async () => {
    process.env['MRCP_SIP_TEST_PACKET_DROP_RATE'] = '0.3';
    delete process.env['MRCP_SIP_TEST_PACKET_DELAY_MS'];
    delete process.env['MRCP_SIP_TEST_PACKET_JITTER_MS'];
    const telemetry = new MrcpTelemetry();
    const N = 8; // smaller sample to keep test quick
    const { successes, failures } = await runInvites(N, telemetry, 2500, 120);
    expect(successes.length).toBeGreaterThan(0); // at least one invite should survive drops + retransmits
    // allow some failures but not all
    expect(failures.length).toBeLessThan(N);
    const tele: any = telemetry as any;
    const timeouts = tele.inviteTimeouts || tele.metrics?.inviteTimeouts || 0;
    expect(timeouts).toBeLessThanOrEqual(N); // upper bound sanity
  });

  test('persistent 100% drop => at least one timeout', async () => {
    process.env['MRCP_SIP_TEST_PACKET_DROP_RATE'] = '1';
    process.env['MRCP_SIP_TEST_PERSISTENT_DROP'] = '1';
    delete process.env['MRCP_SIP_TEST_PACKET_DELAY_MS'];
    delete process.env['MRCP_SIP_TEST_PACKET_JITTER_MS'];
    const telemetry = new MrcpTelemetry();
    const N = 4;
    const { successes } = await runInvites(N, telemetry, 1200, 100);
    const tele: any = telemetry as any;
    const timeouts = tele.inviteTimeouts || tele.metrics?.inviteTimeouts || 0;
    expect(timeouts).toBeGreaterThanOrEqual(1);
    expect(timeouts).toBeLessThanOrEqual(N);
    // If retries overcame drops some may succeed; just ensure not zero timeouts under persistent drop
    delete process.env['MRCP_SIP_TEST_PERSISTENT_DROP'];
  });

  test('fixed delay < overallTimeout still succeeds (no timeouts)', async () => {
    process.env['MRCP_SIP_TEST_PACKET_DROP_RATE'] = '0';
    process.env['MRCP_SIP_TEST_PACKET_DELAY_MS'] = '300';
    delete process.env['MRCP_SIP_TEST_PACKET_JITTER_MS'];
    const telemetry = new MrcpTelemetry();
    const N = 8;
    const { successes, failures } = await runInvites(N, telemetry, 2000, 150);
    expect(successes.length).toBe(N);
    expect(failures.length).toBe(0);
    const tele: any = telemetry as any;
    const timeouts = tele.inviteTimeouts || tele.metrics?.inviteTimeouts || 0;
    expect(timeouts).toBe(0);
  });
});
