import net from 'net';

jest.setTimeout(8000);

function loadSignaling() {
  const p = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete require.cache[p];
  return require('../../src/sidecar/signaling/unimrcp-signaling') as typeof import('../../src/sidecar/signaling/unimrcp-signaling');
}

// Minimal TCP SIP mock returning 200 OK with static SDP
function startSipTcpMock(): Promise<{ port: number; close: () => Promise<void>; }> {
  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\r\n\r\n')) {
        if (buf.startsWith('INVITE')) {
          const sdp = [
            'v=0','o=- 0 0 IN IP4 127.0.0.1','s=ChannelStub','c=IN IP4 127.0.0.1','t=0 0','m=audio 49000 RTP/AVP 0','a=ptime:20',''
          ].join('\r\n');
          const res = [
            'SIP/2.0 200 OK',
            'Via: SIP/2.0/TCP 127.0.0.1',
            'To: <sip:127.0.0.1>;tag=xyz',
            'From: <sip:audiohook@127.0.0.1>;tag=abc',
            'Call-ID: test-call',
            'CSeq: 1 INVITE',
            'Content-Type: application/sdp',
            `Content-Length: ${Buffer.byteLength(sdp)}`,
            '',
            sdp,
          ].join('\r\n');
          sock.write(res, () => sock.end());
        } else {
          sock.end();
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(0,'127.0.0.1', () => resolve({ port: (server.address() as any).port, close: () => new Promise(r => server.close(() => r())) })));
}

describe('MRCP channel skeleton', () => {
  test('channel exists, telemetry increments, send produces result events, double close safe', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];
    process.env['MRCP_ENABLE_SIP_V2'] = '1';
    const sip = await startSipTcpMock();
    const signaling = loadSignaling();
    const session = await signaling.openSession({ endpoint: `sip://127.0.0.1:${sip.port}/res`, profileId: 'ah-mrcpv2', codec: 'PCMU', sampleRate: 8000 });
    expect(session.channel).toBeDefined();
    const snap1: any = session.getTelemetry!();
    expect(snap1.sessionsMrcpChannel).toBe(1);

    const received: any[] = [];
    session.emitter.on('result', (ev) => received.push(ev));
    session.channel!.send('hello mrcp channel');
    await new Promise(r => setTimeout(r, 150));
    expect(received.filter(r => r.stage === 'partial').length).toBeGreaterThanOrEqual(1);
    expect(received.filter(r => r.stage === 'final').length).toBeGreaterThanOrEqual(1);

    session.close();
    session.close(); // idempotent
    const snap2: any = session.getTelemetry!();
    expect(snap2.sessionsClosed).toBe(1);
    await sip.close();
  });
});
