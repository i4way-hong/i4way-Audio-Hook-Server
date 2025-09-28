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
  let agg: Partial<MrcpTelemetrySnapshot> & { sessions: number } = { sessions: 0 };
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
  push('mrcp_rtsp_describe_attempts_total', 'Total RTSP DESCRIBE attempts', (agg as any).rtspDescribeAttempts);
  push('mrcp_rtsp_setup_attempts_total', 'Total RTSP SETUP attempts', (agg as any).rtspSetupAttempts);
  push('mrcp_fallback5004_total', 'Total fallback-to-5004 occurrences', (agg as any).fallback5004Count);
  push('mrcp_rtp_packets_received_total', 'Total RTP packets observed (receive or send proxy)', (agg as any).rtpPacketsReceived);
  return lines.join('\n') + '\n';
}
