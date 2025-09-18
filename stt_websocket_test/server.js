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
 */
const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || process.env.STT_TEST_PORT || '8080', 10);
const WS_PATH = process.env.WS_PATH || process.env.PATHNAME || '/stt';

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
            const len = Buffer.isBuffer(data) ? data.length : (data?.byteLength || 0);
            bytes += len;
            frames += 1;
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
    });

    ws.on('error', (err) => {
        console.error(`[error] ${err?.message || err}`);
    });

    const timer = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            console.log(`[stats] rxFrames=${frames} rxBytes=${bytes} rxTexts=${texts} txTexts=${sentTexts}`);
            frames = 0;
            bytes = 0;
            texts = 0;
            sentTexts = 0;
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
