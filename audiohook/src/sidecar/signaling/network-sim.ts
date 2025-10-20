/* Network simulation utilities for SIP UDP reliability harness (Bundle 5)
 * Allows injecting deterministic packet drop and artificial delay
 * for outbound UDP sends to the SIP server. Only enabled in tests.
 */
import * as dgram from 'dgram';

export interface NetworkSimConfig {
  dropRate: number; // 0..1 probability of dropping outbound packet
  baseDelayMs: number; // fixed delay added to outbound packet (before send)
  jitterMs: number; // +/- jitter applied uniformly
  seed: number; // deterministic PRNG seed
}

export interface NetworkSimRuntime extends NetworkSimConfig {
  enabled: boolean;
  rng: () => number;
}

function mulberry32(a: number): () => number {
  return function() {
    let t = a += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function loadNetworkSimConfig(env: NodeJS.ProcessEnv = process.env): NetworkSimRuntime {
  const dropRate = clamp(parseFloat(env['MRCP_SIP_TEST_PACKET_DROP_RATE'] || '0') || 0, 0, 1);
  const baseDelayMs = Math.max(0, parseInt(env['MRCP_SIP_TEST_PACKET_DELAY_MS'] || '0', 10) || 0);
  const jitterMs = Math.max(0, parseInt(env['MRCP_SIP_TEST_PACKET_JITTER_MS'] || '0', 10) || 0);
  const seed = parseInt(env['MRCP_SIP_TEST_SEED'] || '12345', 10) || 12345;
  const enabled = dropRate > 0 || baseDelayMs > 0 || jitterMs > 0;
  return { dropRate, baseDelayMs, jitterMs, seed, enabled, rng: mulberry32(seed >>> 0) };
}

function clamp(v: number, lo: number, hi: number): number { return v < lo ? lo : v > hi ? hi : v; }

export interface SimulatedSendOptions {
  socket: dgram.Socket;
  msg: Uint8Array; // Buffer extends Uint8Array so acceptable
  port: number;
  host: string;
  sim?: NetworkSimRuntime;
  attempt?: number; // 1 = first send, >1 = retransmit
  onSend: (err: Error | null) => void;
}

export function simulatedSend(opts: SimulatedSendOptions) {
  const { sim } = opts;
  if (!sim || !sim.enabled) {
    return opts.socket.send(opts.msg, 0, opts.msg.length, opts.port, opts.host, opts.onSend);
  }
  const logEnabled = Boolean(process.env['MRCP_SIP_TEST_LOG']);
  const persistent = Boolean(process.env['MRCP_SIP_TEST_PERSISTENT_DROP']);
  const attempt = opts.attempt ?? 1;
  let dropped = false;
  if (attempt === 1 || persistent) {
    const r = sim.rng();
    if (r < sim.dropRate) {
      dropped = true;
    }
  }
  if (dropped) {
    if (logEnabled) console.log(`[net-sim] drop attempt=${attempt}`);
    return setImmediate(() => opts.onSend(null));
  }
  let delay = sim.baseDelayMs;
  if (sim.jitterMs > 0) {
    const jr = (sim.rng() * 2 - 1) * sim.jitterMs; // [-jitter, +jitter]
    delay += jr;
    if (delay < 0) delay = 0;
  }
  if (delay === 0) {
    if (logEnabled) console.log(`[net-sim] send attempt=${attempt} immediate`);
    try {
      return opts.socket.send(opts.msg, 0, opts.msg.length, opts.port, opts.host, (err) => {
        if (err && (err as any).code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') return opts.onSend(null);
        opts.onSend(err);
      });
    } catch (e: any) {
      if (e && e.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') return opts.onSend(null);
      return opts.onSend(e);
    }
  }
  if (logEnabled) console.log(`[net-sim] send attempt=${attempt} delay=${delay.toFixed(1)}ms`);
  setTimeout(() => {
    try {
      opts.socket.send(opts.msg, 0, opts.msg.length, opts.port, opts.host, (err) => {
        if (err && (err as any).code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') return opts.onSend(null);
        opts.onSend(err);
      });
    } catch (e: any) {
      if (e && e.code === 'ERR_SOCKET_DGRAM_NOT_RUNNING') return opts.onSend(null);
      opts.onSend(e);
    }
  }, delay);
}
