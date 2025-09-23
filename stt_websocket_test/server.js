'use strict';
/**
 * Simple STT WebSocket test server
 * - Accepts connections on ws://<host>:<PORT><WS_PATH>
 * - Logs received text/binary messages
 * - If text JSON {"type":"init"} -> replies {"type":"ack", ok:true}
 * - If text JSON {"type":"bye"}  -> replies {"type":"ack", bye:true}
 * - Prints 1s stats of frames/bytes/texts per connection
 *
 * Env vars:
 * - PORT or STT_TEST_PORT (default: 8080)
 * - WS_PATH or PATHNAME (default: /stt)
 * - AUDIO_ENCODING (default: PCMU)
 * - CHANNELS (default: 1)
 * - LOG_SAMPLES (default: 8)
 */
const http = require('http');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

// .env 로더: 현재 디렉터리의 .env를 읽어 process.env에 주입
(function loadDotEnv() {
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
      const hashAt = v.indexOf(' #');
      if (hashAt !== -1) v = v.slice(0, hashAt);
      v = v.replace(/^['"]|['"]$/g, '').trim();
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {}
})();

const PORT = parseInt(process.env.PORT || process.env.STT_TEST_PORT || '8080', 10);
const WS_PATH = process.env.WS_PATH || process.env.PATHNAME || '/stt';
// 추가: 바이너리 오디오 해석 설정
const AUDIO_ENCODING = (process.env.AUDIO_ENCODING || 'PCMU').toUpperCase(); // 'PCMU' | 'L16'
const CHANNELS = Math.max(1, parseInt(process.env.CHANNELS || '1', 10));
const BYTES_PER_SAMPLE = AUDIO_ENCODING === 'L16' ? 2 : 1;
const LOG_SAMPLES = Math.max(0, parseInt(process.env.LOG_SAMPLES || '8', 10));

console.log(`[config] PORT=${PORT} WS_PATH=${WS_PATH} CHANNELS=${CHANNELS} AUDIO_ENCODING=${AUDIO_ENCODING} LOG_SAMPLES=${LOG_SAMPLES}`);

function makeCaptureDir() {
    const dir = path.resolve(__dirname, 'captures');
    try { fs.mkdirSync(dir, { recursive: true }); } catch {}
    return dir;
}

function makeCaptureWriters(req, baseExt) {
    const dir = makeCaptureDir();
    const ts = new Date();
    const stamp = `${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}_${String(ts.getMilliseconds()).padStart(3,'0')}`;
    const ip = `${req.socket.remoteAddress?.replace(/[:\\]/g,'_') || 'unknown'}-${req.socket.remotePort || 'p'}`;
    const base = `ws_${stamp}_${ip}`;
    const ext = baseExt;
    const combinedPath = path.join(dir, `${base}_combined.${ext}`);
    const rxPath = path.join(dir, `${base}_rx.${ext}`);
    const txPath = path.join(dir, `${base}_tx.${ext}`);
    const combined = fs.createWriteStream(combinedPath);
    const rx = fs.createWriteStream(rxPath);
    const tx = fs.createWriteStream(txPath);
    return { dir, combinedPath, rxPath, txPath, combined, rx, tx };
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('AudioHook STT test server');
});

const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on('connection', (ws, req) => {
    const ip = req.socket.remoteAddress;
    const auth = req.headers['authorization'] || '';
    console.log(`[conn] ${ip} ${req.url} auth=${auth ? 'present' : 'none'}`);

    let bytes = 0;
    let frames = 0;
    let texts = 0;
    let sentTexts = 0;

    // 추가: 채널별(rx/tx) 집계 & 미리보기 버퍼
    let rxSamples = 0;
    const rxChBytes = Array.from({ length: CHANNELS }, () => 0);
    const chLabels = CHANNELS === 1 ? ['RX'] : ['RX', 'TX', ...Array.from({ length: Math.max(0, CHANNELS - 2) }, (_, i) => `CH${i + 2}`)];
    const resetPreviews = () => Array.from({ length: CHANNELS }, () => []);
    let previews = resetPreviews();

    // 캡처 준비
    const ext = AUDIO_ENCODING === 'L16' ? 'l16' : 'pcmu';
    const caps = makeCaptureWriters(req, ext);

    const writeDeinterleaved = (buf) => {
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
            // CH1 -> TX (존재 시)
            if (CHANNELS >= 2) {
                const off1 = base + (1 * BYTES_PER_SAMPLE);
                const ch1 = buf.subarray(off1, off1 + BYTES_PER_SAMPLE);
                try { caps.tx.write(ch1); } catch {}
            }
        }
    };

    // 연결 직후 안내 메시지 전송
    try {
        const welcome = `연결을 환영합니다. 현재 시간: ${new Date().toLocaleString()}`;
        ws.send(welcome);
        sentTexts += 1;
        console.log(`[send-text] ${welcome}`);
    } catch {
        // ignore
    }

    // 3초마다 클라이언트로 한글 텍스트 전송
    const speakTimer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            const msg = `안녕하세요! 테스트 서버에서 보내는 알림입니다. 현재 시간: ${new Date().toLocaleString()}`;
            try {
                ws.send(msg);
                sentTexts += 1;
                console.log(`[send-text] ${msg}`);
            } catch {
                // ignore
            }
        } else {
            clearInterval(speakTimer);
        }
    }, 3000);
    if (typeof speakTimer.unref === 'function') {
        speakTimer.unref();
    }

    ws.on('message', (data, isBinary) => {
        if (isBinary) {
            const buf = Buffer.isBuffer(data) ? data : (Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
            const len = buf.length;
            bytes += len;
            frames += 1;
            // 채널 분리 집계
            const strideBytes = CHANNELS * BYTES_PER_SAMPLE;
            const samples = Math.floor(len / strideBytes);
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
            return;
        }
        texts += 1;
        const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
        console.log(`[text] ${s}`);
        try {
            const obj = JSON.parse(s);
            if (obj && obj.type === 'init') {
                ws.send(JSON.stringify({ type: 'ack', ok: true }));
            } else if (obj && obj.type === 'bye') {
                ws.send(JSON.stringify({ type: 'ack', bye: true }));
            }
        } catch {
            // ignore non-JSON text
        }
    });

    ws.on('close', (code, reason) => {
        const r = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
        console.log(`[close] code=${code} reason=${r}`);
        clearInterval(speakTimer);
        try { caps.combined.end(); } catch {}
        try { caps.rx.end(); } catch {}
        try { caps.tx.end(); } catch {}
        console.log(`[capture] saved: combined=${caps.combinedPath} rx=${caps.rxPath} tx=${caps.txPath}`);
    });

    ws.on('error', (err) => {
        console.error(`[error] ${err?.message || err}`);
    });

    const timer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            // 채널 미리보기 문자열 구성
            const prevParts = previews.map((arr, idx) => {
                const label = chLabels[idx] || `CH${idx}`;
                const shown = arr.length ? arr : [];
                const rendered = shown.map(v => (typeof v === 'number' ? v : String(v))).join(',');
                return `${label}[${rendered}]`;
            });
            const chStats = rxChBytes.map((b, idx) => `${chLabels[idx] || `CH${idx}`}:${b}`).join(' ');
            console.log(`[stats] rxFrames=${frames} rxBytes=${bytes} rxSamples=${rxSamples} rxTexts=${texts} ${chStats} txTexts=${sentTexts} previews=${prevParts.join(' | ')}`);
            // reset window
            frames = 0;
            bytes = 0;
            texts = 0;
            sentTexts = 0;
            rxSamples = 0;
            for (let i = 0; i < CHANNELS; i++) {
                rxChBytes[i] = 0;
            }
            previews = resetPreviews();
        } else {
            clearInterval(timer);
        }
    }, 1000);
    if (typeof timer.unref === 'function') {
        timer.unref();
    }
});

server.listen(PORT, () => {
    console.log(`STT test WS server listening on ws://0.0.0.0:${PORT}${WS_PATH}`);
    console.log(`Health check:           http://0.0.0.0:${PORT}/health`);
});
