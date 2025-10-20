import dgram from 'dgram';
import { openSession } from '../../src/sidecar/signaling/unimrcp-signaling';

jest.setTimeout(15000);

// This test simulates a SIP UDP server sending provisional then 200 OK.
// We enable MRCP_ENABLE_SIP_V2 to trigger UDP-first flow.

describe('SIP UDP telemetry (provisional, retransmit, RTT, codec)', () => {
  test('captures provisional + retransmit + RTT + codec fields', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    process.env['MRCP_ENABLE_SIP_V2'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];

    // Minimal UDP listener
    const sock = dgram.createSocket('udp4');
    const port: number = await new Promise(resolve => {
      sock.bind(0, '127.0.0.1', () => resolve((sock.address() as any).port));
    });

    let inviteText = '';
    sock.on('message', (msg, rinfo) => {
      const txt = msg.toString('utf8');
      if (txt.startsWith('INVITE')) {
        inviteText = txt;
        // send one provisional first
        const prov = [
          'SIP/2.0 180 Ringing',
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
        // After short delay send 200 OK with SDP
        setTimeout(() => {
          const sdp = [
            'v=0','o=- 0 0 IN IP4 127.0.0.1','s=Test','c=IN IP4 127.0.0.1','t=0 0','m=audio 49999 RTP/AVP 0',''
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
        }, 120);
      }
    });

    const session = await openSession({
      endpoint: `sip://127.0.0.1:${port}/res`,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });

    // wait for negotiation to settle
    await new Promise(r => setTimeout(r, 350));

  const snap: any = session.getTelemetry ? session.getTelemetry() : {};
    // Provisional counted
    expect(snap.sipProvisional).toBeGreaterThanOrEqual(1);
    // RTT captured
    expect(snap.sipInviteRttMsCount).toBe(1);
    expect(snap.sipInviteRttMsSum).toBeGreaterThan(0);
    expect(snap.averageInviteRttMs).toBeGreaterThan(0);
    // Codec fields
    expect(snap.sipCodecOffered).toBe(1);
    expect(snap.sipCodecSelected).toBe('PCMU');

    session.close();
    sock.close();
  });
});
