'use strict';
/**
 * Simple STT TCP test server
 * - Accepts connections on tcp://<host>:<PORT>
 * - Echoes length, logs binary/text lines depending on framing
 * - Supports framing: raw | len32 | newline
 * - Sends a Korean text line every 3s to verify downstream receive
 * - Reads .env file for configuration
 */
const fs = require('fs');
const path = require('path');
// lightweight .env loader (current dir)
(function loadDotEnv(file) {
  try {
    const p = path.resolve(__dirname, '.env');
    const txt = fs.readFileSync(p, 'utf8');
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const k = m[1];
      let v = m[2];
      // strip inline comments starting with space+# if present
      const hashAt = v.indexOf(' #');
      if (hashAt !== -1) v = v.slice(0, hashAt);
      v = v.replace(/^['"]|['"]$/g, '').trim();
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
})();

const net = require('net');

// Unified env variables across test harnesses
const PORT = parseInt(process.env.PORT || process.env.STT_TEST_TCP_PORT || process.env.STT_TEST_PORT || '7070', 10);
const FRAMING = (process.env.TCP_FRAMING || 'raw').toLowerCase();
const AUDIO_ENCODING = (process.env.AUDIO_ENCODING || 'PCMU').toUpperCase(); // 'PCMU' | 'L16'
const CHANNELS = Math.max(1, parseInt(process.env.CHANNELS || '1', 10));
const BYTES_PER_SAMPLE = AUDIO_ENCODING === 'L16' ? 2 : 1;
const LOG_SAMPLES = Math.max(0, parseInt(process.env.LOG_SAMPLES || '8', 10));
const LOG_JSON = /^(1|true|yes)$/i.test(process.env.LOG_JSON || '0');
const CAPTURE_DIR = process.env.CAPTURE_DIR || 'captures';
const PCMU_MONO_EXPORT = /^(1|true|yes)$/i.test(process.env.PCMU_MONO_EXPORT || '1'); // 다채널 PCMU 시 _combined_mono.pcmu 추가 생성
const MESSAGE_INTERVAL_MS = parseInt(process.env.MESSAGE_INTERVAL_MS || '3000', 10);
const ECHO_TEXT = process.env.ECHO_TEXT; // fixed outgoing text if set

function log(level, msg, extra) {
  if (LOG_JSON) {
    const line = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
    console.log(JSON.stringify(line));
  } else {
    const kv = Object.entries(extra || {}).map(([k,v])=>`${k}=${v}`).join(' ');
    console.log(`[${level}] ${msg}${kv ? ' ' + kv : ''}`);
  }
}

log('info', 'config', { port: PORT, framing: FRAMING, channels: CHANNELS, audioEncoding: AUDIO_ENCODING, logSamples: LOG_SAMPLES, captureDir: CAPTURE_DIR });

function frame(buf) {
  switch (FRAMING) {
    case 'len32': {
      const h = Buffer.allocUnsafe(4);
      h.writeUInt32BE(buf.length, 0);
      return Buffer.concat([h, buf]);
    }
    case 'newline':
      return Buffer.concat([buf, Buffer.from('\n')]);
    case 'raw':
    default:
      return buf;
  }
}

function makeCaptureDir() {
  const dir = path.resolve(__dirname, CAPTURE_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function makeCaptureWriters(socket, baseExt) {
  const dir = makeCaptureDir();
  const ts = new Date();
  const stamp = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}_${String(ts.getMilliseconds()).padStart(3,'0')}`;
  const ip = `${socket.remoteAddress?.replace(/[:\\]/g,'_') || 'unknown'}-${socket.remotePort || 'p'}`;
  const base = `tcp_${stamp}_${ip}`;
  const ext = baseExt;
  const combinedPath = path.join(dir, `${base}_combined.${ext}`);
  const rxPath = path.join(dir, `${base}_rx.${ext}`);
  const txPath = path.join(dir, `${base}_tx.${ext}`);
  const monoPath = (ext === 'pcmu' && PCMU_MONO_EXPORT && CHANNELS > 1) ? path.join(dir, `${base}_combined_mono.pcmu`) : null;
  const combined = fs.createWriteStream(combinedPath);
  const rx = fs.createWriteStream(rxPath);
  const tx = fs.createWriteStream(txPath);
  const mono = monoPath ? fs.createWriteStream(monoPath) : null;
  return { dir, combinedPath, rxPath, txPath, monoPath, combined, rx, tx, mono };
}

const server = net.createServer((socket) => {
  const ip = `${socket.remoteAddress}:${socket.remotePort}`;
  log('info', 'conn', { ip });

  let bytes = 0;
  let frames = 0;
  let texts = 0;
  // 채널 집계/미리보기
  let rxSamples = 0;
  const rxChBytes = Array.from({ length: CHANNELS }, () => 0);
  const chLabels = CHANNELS === 1 ? ['RX'] : ['RX', 'TX', ...Array.from({ length: Math.max(0, CHANNELS - 2) }, (_, i) => `CH${i + 2}`)];
  const resetPreviews = () => Array.from({ length: CHANNELS }, () => []);
  let previews = resetPreviews();

  // 파일 캡처 준비
  const ext = AUDIO_ENCODING === 'L16' ? 'l16' : 'pcmu';
  const caps = makeCaptureWriters(socket, ext);

  function writeDeinterleaved(buf) {
    // 원본 저장
    try { caps.combined.write(buf); } catch {}
    const stride = CHANNELS * BYTES_PER_SAMPLE;
    const samples = Math.floor(buf.length / stride);
    if (samples <= 0) return;
    for (let i = 0; i < samples; i++) {
      const base = i * stride;
      // CH0 -> RX
      const off0 = base + (0 * BYTES_PER_SAMPLE);
      const ch0 = buf.subarray(off0, off0 + BYTES_PER_SAMPLE);
      try { caps.rx.write(ch0); } catch {}
      // PCMU mono export (채널0만 연속 저장)
      if (caps.mono && BYTES_PER_SAMPLE === 1) {
        try { caps.mono.write(ch0); } catch {}
      }
      // CH1 -> TX (존재 시)
      if (CHANNELS >= 2) {
        const off1 = base + (1 * BYTES_PER_SAMPLE);
        const ch1 = buf.subarray(off1, off1 + BYTES_PER_SAMPLE);
        try { caps.tx.write(ch1); } catch {}
      }
    }
  }

  // send INIT_HEX if provided
  if (process.env.INIT_HEX) {
    try { socket.write(Buffer.from(process.env.INIT_HEX.replace(/[^0-9a-fA-F]/g, ''), 'hex')); } catch {}
  }

  // 3s tick: send a Korean text line
  const speakTimer = setInterval(() => {
    if (socket.destroyed) { clearInterval(speakTimer); return; }
    const msg = `안녕하세요! TCP 테스트 서버에서 보내는 알림입니다. 현재 시간: ${new Date().toLocaleString()}`;
    try {
      const payload = frame(Buffer.from(msg, 'utf8'));
      socket.write(payload);
      log('info', 'send_text', { bytes: payload.length, preview: msg.slice(0,80) });
    } catch {}
  }, Math.max(500, MESSAGE_INTERVAL_MS));
  if (typeof speakTimer.unref === 'function') speakTimer.unref();

  socket.on('data', (buf) => {
    bytes += buf.length;
    frames += 1;
    // 프레이밍에 상관없이 채널 단위로 통계 (raw일 때 정확; len32/newline은 본문에서 호출 위치에서 이미 분리됨)
    const strideBytes = CHANNELS * BYTES_PER_SAMPLE;
    const samples = Math.floor(buf.length / strideBytes);
    rxSamples += samples;
    for (let i = 0; i < samples; i++) {
      for (let ch = 0; ch < CHANNELS; ch++) {
        const off = (i * strideBytes) + (ch * BYTES_PER_SAMPLE);
        rxChBytes[ch] += BYTES_PER_SAMPLE;
        if (LOG_SAMPLES && previews[ch].length < LOG_SAMPLES) {
          if (BYTES_PER_SAMPLE === 1) {
            previews[ch].push(buf[off]);
          } else {
            previews[ch].push(buf.readInt16LE(off));
          }
        }
      }
    }
    writeDeinterleaved(buf);
  });

  socket.on('close', () => {
    log('info', 'close', { ip });
    clearInterval(speakTimer);
    try { caps.combined.end(); } catch {}
    try { caps.rx.end(); } catch {}
    try { caps.tx.end(); } catch {}
  log('info', 'capture_saved', { combined: caps.combinedPath, rx: caps.rxPath, tx: caps.txPath, mono: caps.monoPath || undefined });
    if (process.env.BYE_HEX) {
      try { socket.write(Buffer.from(process.env.BYE_HEX.replace(/[^0-9a-fA-F]/g, ''), 'hex')); } catch {}
    }
  });

  socket.on('error', (err) => {
    log('error', 'socket_error', { ip, err: err?.message || String(err) });
  });

  const statTimer = setInterval(() => {
    if (socket.destroyed) { clearInterval(statTimer); return; }
    const prevParts = previews.map((arr, idx) => {
      const label = chLabels[idx] || `CH${idx}`;
      const shown = arr.length ? arr : [];
      const rendered = shown.map(v => (typeof v === 'number' ? v : String(v))).join(',');
      return `${label}[${rendered}]`;
    });
    const chStats = rxChBytes.map((b, idx) => `${chLabels[idx] || `CH${idx}`}:${b}`).join(' ');
  log('debug', 'stats', { frames, bytes, samples: rxSamples, channels: chStats, previews: prevParts.join(' | ') });
    bytes = 0; frames = 0; rxSamples = 0; previews = resetPreviews();
    for (let i = 0; i < CHANNELS; i++) { rxChBytes[i] = 0; }
  }, 1000);
  if (typeof statTimer.unref === 'function') statTimer.unref();
});

server.listen(PORT, () => {
  log('info', 'listening', { proto: 'tcp', url: `tcp://0.0.0.0:${PORT}`, framing: FRAMING });
});
