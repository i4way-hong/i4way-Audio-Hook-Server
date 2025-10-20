import dgram from 'dgram';

jest.setTimeout(12000);

function loadSignaling() {
  const p = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete require.cache[p];
  return require('../../src/sidecar/signaling/unimrcp-signaling') as typeof import('../../src/sidecar/signaling/unimrcp-signaling');
}

interface UdpMock { port: number; close: () => Promise<void>; }

function startUdpSipMock(answerPt: number, ptime = 20): Promise<UdpMock> {
  const sock = dgram.createSocket('udp4');
  return new Promise((resolve) => {
    sock.on('message', (msg, rinfo) => {
      const text = msg.toString();
      if (text.startsWith('INVITE')) {
        const sdp = [
          'v=0','o=- 0 0 IN IP4 127.0.0.1','s=CodecSelect','c=IN IP4 127.0.0.1','t=0 0',`m=audio 49170 RTP/AVP ${answerPt}`,`a=ptime:${ptime}`,''
        ].join('\r\n');
        const res = [
          'SIP/2.0 200 OK',
          'Via: SIP/2.0/UDP 127.0.0.1',
          'To: <sip:127.0.0.1>;tag=xyz',
          'From: <sip:audiohook@127.0.0.1>;tag=abc',
          'Call-ID: test-call',
          'CSeq: 1 INVITE',
          'Content-Type: application/sdp',
          `Content-Length: ${Buffer.byteLength(sdp)}`,
          '',
          sdp,
        ].join('\r\n');
        sock.send(res, rinfo.port, rinfo.address);
      }
    });
    sock.bind(0,'127.0.0.1', () => {
      const addr = sock.address();
      resolve({ port: (addr as any).port, close: () => new Promise(r => sock.close(() => r())) });
    });
  });
}

describe('SIP multi-codec selection & fallback', () => {
  test('Server selects non-first offered codec (PCMA)', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    process.env['MRCP_ENABLE_SIP_V2'] = '1';
    process.env['MRCP_SIP_CODEC_LIST'] = 'PCMU,PCMA,L16';
    const udp = await startUdpSipMock(8); // answer with PT 8 (PCMA)
    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: `sip://127.0.0.1:${udp.port}/resource`,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
    const snap: any = session.getTelemetry!();
    expect(snap.sipCodecOffered).toBe(3);
    expect(snap.sipCodecSelected).toBe('PCMA');
    session.close();
    await udp.close();
  });

  test('Unsupported answer PT maps to PT<number> label', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    process.env['MRCP_ENABLE_SIP_V2'] = '1';
    process.env['MRCP_SIP_CODEC_LIST'] = 'PCMU'; // offer only PCMU/PT0
    const udp = await startUdpSipMock(101); // answer with dynamic 101 not offered
    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: `sip://127.0.0.1:${udp.port}/resource`,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
    const snap: any = session.getTelemetry!();
  // sipConfig now sanitizes and ensures at least PCMU; here we only set PCMU so offered=1
  expect(snap.sipCodecOffered).toBeGreaterThanOrEqual(1);
    expect(snap.sipCodecSelected).toBe('PT101');
    session.close();
    await udp.close();
  });
});
