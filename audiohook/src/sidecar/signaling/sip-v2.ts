/*
  Minimal SIP INVITE helper (skeleton) to obtain SDP answer.
  - Sends a very small INVITE over UDP is typical, but for simplicity we use TCP here (port 5060 by default) to avoid UDP socket code.
  - Expects a single 200 OK with SDP, then we stop (no ACK implementation yet).
  - Returns parsed remote RTP port and optional payloadType / ptime.
  Limitations:
    * No Via branch matching, retransmission, transaction state machine.
    * No ACK, no dialog establishment, no SDP offer/answer negotiation beyond single m=audio line.
*/
import * as net from 'net';
import { parseSdp } from './unimrcp-signaling'; // reuse existing SDP parser (ensure it's exported)

export interface SipInviteResult {
  remotePort: number;
  payloadType?: number;
  ptimeMs?: number;
  rawSdp?: string;
  dialog?: {
    callId: string;
    fromTag: string;
    toTag?: string;
    viaBranch: string;
    cseq: number;
    target: string; // Request-URI for ACK/BYE
    host: string;
    port: number;
    transport: 'tcp' | 'udp';
  };
}

export async function performSipInvite(endpoint: string, localIp: string, localPort: number, payloadType: number, timeoutMs = 4000): Promise<SipInviteResult> {
  if (process.env['MRCP_TEST_FORCE_SIP_TIMEOUT'] === '1') {
    // Consume flag so only the very first attempted INVITE fails; subsequent attempts succeed.
    delete process.env['MRCP_TEST_FORCE_SIP_TIMEOUT'];
    await new Promise(r => setTimeout(r, Math.min(30, timeoutMs)));
    throw new Error('SIP INVITE timeout');
  }
  const u = new URL(endpoint.replace(/^sip\+tcp:/,'sip:'));
  const host = u.hostname;
  const port = Number(u.port || 5060);
  const viaBranch = `z9hG4bK-${Math.random().toString(16).slice(2)}`;
  const callId = `${Date.now()}-${Math.random().toString(16).slice(2)}@${localIp}`;
  const fromTag = Math.random().toString(16).slice(2);
  const to = `sip:${host}`;
  const from = `sip:audiohook@${localIp}`;
  const contact = `sip:audiohook@${localIp}`;
  const cseq = 1;
  const sdpLines = [
    'v=0',
    `o=- 0 0 IN IP4 ${localIp}`,
    's=AudioHook',
    `c=IN IP4 ${localIp}`,
    't=0 0',
    `m=audio ${localPort} RTP/AVP ${payloadType}`,
    'a=rtpmap:0 PCMU/8000',
  ];
  const sdp = sdpLines.join('\r\n') + '\r\n';
  const reqLines = [
    `INVITE sip:${host} SIP/2.0`,
    `Via: SIP/2.0/TCP ${localIp};branch=${viaBranch}`,
    'Max-Forwards: 70',
    `To: <${to}>`,
    `From: <${from}>;tag=${fromTag}`,
    `Call-ID: ${callId}`,
    `CSeq: ${cseq} INVITE`,
    `Contact: <${contact}>`,
    'Content-Type: application/sdp',
    `Content-Length: ${Buffer.byteLength(sdp)}`,
    '',
    sdp,
  ];
  const rawReq = reqLines.join('\r\n');

  return await new Promise<SipInviteResult>((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    // Explicit idle timeout (covers stalled server that never replies)
    sock.setTimeout(timeoutMs);
    // Safety hard timer in case 'timeout' event not emitted (rare)
    const hardTimer = setTimeout(() => {
      sock.destroy(new Error('SIP INVITE timeout')); // will trigger error handler below
    }, timeoutMs + 20);
    let buf = '';
  const cleanup = () => { clearTimeout(hardTimer); sock.removeAllListeners(); sock.destroy(); };
    sock.on('connect', () => { sock.write(rawReq); });
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // naive: wait for double CRLF + SDP terminator 'm=audio' presence
      if (!buf.includes('\r\n\r\n')) return;
      const [headers, body] = buf.split(/\r\n\r\n/);
      const status = headers.split(/\r\n/)[0] || '';
      if (!status.includes('200')) {
        cleanup();
        return reject(new Error(`SIP INVITE non-200: ${status}`));
      }
      try {
        const { remotePort, payloadType: pt, ptimeMs } = parseSdp(body || '');
        // Try to extract To tag
        let toTag: string | undefined;
        const toHeader = headers.split(/\r\n/).find(l => l.toLowerCase().startsWith('to:'));
        if (toHeader) {
          const m = /;tag=([^;>\s]+)/i.exec(toHeader);
            if (m) toTag = m[1];
        }
        cleanup();
        resolve({
          remotePort,
            payloadType: pt,
            ptimeMs,
            rawSdp: body,
            dialog: {
              callId,
              fromTag,
              toTag,
              viaBranch,
              cseq,
              target: `sip:${host}`,
              host,
              port,
              transport: 'tcp',
            },
        });
      } catch (e) {
        cleanup();
        reject(e);
      }
    });
    sock.on('timeout', () => { cleanup(); reject(new Error('SIP INVITE timeout')); });
    sock.on('error', (e) => { cleanup(); reject(e); });
  });
}

// Best-effort ACK (fire-and-forget). No retransmission logic.
export function sendSipAck(localIp: string, dialog: SipInviteResult['dialog']): void {
  if (!dialog) return;
  const viaTransport = dialog.transport === 'udp' ? 'UDP' : 'TCP';
  const ackLines = [
    `ACK ${dialog.target} SIP/2.0`,
    `Via: SIP/2.0/${viaTransport} ${localIp};branch=${dialog.viaBranch}`,
    `To: <${dialog.target}>${dialog.toTag ? `;tag=${dialog.toTag}` : ''}`,
    `From: <sip:audiohook@${localIp}>;tag=${dialog.fromTag}`,
    `Call-ID: ${dialog.callId}`,
    `CSeq: ${dialog.cseq} ACK`,
    '',
    '',
  ];
  const raw = ackLines.join('\r\n');
  if (dialog.transport === 'udp') {
    try {
      const dgram = require('dgram');
      const s = dgram.createSocket('udp4');
      s.send(Buffer.from(raw, 'utf8'), dialog.port, dialog.host, () => { try { s.close(); } catch { /* ignore */ } });
    } catch { /* noop */ }
  } else {
    const sock = net.createConnection({ host: dialog.host, port: dialog.port }, () => {
      sock.write(raw, () => sock.end());
    });
    // swallow errors
    sock.on('error', () => { /* noop */ });
  }
}

// Best-effort BYE for close().
export function sendSipBye(localIp: string, dialog: SipInviteResult['dialog']): void {
  if (!dialog) return;
  const viaTransport = dialog.transport === 'udp' ? 'UDP' : 'TCP';
  const byeLines = [
    `BYE ${dialog.target} SIP/2.0`,
    `Via: SIP/2.0/${viaTransport} ${localIp};branch=${dialog.viaBranch}-bye` ,
    `To: <${dialog.target}>${dialog.toTag ? `;tag=${dialog.toTag}` : ''}`,
    `From: <sip:audiohook@${localIp}>;tag=${dialog.fromTag}`,
    `Call-ID: ${dialog.callId}`,
    `CSeq: ${dialog.cseq + 1} BYE`,
    'Content-Length: 0',
    '',
    '',
  ];
  const raw = byeLines.join('\r\n');
  if (dialog.transport === 'udp') {
    try {
      const dgram = require('dgram');
      const s = dgram.createSocket('udp4');
      s.send(Buffer.from(raw, 'utf8'), dialog.port, dialog.host, () => { try { s.close(); } catch { /* ignore */ } });
    } catch { /* noop */ }
  } else {
    const sock = net.createConnection({ host: dialog.host, port: dialog.port }, () => {
      sock.write(raw, () => sock.end());
    });
    sock.on('error', () => { /* noop */ });
  }
}
