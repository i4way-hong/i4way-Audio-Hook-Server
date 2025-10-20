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
import { sipConfig } from './sip-config';
import { SipInviteResult } from './sip-v2';
import { MrcpTelemetry } from './telemetry';
import { loadNetworkSimConfig, simulatedSend, NetworkSimRuntime } from './network-sim';

export interface SipUdpInviteOptions {
  endpoint: string; // sip:host[:port]
  localIp: string;
  localRtpPort: number;
  payloadType: number; // 0 (PCMU) etc
  maxTransmits?: number; // default 5
  t1Ms?: number; // base timer (default 500ms)
  overallTimeoutMs?: number; // guard (default 8000ms)
  telemetry?: MrcpTelemetry; // optional telemetry wiring
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

  // Multi-codec offer support (Bundle 2)
  const codecEnv = sipConfig.codecList; // already sanitized upper-case names
  const known: { name: string; pt: number; rtpmap?: string }[] = [];
  const dynStart = 96;
  let dynPt = dynStart;
  for (const c of codecEnv) {
    const upper = c.toUpperCase();
    if (upper === 'PCMU' && !known.find(k=>k.pt===0)) known.push({ name: 'PCMU', pt: 0, rtpmap: 'PCMU/8000' });
    else if (upper === 'PCMA' && !known.find(k=>k.pt===8)) known.push({ name: 'PCMA', pt: 8, rtpmap: 'PCMA/8000' });
    else if (upper === 'L16' || upper === 'L16/8000') {
      if (!known.find(k=>k.name.startsWith('L16'))) {
        const pt = dynPt++;
        known.push({ name: 'L16', pt, rtpmap: 'L16/8000/1' });
      }
    }
    // ignore unknown for now
  }
  if (known.length === 0) {
    // fallback single PCMU
    known.push({ name: 'PCMU', pt: 0, rtpmap: 'PCMU/8000' });
  }
  try { opts.telemetry?.setSipCodecOffered(known.length); } catch { /* ignore */ }
  const mPayloads = known.map(k=>k.pt).join(' ');
  const sdpLines = [
    'v=0',
    `o=- 0 0 IN IP4 ${opts.localIp}`,
    's=AudioHook',
    `c=IN IP4 ${opts.localIp}`,
    't=0 0',
    `m=audio ${opts.localRtpPort} RTP/AVP ${mPayloads}`,
    ...known.filter(k=>k.pt>=96).map(k=>`a=rtpmap:${k.pt} ${k.rtpmap}`),
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
  // offered count already recorded above

  const maxTransmits = opts.maxTransmits ?? sipConfig.maxRetrans; // validated
  const t1 = opts.t1Ms ?? sipConfig.t1Ms; // base (validated range)
  const t2 = Math.max(t1, Math.min( (opts.t1Ms ? opts.t1Ms*8 : 4000), 8000)); // cap growth (simplified)
  // Timer B overall timeout. RFC3261 suggests 64*T1 (which with T1=500ms would be 32s) but
  // for quicker fallback behavior in this simplified client we default to 5000ms unless overridden.
  const overallTimeout = opts.overallTimeoutMs ?? sipConfig.overallTimeoutMs;

  return await new Promise<SipInviteResult>((resolve, reject) => {
    const sock = dgram.createSocket('udp4');
    let netSim: NetworkSimRuntime | undefined;
    const getSim = () => {
      if (!netSim) netSim = loadNetworkSimConfig();
      return netSim.enabled ? netSim : undefined;
    };
    let closed = false;
    let state: 'CALLING' | 'PROCEEDING' | 'COMPLETED' = 'CALLING';
    let transmitCount = 0;
    let firstSendAt: number | undefined;
    let timerA: NodeJS.Timeout | undefined;
    let timerB: NodeJS.Timeout | undefined;
    let currentDelay = t1;

    const clearTimers = () => {
      if (timerA) clearTimeout(timerA);
      if (timerB) clearTimeout(timerB);
      timerA = undefined; timerB = undefined;
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearTimers();
      try { sock.close(); } catch { /* ignore */ }
    };
    const scheduleTimerA = () => {
      if (state !== 'CALLING') return; // stop retransmits after provisional per simplified model
      if (transmitCount >= maxTransmits) return; // safety cap
      timerA = setTimeout(() => {
        retransmit();
      }, currentDelay);
    };
    const retransmit = () => {
      if (closed || state === 'COMPLETED') return;
      transmitCount++;
      // growth
      if (transmitCount > 1) {
        try { opts.telemetry?.markSipInviteRetransmit(); } catch { /* ignore */ }
        currentDelay = Math.min(currentDelay * 2, t2);
      }
      const u8 = new Uint8Array(rawReq);
      simulatedSend({ socket: sock, msg: u8, port, host, sim: getSim(), attempt: transmitCount + 1, onSend: (err) => {
        if (err) { cleanup(); return reject(err); }
      }});
      if (!firstSendAt) firstSendAt = Date.now();
      scheduleTimerA();
    };
    // Timer B (overall)
    timerB = setTimeout(() => {
      if (state === 'COMPLETED') return; // ignore if already done
      try { opts.telemetry?.markInviteTimeout(); } catch { /* ignore */ }
      cleanup();
      reject(new Error('SIP UDP INVITE timeout (Timer B)'));
    }, overallTimeout);

    // First send immediately
    retransmit();

    sock.on('message', (msg) => {
      // Very naive parser: treat entire datagram as text
      const txt = msg.toString('utf8');
      if (!/SIP\/2.0 200/.test(txt)) {
        // Provisional? (1xx)
        if (/SIP\/2.0 1\d\d/.test(txt)) {
          try { opts.telemetry?.markSipProvisional(); } catch { /* ignore */ }
          if (state === 'CALLING') {
            state = 'PROCEEDING';
            // stop Timer A retransmissions after first provisional (simplified behavior)
            if (timerA) { clearTimeout(timerA); timerA = undefined; }
          }
        }
        return; // ignore non-final
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
        // RTT measurement
        if (firstSendAt) {
          const rtt = Date.now() - firstSendAt;
            try { opts.telemetry?.addSipInviteRtt(rtt); } catch { /* ignore */ }
        }
        // codec selected mapping (answer PT -> known name fallback PTxx)
        try {
          if (typeof payloadType === 'number') {
            const found = known.find(k=>k.pt===payloadType);
            const codec = found ? found.name : (payloadType===0?'PCMU':payloadType===8?'PCMA':('PT'+payloadType));
            opts.telemetry?.setSipCodecSelected(codec);
          }
        } catch { /* ignore */ }
        state = 'COMPLETED';
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
  });
}
