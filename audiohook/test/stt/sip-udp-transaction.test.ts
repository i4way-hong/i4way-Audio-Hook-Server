import dgram from 'dgram';
import { openSession } from '../../src/sidecar/signaling/unimrcp-signaling';

jest.setTimeout(20000);

function makeServer(options: { dropRate?: number; finalDelayMs?: number }) {
  const dropRate = options.dropRate ?? 0;
  const finalDelay = options.finalDelayMs ?? 120;
  const sock = dgram.createSocket('udp4');
  let received = 0;
  let firstInvitePort: number | undefined;
  sock.on('message', (msg, rinfo) => {
    const txt = msg.toString('utf8');
    if (!txt.startsWith('INVITE')) return;
    received++;
    // simulate drop
  if (Math.random() < dropRate) return; // probabilistic drop
  // Force drop first two actual network sends to guarantee retransmits
  if (received <= 2) return;
    // send provisional once
    if (received === 1) {
      const prov = [
        'SIP/2.0 100 Trying',
        'Via: SIP/2.0/UDP 127.0.0.1',
        'To: <sip:127.0.0.1>',
        'From: <sip:audiohook@127.0.0.1>;tag=abc',
        'Call-ID: test-call',
        'CSeq: 1 INVITE',
        'Content-Length: 0',
        '',
        ''
      ].join('\r\n');
  const provBuf = Buffer.from(prov,'utf8');
  sock.send(new Uint8Array(provBuf), rinfo.port, rinfo.address);
    }
    setTimeout(() => {
      const sdp = [
        'v=0','o=- 0 0 IN IP4 127.0.0.1','s=Txn','c=IN IP4 127.0.0.1','t=0 0','m=audio 51234 RTP/AVP 0',''
      ].join('\r\n');
      const ok = [
        'SIP/2.0 200 OK',
        'Via: SIP/2.0/UDP 127.0.0.1',
        'To: <sip:127.0.0.1>;tag=xyz',
        'From: <sip:audiohook@127.0.0.1>;tag=abc',
        'Call-ID: test-call',
        'CSeq: 1 INVITE',
        'Content-Type: application/sdp',
        `Content-Length: ${Buffer.byteLength(sdp)}`,
        '',
        sdp
      ].join('\r\n');
  const okBuf = Buffer.from(ok,'utf8');
  sock.send(new Uint8Array(okBuf), rinfo.port, rinfo.address);
    }, finalDelay);
  });
  return sock;
}

describe('SIP UDP transaction timers', () => {
  test('retransmits under drop and succeeds (no timeout increment)', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    process.env['MRCP_ENABLE_SIP_V2'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];
    // accelerate timers
    process.env['MRCP_SIP_T1_MS'] = '80';
    process.env['MRCP_SIP_INVITE_TIMEOUT_MS'] = '4000';
    // control random seed
    let seed = 42;
    const origRandom = Math.random;
    Math.random = () => { seed = (seed * 16807) % 2147483647; return (seed % 1000) / 1000; };

    const server = makeServer({ dropRate: 0.3, finalDelayMs: 100 });
    const port: number = await new Promise(r => server.bind(0,'127.0.0.1', () => r((server.address() as any).port)));

    const session = await openSession({ endpoint: `sip://127.0.0.1:${port}/r`, profileId: 'ah-mrcpv2', codec: 'PCMU', sampleRate: 8000 });
  await new Promise(r => setTimeout(r, 1200));
    session.close();
    const snap: any = session.getTelemetry ? session.getTelemetry() : {};
    expect(snap.inviteTimeouts || 0).toBe(0);
    expect((snap.sipInviteRetransmits || 0)).toBeGreaterThanOrEqual(1);
    server.close();
    Math.random = origRandom;
    delete process.env['MRCP_SIP_T1_MS'];
    delete process.env['MRCP_SIP_INVITE_TIMEOUT_MS'];
  });

  test('full timeout increments inviteTimeouts (no server response)', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    process.env['MRCP_ENABLE_SIP_V2'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];
    process.env['MRCP_SIP_T1_MS'] = '50';
    process.env['MRCP_SIP_INVITE_TIMEOUT_MS'] = '900';
    const server = dgram.createSocket('udp4');
    const port: number = await new Promise(r => server.bind(0,'127.0.0.1', () => r((server.address() as any).port)));

    const session = await openSession({ endpoint: `sip://127.0.0.1:${port}/r`, profileId: 'ah-mrcpv2', codec: 'PCMU', sampleRate: 8000 });
    // allow any fallback or timeout handling to settle
    await new Promise(r => setTimeout(r, 300));
    const snap: any = session.getTelemetry ? session.getTelemetry() : {};
    expect((snap.inviteTimeouts || 0)).toBeGreaterThanOrEqual(1);
    session.close();
    server.close();
    delete process.env['MRCP_SIP_T1_MS'];
    delete process.env['MRCP_SIP_INVITE_TIMEOUT_MS'];
  });
});
