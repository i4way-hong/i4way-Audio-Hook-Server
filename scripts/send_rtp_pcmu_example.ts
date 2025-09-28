/**
 * Minimal RTP PCMU (G.711 u-law) sender example.
 * 목적: UniMRCP RTSP SETUP 후 SDP에서 얻은 remote RTP 포트로 테스트 패킷 송출.
 * 사용 전제: remote IP/포트 및 payload type(기본 PCMU 0) 알고 있음.
 *
 * 실행 예시 (PowerShell):
 *   ts-node scripts/send_rtp_pcmu_example.ts --host 127.0.0.1 --port 40002 --seconds 5 --rate 8000 --ptime 20
 *
 * 단순 톤(1kHz) 생성 → PCMU 인코딩 → RTP 헤더 붙여 전송.
 */
import dgram from 'dgram';
import { argv } from 'process';

interface Args {
  host: string;
  port: number;
  seconds: number;
  rate: number; // sample rate (e.g. 8000)
  ptime: number; // packetization time ms
  payloadType: number; // RTP payload type (0 = PCMU)
}

function parseArgs(): Args {
  const get = (flag: string, def?: string) => {
    const idx = argv.indexOf(flag);
    if (idx >= 0 && idx + 1 < argv.length) return argv[idx + 1];
    return def;
  };
  return {
    host: get('--host', '127.0.0.1')!,
    port: Number(get('--port', '40002')),
    seconds: Number(get('--seconds', '5')),
    rate: Number(get('--rate', '8000')),
    ptime: Number(get('--ptime', '20')),
    payloadType: Number(get('--pt', '0')),
  };
}

function pcm16ToUlaw(sample: number): number {
  // Clamp
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > 32635) sample = 32635;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  const mantissa = (sample >> ((exponent === 0) ? 4 : (exponent + 3))) & 0x0F;
  let ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  if (ulawByte === 0) ulawByte = 0x02; // quiet adjustment
  return ulawByte;
}

async function main() {
  const args = parseArgs();
  const { host, port, seconds, rate, ptime, payloadType } = args;
  const samplesPerPacket = (rate * ptime) / 1000; // e.g., 8000 * 20ms = 160 samples
  const totalPackets = Math.ceil((seconds * 1000) / ptime);

  console.log(`[rtp-sender] host=${host} port=${port} seconds=${seconds} rate=${rate} ptime=${ptime} packets=${totalPackets}`);

  const socket = dgram.createSocket('udp4');
  let seq = 0;
  let timestamp = 0;
  const ssrc = Math.floor(Math.random() * 0xffffffff);

  const toneFreq = 1000; // 1kHz test tone
  for (let i = 0; i < totalPackets; i++) {
    const pcm: number[] = [];
    for (let s = 0; s < samplesPerPacket; s++) {
      const t = (timestamp + s) / rate;
      // Sine wave amplitude 0.2 * max
      const sample = Math.round(Math.sin(2 * Math.PI * toneFreq * t) * 32767 * 0.2);
      pcm.push(pcm16ToUlaw(sample));
    }

    const rtp = Buffer.alloc(12 + pcm.length);
    // RTP header
    rtp[0] = 0x80; // V=2,P=0,X=0,CC=0
    rtp[1] = payloadType & 0x7f; // M=0 + PT
    rtp.writeUInt16BE(seq & 0xffff, 2);
    rtp.writeUInt32BE(timestamp >>> 0, 4);
    rtp.writeUInt32BE(ssrc >>> 0, 8);
    for (let k = 0; k < pcm.length; k++) rtp[12 + k] = pcm[k];

    // 명시적 offset/length + 콜백으로 타입 호환 문제 회피 (TS dgram overload)
    await new Promise<void>((res, rej) => {
      const view = new Uint8Array(rtp.buffer, rtp.byteOffset, rtp.byteLength);
      socket.send(view, 0, view.length, port, host, (err) => {
        if (err) return rej(err);
        res();
      });
    });
    seq++;
    timestamp += samplesPerPacket;
    await new Promise(r => setTimeout(r, ptime));
  }

  socket.close();
  console.log('[rtp-sender] done');
}

main().catch(e => {
  console.error('[rtp-sender] error', e);
  process.exit(1);
});
