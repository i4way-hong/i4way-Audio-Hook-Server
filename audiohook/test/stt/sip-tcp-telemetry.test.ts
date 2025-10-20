import net from 'net';
import { openSession } from '../../src/sidecar/signaling/unimrcp-signaling';

jest.setTimeout(10000);

describe('SIP TCP telemetry (RTT + codec)', () => {
  test('captures RTT + codec on TCP invite', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    delete process.env['MRCP_ENABLE_SIP_V2']; // ensure TCP path
    delete process.env['MRCP_FORCE_RTSP'];

    // Simple TCP server that delays 200 OK a bit
    const server = net.createServer((sock) => {
      let buf='';
      let firstChunkAt: number | undefined;
      sock.on('data', (d) => {
        if (!firstChunkAt) firstChunkAt = Date.now();
        buf += d.toString();
        if (buf.includes('\r\n\r\n') && buf.startsWith('INVITE')) {
          setTimeout(() => {
            const sdp = [
              'v=0','o=- 0 0 IN IP4 127.0.0.1','s=TCP','c=IN IP4 127.0.0.1','t=0 0','m=audio 51111 RTP/AVP 0',''
            ].join('\r\n');
            const res = [
              'SIP/2.0 200 OK',
              'Via: SIP/2.0/TCP 127.0.0.1',
              'To: <sip:127.0.0.1>',
              'From: <sip:audiohook@127.0.0.1>;tag=abc',
              'Call-ID: test-call',
              'CSeq: 1 INVITE',
              'Content-Type: application/sdp',
              `Content-Length: ${Buffer.byteLength(sdp)}`,
              '',
              sdp
            ].join('\r\n');
            sock.write(res, () => sock.end());
          }, 90); // delay to produce RTT >0
        }
      });
    });
    const port = await new Promise<number>(r => server.listen(0,'127.0.0.1', () => r((server.address() as any).port)));

    const session = await openSession({
      endpoint: `sip://127.0.0.1:${port}/x`,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });

    await new Promise(r => setTimeout(r, 250));
  const snap: any = session.getTelemetry ? session.getTelemetry() : {};
    expect(snap.sipInviteRttMsCount).toBe(1);
    expect(snap.sipInviteRttMsSum).toBeGreaterThan(0);
    expect(snap.sipCodecOffered).toBe(1);
    expect(snap.sipCodecSelected).toBe('PCMU');
    session.close();
    await new Promise(r => server.close(r));
  });
});
