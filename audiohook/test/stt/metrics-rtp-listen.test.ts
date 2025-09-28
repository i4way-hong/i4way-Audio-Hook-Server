import dgram from 'dgram';

jest.setTimeout(20000);

function loadSignaling() {
  const p = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete require.cache[p];
  return require('../../src/sidecar/signaling/unimrcp-signaling') as typeof import('../../src/sidecar/signaling/unimrcp-signaling');
}

// Simple helper to fetch /metrics from the running process HTTP server if available.
// NOTE: In this test we directly spin up a minimal HTTP server when needed instead of depending on main app bootstrap.

describe('Metrics + RTP listen integration', () => {
  test('rtpPacketsReceived reflected in /metrics', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    process.env['MRCP_FORCE_RTSP'] = '1'; // ensure RTSP path
    process.env['MRCP_ENABLE_RTP_LISTEN'] = '1';
    process.env['MRCP_RTSP_DESCRIBE_RETRIES'] = '1';

    // Mock RTSP server (DESCRIBE + SETUP happy path)
    const net = require('net');
    const rtspServer = net.createServer((sock: any) => {
      let buf = '';
      sock.on('data', (d: Buffer) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) {
          if (buf.startsWith('DESCRIBE')) {
            const sdp = [
              'v=0','o=- 0 0 IN IP4 127.0.0.1','s=Mock','c=IN IP4 127.0.0.1','t=0 0','m=audio 45000 RTP/AVP 0','a=ptime:20',''
            ].join('\r\n');
            const res = [
              'RTSP/1.0 200 OK',
              'CSeq: 1',
              'Content-Type: application/sdp',
              `Content-Length: ${Buffer.byteLength(sdp)}`,
              '',
              sdp,
            ].join('\r\n');
            sock.write(res);
            buf='';
          } else if (buf.startsWith('SETUP')) {
            const res = [
              'RTSP/1.0 200 OK',
              'CSeq: 2',
              'Transport: RTP/AVP;unicast;server_port=46000-46001',
              '',
              '',
            ].join('\r\n');
            sock.write(res, () => sock.end());
          }
        }
      });
    });
    await new Promise<void>(res => rtspServer.listen(0,'127.0.0.1',res));
    const rtspPort = (rtspServer.address() as any).port;

    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: `rtsp://127.0.0.1:${rtspPort}/unimrcp`,
      profileId: 'ah-mrcpv1',
      codec: 'PCMU',
      sampleRate: 8000,
    });

    const localPort = (session as any).localPort as number | undefined;
    expect(localPort).toBeDefined();

    // Send a few fake RTP packets (minimal header with V=2)
    const sock = dgram.createSocket('udp4');
    const rtpHeader = Buffer.from([0x80, 0x00, 0x00, 0x01, 0,0,0,1, 0,0,0,1]); // 12 bytes
    for (let i = 0; i < 3; i++) {
      await new Promise<void>((resolve, reject) => {
        const u8 = new Uint8Array(rtpHeader);
        sock.send(u8, 0, u8.length, localPort!, '127.0.0.1', (err) => err ? reject(err) : resolve());
      });
    }
    sock.close();

    // Allow event loop to process 'rtp-packet' events
    await new Promise(r => setTimeout(r, 150));
    const snap = session.getTelemetry!();
    expect((snap.rtpPacketsReceived||0)).toBeGreaterThanOrEqual(3);

    // Instead of spinning real sidecar HTTP server, emulate registry by registering single provider and calling render directly
    const { registerTelemetryProvider, unregisterTelemetryProvider, renderMetrics } = require('../../src/sidecar/signaling/metrics');
    const provider = () => session.getTelemetry!();
    registerTelemetryProvider(provider);
    const metricsText: string = renderMetrics();
    unregisterTelemetryProvider(provider);

    expect(metricsText).toMatch(/mrcp_rtp_packets_received_total \d+/);
    // basic sanity for fallback counter presence (may be 1 if negotiation failed)
    expect(metricsText).toMatch(/mrcp_fallback5004_total/);

    session.close();
    await new Promise(r => rtspServer.close(r));
  });
});
