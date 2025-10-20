/* SIP signaling config validation (Bundle 4)
 * Centralizes validation of environment-driven SIP timing & codec list.
 */

export interface SipConfigState {
  t1Ms: number;          // base Timer A (RFC default 500ms)
  maxRetrans: number;    // maximum INVITE sends (including first) ( >=1 )
  overallTimeoutMs: number; // Timer B guard (default 5000 for our simplified client)
  codecList: string[];   // sanitized ordered list
}

const DEFAULTS: SipConfigState = {
  t1Ms: 500,
  maxRetrans: 8,
  overallTimeoutMs: 5000,
  codecList: ['PCMU'],
};

function toInt(val: string | undefined, fallback: number): number {
  if (val === undefined) return fallback;
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.floor(n);
}

function sanitizeCodecList(raw: string | undefined): string[] {
  if (!raw) return [...DEFAULTS.codecList];
  const parts = raw.split(/[,;]/).map(s=>s.trim().toUpperCase()).filter(Boolean);
  const allowed = new Set(['PCMU','PCMA','L16','L16/8000']);
  const out: string[] = [];
  for (const p of parts) {
    if (!allowed.has(p)) continue;
    const norm = p === 'L16/8000' ? 'L16' : p;
    if (!out.includes(norm)) out.push(norm);
  }
  if (out.length === 0) out.push('PCMU');
  return out;
}

export class SipConfig {
  private state: SipConfigState;
  constructor() {
    this.state = this.load();
  }
  private load(): SipConfigState {
    const t1 = toInt(process.env['MRCP_SIP_T1_MS'], DEFAULTS.t1Ms);
    const maxRetrans = toInt(process.env['MRCP_SIP_MAX_RETRANS'], DEFAULTS.maxRetrans);
    const overall = toInt(process.env['MRCP_SIP_INVITE_TIMEOUT_MS'], DEFAULTS.overallTimeoutMs);
    const codecList = sanitizeCodecList(process.env['MRCP_SIP_CODEC_LIST']);
    const errors: string[] = [];
    if (t1 < 100 || t1 > 5000) errors.push(`MRCP_SIP_T1_MS out of range (100-5000): ${t1}`);
    if (maxRetrans < 1 || maxRetrans > 15) errors.push(`MRCP_SIP_MAX_RETRANS out of range (1-15): ${maxRetrans}`);
  const minOverall = t1 * 2;
  const allowLow = !!process.env['MRCP_TEST_ALLOW_LOW_TIMEOUT'];
  if (!allowLow && (overall < minOverall || overall > 60000)) errors.push(`MRCP_SIP_INVITE_TIMEOUT_MS out of range (${minOverall}-60000): ${overall}`);
    if (errors.length) {
      // Fail fast: throw aggregated error
      throw new Error('SIP config validation failed:\n' + errors.join('\n'));
    }
    return { t1Ms: t1, maxRetrans, overallTimeoutMs: overall, codecList };
  }
  get t1Ms() { return this.state.t1Ms; }
  get maxRetrans() { return this.state.maxRetrans; }
  get overallTimeoutMs() { return this.state.overallTimeoutMs; }
  get codecList() { return [...this.state.codecList]; }
  snapshot(): SipConfigState { return { ...this.state, codecList: [...this.state.codecList] }; }
}

export const sipConfig = new SipConfig();
