import net from 'net';

jest.setTimeout(15000);

function loadSignaling() {
  const p = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete require.cache[p];
  return require('../../src/sidecar/signaling/unimrcp-signaling') as typeof import('../../src/sidecar/signaling/unimrcp-signaling');
}

describe('Session duration telemetry', () => {
  test('sessionDurationMs populated after close and metrics include sums', async () => {
    // Simple TCP SIP mock for quick success
    process.env['MRCP_TEST_DEBUG'] = '1';
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];
    const server = net.createServer((sock) => {
      let buf='';
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n') && buf.startsWith('INVITE')) {
          const sdp = [
            'v=0','o=- 0 0 IN IP4 127.0.0.1','s=Dur','c=IN IP4 127.0.0.1','t=0 0','m=audio 49555 RTP/AVP 0','a=ptime:20',''
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
              sdp,
            ].join('\r\n');
            sock.write(res, () => sock.end());
        }
      });
    });
    const port = await new Promise<number>(r => server.listen(0,'127.0.0.1', () => r((server.address() as any).port)));
    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: `sip://127.0.0.1:${port}/resource`,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
    await new Promise(r => setTimeout(r, 120));
    session.close();
  const snap: any = session.getTelemetry!();
  expect(snap.endedAt).toBeDefined();
  expect(snap.sessionDurationMs).toBeGreaterThan(0);
    // metrics text (direct renderer – no HTTP sidecar started in this test)
    const { registerTelemetryProvider, unregisterTelemetryProvider, renderMetrics } = require('../../src/sidecar/signaling/metrics');
    const provider = () => session.getTelemetry!();
    registerTelemetryProvider(provider);
    const metricsText: string = renderMetrics();
    unregisterTelemetryProvider(provider);
    expect(metricsText).toMatch(/mrcp_sessions_closed_total/);
    expect(metricsText).toMatch(/mrcp_session_duration_ms_sum/);
    await new Promise(r => server.close(r));
  });
});
