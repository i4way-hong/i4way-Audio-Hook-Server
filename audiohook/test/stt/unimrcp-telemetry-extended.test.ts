import net from 'net';

jest.setTimeout(20000);

// Helper to load fresh signaling module after env tweaks
function loadSignaling() {
  const p = require.resolve('../../src/sidecar/signaling/unimrcp-signaling');
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete require.cache[p];
  return require('../../src/sidecar/signaling/unimrcp-signaling') as typeof import('../../src/sidecar/signaling/unimrcp-signaling');
}

describe('Telemetry extended', () => {
  afterAll(() => {
    // Ensure no stray environment side-effects linger for other suites
    delete process.env['MRCP_SIP_INVITE_RETRIES'];
    delete process.env['MRCP_SIP_INVITE_TIMEOUT_MS'];
    delete process.env['MRCP_RTSP_DESCRIBE_RETRIES'];
  });
  test('SIP success with one timeout retry updates invite counters', async () => {
    // First connection: server accepts and stalls -> client times out via socket timeout.
    // Second connection: server responds 200 OK with SDP.
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];
    process.env['MRCP_SIP_INVITE_RETRIES'] = '2';
    process.env['MRCP_SIP_INVITE_TIMEOUT_MS'] = '160';
    process.env['MRCP_RESULT_PARTIAL_INTERVAL_MS'] = '60';
    process.env['MRCP_RESULT_FINAL_AFTER_MS'] = '300';
  process.env['MRCP_TEST_FORCE_SIP_TIMEOUT'] = '1'; // synthetic first failure

    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('\r\n\r\n')) {
          if (buf.startsWith('INVITE')) {
            const sdp = [
              'v=0','o=- 0 0 IN IP4 127.0.0.1','s=RetrySuccess','c=IN IP4 127.0.0.1','t=0 0','m=audio 49170 RTP/AVP 0','a=ptime:20',''
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
          } else {
            sock.end();
          }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0,'127.0.0.1', resolve));
    const port = (server.address() as any).port;
    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: `sip://127.0.0.1:${port}/resource`,
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
  expect(session.remotePort).toBe(49170);
    // wait for at least one partial
    await new Promise(r => setTimeout(r, 220));
    const snap = session.getTelemetry!();
    expect(snap.sipSuccess).toBe(1);
    expect(snap.sipAttempts).toBe(2); // one timeout + one success
    expect(snap.inviteRetries).toBe(1);
    expect((snap.inviteTimeouts||0)).toBeGreaterThanOrEqual(1);
    expect(snap.sessionsSip).toBe(1);
  session.close();
  await new Promise(r => server.close(r));
  });

  test('SIP failure fallback increments sipFail and sessionsRtsp', async () => {
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    delete process.env['MRCP_FORCE_RTSP'];
    process.env['MRCP_SIP_INVITE_RETRIES'] = '2';
    process.env['MRCP_SIP_INVITE_TIMEOUT_MS'] = '150';
    process.env['MRCP_RESULT_PARTIAL_INTERVAL_MS'] = '50';
    process.env['MRCP_RESULT_FINAL_AFTER_MS'] = '250';
    // Unused port with no server for SIP
    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: 'sip://127.0.0.1:59/unavail',
      profileId: 'ah-mrcpv2',
      codec: 'PCMU',
      sampleRate: 8000,
    });
    await new Promise(r => setTimeout(r, 220));
    const snap = session.getTelemetry!();
    expect(snap.sipFail).toBe(1);
    expect(snap.sipAttempts).toBeGreaterThanOrEqual(1);
    expect(snap.sessionsRtsp).toBe(1);
    // error buffer should have SIP_INVITE_FAILED
    const errs = session.getBufferedErrors!();
    expect(errs.some(e => (e as any).code === 'SIP_INVITE_FAILED')).toBe(true);
  session.close();
  });

  test('RTSP negotiation total failure -> fallback5004 counters', async () => {
    process.env['MRCP_FORCE_RTSP'] = '1';
    process.env['MRCP_DISABLE_NATIVE'] = '1';
    process.env['MRCP_RTSP_DESCRIBE_RETRIES'] = '2';
    // choose unlikely listening port (no server) to force failure
    const signaling = loadSignaling();
    const session = await signaling.openSession({
      endpoint: 'rtsp://127.0.0.1:49999/unimrcp',
      profileId: 'ah-mrcpv1',
      codec: 'PCMU',
      sampleRate: 8000,
    });
    // allow fallback result timer maybe not necessary
    const snap = session.getTelemetry!();
    expect(snap.fallback5004Count).toBe(1);
    expect(snap.rtspDescribeFail).toBe(1);
    expect(snap.sessionsRtsp).toBe(1);
    expect(snap.lastErrorCode).toBe('RTSP_FALLBACK_5004');
  session.close();
  });
});
