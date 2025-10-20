import dgram from 'dgram';
import net from 'net';

jest.setTimeout(15000);

function loadSignaling() {
  const p = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete require.cache[p];
  return require('../../src/sidecar/signaling/unimrcp-signaling') as typeof import('../../src/sidecar/signaling/unimrcp-signaling');
}

// Very small UDP mock responding with a 200 OK SDP once it sees INVITE
function startUdpSipMock(): Promise<{ port: number; close: () => Promise<void>; }> {
  const sock = dgram.createSocket('udp4');
  return new Promise((resolve) => {
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString();
      if (text.startsWith('INVITE')) {
        const sdp = [
          'v=0','o=- 0 0 IN IP4 127.0.0.1','s=UdpMock','c=IN IP4 127.0.0.1','t=0 0','m=audio 49200 RTP/AVP 0','a=ptime:20',''
        ].join('\r\n');
        const resLines = [
          'SIP/2.0 200 OK',
          'Via: SIP/2.0/UDP 127.0.0.1',
          'To: <sip:127.0.0.1>',
          'From: <sip:audiohook@127.0.0.1>;tag=abc',
          'Call-ID: test-call',
          'CSeq: 1 INVITE',
          'Content-Type: application/sdp',
          `Content-Length: ${Buffer.byteLength(sdp)}`,
          '',
          sdp,
        ].join('\r\n');
  sock.send(resLines, rinfo.port, rinfo.address);
      }
    });
    sock.bind(0,'127.0.0.1', () => {
      const addr = sock.address();
      resolve({ port: (addr as any).port, close: () => new Promise<void>(r => sock.close(() => r())) });
    });
  });
}

describe('Telemetry v2 SIP UDP split counters', () => {
  test('UDP success only increments udp counters', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];
    process.env['MRCP_ENABLE_SIP_V2'] = '1';
    const udp = await startUdpSipMock();
    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: `sip://127.0.0.1:${udp.port}/resource`,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
  const snap: any = session.getTelemetry!();
  expect(snap.sipAttempts).toBe(1);
  expect(snap.sipSuccess).toBe(1);
  expect(snap.sipUdpAttempts).toBe(1);
  expect(snap.sipUdpSuccess).toBe(1);
  expect(snap.sipTcpAttempts).toBeUndefined();
  expect(snap.sipTcpSuccess).toBeUndefined();
    session.close();
    await udp.close();
  });

  test('UDP fail then TCP success increments both udp fail and tcp success', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];
    process.env['MRCP_ENABLE_SIP_V2'] = '1';
    // No UDP server -> force UDP failure
    // TCP mock server success
    const tcpServer = net.createServer((sock) => {
      let buf='';
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) {
          if (buf.startsWith('INVITE')) {
            const sdp = [
              'v=0','o=- 0 0 IN IP4 127.0.0.1','s=TcpAfterUdpFail','c=IN IP4 127.0.0.1','t=0 0','m=audio 49300 RTP/AVP 0','a=ptime:20',''
            ].join('\r\n');
            const res = [
              'SIP/2.0 200 OK',
              'Via: SIP/2.0/TCP 127.0.0.1',
              'To: <sip:127.0.0.1>',
              'From: <sip:audiohook@127.0.0.1>;tag=abc',
              'Call-ID: test-call',
              'CSeq: 1 INVITE',
              'Content-Type: application/sdp',
              `Content-Length:  ${Buffer.byteLength(sdp)}`.replace('  ',' '),
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
    const tcpPort = await new Promise<number>(r => tcpServer.listen(0,'127.0.0.1', () => r((tcpServer.address() as any).port)));
    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: `sip://127.0.0.1:${tcpPort}/resource`,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
  const snap: any = session.getTelemetry!();
  expect(snap.sipAttempts).toBe(2); // udp + tcp
  expect(snap.sipSuccess).toBe(1);
  expect(snap.sipFail).toBe(1); // udp failed
  expect(snap.sipUdpAttempts).toBe(1);
  expect(snap.sipUdpFail).toBe(1);
  expect(snap.sipTcpAttempts).toBe(1);
  expect(snap.sipTcpSuccess).toBe(1);
    session.close();
    await new Promise(r => tcpServer.close(r));
  });
});
