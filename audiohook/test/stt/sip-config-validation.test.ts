import { sipConfig, SipConfig } from '../../src/sidecar/signaling/sip-config';

function clearEnv(keys: string[]) { for (const k of keys) delete process.env[k]; }

describe('SIP config validation', () => {
  afterEach(() => {
    clearEnv(['MRCP_SIP_T1_MS','MRCP_SIP_MAX_RETRANS','MRCP_SIP_INVITE_TIMEOUT_MS','MRCP_SIP_CODEC_LIST']);
  });

  test('defaults snapshot', () => {
    const snap = sipConfig.snapshot();
    expect(snap.t1Ms).toBe(500);
    expect(snap.maxRetrans).toBe(8);
    expect(snap.overallTimeoutMs).toBe(5000);
    expect(snap.codecList).toEqual(['PCMU']);
  });

  test('codec list sanitizes unknown + dedup + normalizes L16/8000', () => {
    process.env['MRCP_SIP_CODEC_LIST'] = 'pcmu,pcma,foo,L16/8000,PCMU,L16';
    const cfg = new SipConfig();
    expect(cfg.codecList).toEqual(['PCMU','PCMA','L16']);
  });

  test('range validation errors aggregate', () => {
    process.env['MRCP_SIP_T1_MS'] = '50'; // too low
    process.env['MRCP_SIP_MAX_RETRANS'] = '0';
    process.env['MRCP_SIP_INVITE_TIMEOUT_MS'] = '200'; // below 2*t1 wanted (100) but still maybe fails with t1
    try {
      // new construction should throw
      // eslint-disable-next-line no-new
      new SipConfig();
      throw new Error('expected throw');
    } catch (e) {
      const msg = String(e);
      expect(msg).toMatch('MRCP_SIP_T1_MS out of range');
      expect(msg).toMatch('MRCP_SIP_MAX_RETRANS out of range');
    }
  });

  test('overall timeout must be >= 2*T1', () => {
    process.env['MRCP_SIP_T1_MS'] = '400';
    process.env['MRCP_SIP_INVITE_TIMEOUT_MS'] = '500'; // less than 800
    expect(() => new SipConfig()).toThrow(/INVITE_TIMEOUT_MS/);
  });
});
