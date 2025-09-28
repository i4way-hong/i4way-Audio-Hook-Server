/* Minimal SIP over UDP INVITE skeleton (feature-flagged by MRCP_ENABLE_SIP_V2)
 * Goals:
 *  - Send INVITE with SDP offer (single m=audio) via UDP
 *  - Handle provisional (100/180) lightly, wait for single 200 OK with SDP
 *  - Retransmit INVITE (exponential up to 5 attempts) until 200 OK or timeout (Timer B)
 *  - Return parsed remote RTP port + dialog identifiers
 * Limitations:
 *  - No transaction layer separation / branch uniqueness beyond randomness
 *  - No Via rport handling, no NAT traversal, no authentication, no CANCEL flow
 *  - Best-effort ACK (fire-and-forget) handled by caller through sendSipAck reusing dialog
 */
import * as dgram from 'dgram';
import { parseSdp } from './unimrcp-signaling';
import { SipInviteResult } from './sip-v2';

export interface SipUdpInviteOptions {
  endpoint: string; // sip:host[:port]
  localIp: string;
  localRtpPort: number;
  payloadType: number; // 0 (PCMU) etc
  maxTransmits?: number; // default 5
  t1Ms?: number; // base timer (default 500ms)
  overallTimeoutMs?: number; // guard (default 8000ms)
}

export async function performSipInviteUdp(opts: SipUdpInviteOptions): Promise<SipInviteResult> {
  const u = new URL(opts.endpoint);
  const host = u.hostname;
  const port = Number(u.port || 5060);
  const viaBranch = `z9hG4bK-${Math.random().toString(16).slice(2)}`;
  const callId = `${Date.now()}-${Math.random().toString(16).slice(2)}@${opts.localIp}`;
  const fromTag = Math.random().toString(16).slice(2);
  const target = `sip:${host}`;
  const from = `sip:audiohook@${opts.localIp}`;
  const contact = `sip:audiohook@${opts.localIp}`;
  const cseq = 1;

  const sdpLines = [
    'v=0',
    `o=- 0 0 IN IP4 ${opts.localIp}`,
    's=AudioHook',
    `c=IN IP4 ${opts.localIp}`,
    't=0 0',
    `m=audio ${opts.localRtpPort} RTP/AVP ${opts.payloadType}`,
    'a=rtpmap:0 PCMU/8000',
  ];
  const sdp = sdpLines.join('\r\n') + '\r\n';
  const reqLines = [
    `INVITE ${target} SIP/2.0`,
    `Via: SIP/2.0/UDP ${opts.localIp};branch=${viaBranch}`,
    'Max-Forwards: 70',
    `To: <${target}>`,
    `From: <${from}>;tag=${fromTag}`,
    `Call-ID: ${callId}`,
    'CSeq: 1 INVITE',
    `Contact: <${contact}>`,
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
    '',
    sdp,
  ];
  const rawReq = Buffer.from(reqLines.join('\r\n'), 'utf8');

  const maxTransmits = opts.maxTransmits ?? 5; // attempts including first
  const t1 = opts.t1Ms ?? 500; // base
  const overallTimeout = opts.overallTimeoutMs ?? 8000;

  return await new Promise<SipInviteResult>((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let closed = false;
    const start = Date.now();
    let transmitCount = 0;
    const timers: NodeJS.Timeout[] = [];

    const cleanup = () => {
      if (closed) return;
      closed = true;
      timers.forEach(t => clearTimeout(t));
      try { sock.close(); } catch { /* ignore */ }
    };

    const sendInvite = () => {
      if (closed) return;
      transmitCount++;
      // Cast to Uint8Array for TS overload compatibility (Buffer implements it at runtime)
      const u8 = new Uint8Array(rawReq);
      sock.send(u8, 0, u8.length, port, host, (err) => {
        if (err) {
          cleanup();
          reject(err);
        }
      });
      // Schedule next retransmit if under limit
      if (transmitCount < maxTransmits) {
        const delay = t1 * Math.pow(2, transmitCount - 1); // exponential
        timers.push(setTimeout(sendInvite, delay));
      }
    };

    // Hard overall timeout
    timers.push(setTimeout(() => {
      cleanup();
      reject(new Error('SIP UDP INVITE timeout'));
    }, overallTimeout));

    sock.on('message', (msg) => {
      // Very naive parser: treat entire datagram as text
      const txt = msg.toString('utf8');
      if (!/SIP\/2.0 200/.test(txt)) {
        // ignore provisional or other
        return;
      }
      // Split header/body
      const parts = txt.split(/\r\n\r\n/);
      const headers = parts[0] || '';
      const body = parts[1] || '';
      try {
        const { remotePort, payloadType, ptimeMs } = parseSdp(body);
        // Extract To tag
        let toTag: string | undefined;
        const toLine = headers.split(/\r\n/).find(l => l.toLowerCase().startsWith('to:'));
        if (toLine) {
          const m = /;tag=([^;>\s]+)/i.exec(toLine);
          if (m) toTag = m[1];
        }
        cleanup();
        resolve({
          remotePort,
          payloadType,
          ptimeMs,
          rawSdp: body,
          dialog: { callId, fromTag, toTag, viaBranch, cseq, target, host, port, transport: 'udp' },
        });
      } catch (e) {
        cleanup();
        reject(e);
      }
    });

    sock.on('error', (e) => { cleanup(); reject(e); });

    // Kick off
    sendInvite();
  });
}
