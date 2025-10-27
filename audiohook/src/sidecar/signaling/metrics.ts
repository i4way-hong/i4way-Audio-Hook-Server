import { MrcpTelemetrySnapshot } from './telemetry';

type Provider = () => MrcpTelemetrySnapshot | undefined;

const providers: Set<Provider> = new Set();

export function registerTelemetryProvider(p: Provider): void {
  providers.add(p);
}

export function unregisterTelemetryProvider(p: Provider): void {
  providers.delete(p);
}

// Simple Prometheus exposition (no external deps)
export function renderMetrics(): string {
  const agg: Partial<MrcpTelemetrySnapshot> & { sessions: number } = { sessions: 0 };
  for (const p of providers) {
    try {
      const snap = p();
      if (!snap) continue;
      agg.sessions += 1;
      for (const [k, v] of Object.entries(snap)) {
        if (typeof v === 'number') {
          (agg as any)[k] = ((agg as any)[k] || 0) + v;
        }
      }
    } catch {
      // ignore provider errors
    }
  }
  const lines: string[] = [];
  const push = (name: string, help: string, value: number | undefined) => {
    if (value === undefined) return;
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  };
  push('mrcp_sessions', 'Current sessions registered', agg.sessions);
  push('mrcp_partial_total', 'Total partial result events', (agg as any).partialCount);
  push('mrcp_final_total', 'Total final result events', (agg as any).finalCount);
  push('mrcp_error_total', 'Total error events', (agg as any).errorCount);
  push('mrcp_sip_attempts_total', 'Total SIP attempts', (agg as any).sipAttempts);
  push('mrcp_sip_success_total', 'Total SIP success', (agg as any).sipSuccess);
  push('mrcp_sip_fail_total', 'Total SIP fail', (agg as any).sipFail);
  // v2 split counters (only appear if telemetry emitted them)
  push('mrcp_sip_udp_attempts_total', 'Total SIP UDP attempts', (agg as any).sipUdpAttempts);
  push('mrcp_sip_udp_success_total', 'Total SIP UDP success', (agg as any).sipUdpSuccess);
  push('mrcp_sip_udp_fail_total', 'Total SIP UDP fail', (agg as any).sipUdpFail);
  push('mrcp_sip_tcp_attempts_total', 'Total SIP TCP attempts', (agg as any).sipTcpAttempts);
  push('mrcp_sip_tcp_success_total', 'Total SIP TCP success', (agg as any).sipTcpSuccess);
  push('mrcp_sip_tcp_fail_total', 'Total SIP TCP fail', (agg as any).sipTcpFail);
  push('mrcp_rtsp_describe_attempts_total', 'Total RTSP DESCRIBE attempts', (agg as any).rtspDescribeAttempts);
  push('mrcp_rtsp_setup_attempts_total', 'Total RTSP SETUP attempts', (agg as any).rtspSetupAttempts);
  push('mrcp_fallback5004_total', 'Total fallback-to-5004 occurrences', (agg as any).fallback5004Count);
  push('mrcp_rtp_packets_received_total', 'Total RTP packets observed (receive or send proxy)', (agg as any).rtpPacketsReceived);
  push('mrcp_sessions_closed_total', 'Total sessions closed', (agg as any).sessionsClosed);
  push('mrcp_session_duration_ms_sum', 'Sum of session durations (ms) over closed sessions', (agg as any).sessionDurationMs);
  // Phase1 new SIP metrics
  push('mrcp_sip_provisional_total', 'Total SIP provisional (1xx) responses observed', (agg as any).sipProvisional);
  push('mrcp_sip_invite_retransmits_total', 'Total SIP INVITE retransmissions (UDP)', (agg as any).sipInviteRetransmits);
  push('mrcp_sip_invite_rtt_ms_sum', 'Sum of SIP INVITE RTT (ms)', (agg as any).sipInviteRttMsSum);
  push('mrcp_sip_invite_rtt_ms_count', 'Count of SIP INVITE RTT samples', (agg as any).sipInviteRttMsCount);
  push('mrcp_sip_invite_rtt_ms_avg', 'Average SIP INVITE RTT (ms, rounded)', (agg as any).averageInviteRttMs);
  push('mrcp_sip_codec_offered', 'Count of codecs offered in SIP INVITE (simple count)', (agg as any).sipCodecOffered);
  // codec selected: represent as gauge with numeric 1 when known (label would require richer exposition logic)
  if ((agg as any).sipCodecSelected) {
    lines.push('# HELP mrcp_sip_codec_selected SIP codec selected (info metric: value always 1, label=codec)');
    lines.push('# TYPE mrcp_sip_codec_selected gauge');
    const codec = (agg as any).sipCodecSelected;
    lines.push(`mrcp_sip_codec_selected{codec="${codec}"} 1`);
  }
  return lines.join('\n') + '\n';
}
