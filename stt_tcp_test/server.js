'use strict';
/**
 * Simple STT TCP test server
 * - Accepts connections on tcp://<host>:<PORT>
 * - Echoes length, logs binary/text lines depending on framing
 * - Supports framing: raw | len32 | newline
 * - Sends a Korean text line every 3s to verify downstream receive
 *
 * Env:
 * - PORT or STT_TEST_TCP_PORT (default 7070)
 * - TCP_FRAMING: raw|len32|newline (default: raw)
 * - INIT_HEX: optional hex to send once after connection
 * - BYE_HEX: optional hex to send before closing
 */
const net = require('net');

const PORT = parseInt(process.env.PORT || process.env.STT_TEST_TCP_PORT || '7070', 10);
const FRAMING = (process.env.TCP_FRAMING || 'raw').toLowerCase();

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

const server = net.createServer((socket) => {
  const ip = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[conn] ${ip}`);

  let bytes = 0;
  let frames = 0;

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
      console.log(`[send-text] ${msg}`);
    } catch {}
  }, 3000);
  if (typeof speakTimer.unref === 'function') speakTimer.unref();

  socket.on('data', (buf) => {
    bytes += buf.length;
    frames += 1;
    console.log(`[data] ${buf.length} bytes`);
  });

  socket.on('close', () => {
    console.log(`[close] ${ip}`);
    clearInterval(speakTimer);
    if (process.env.BYE_HEX) {
      try { socket.write(Buffer.from(process.env.BYE_HEX.replace(/[^0-9a-fA-F]/g, ''), 'hex')); } catch {}
    }
  });

  socket.on('error', (err) => {
    console.error(`[error] ${ip} ${err?.message || err}`);
  });

  const statTimer = setInterval(() => {
    if (socket.destroyed) { clearInterval(statTimer); return; }
    console.log(`[stats] frames=${frames} bytes=${bytes}`);
    bytes = 0; frames = 0;
  }, 1000);
  if (typeof statTimer.unref === 'function') statTimer.unref();
});

server.listen(PORT, () => {
  console.log(`STT TCP test server listening on tcp://0.0.0.0:${PORT} framing=${FRAMING}`);
});
