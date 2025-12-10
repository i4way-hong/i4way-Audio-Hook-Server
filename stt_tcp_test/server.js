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
const WebSocket = require('ws');
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
const ANNOUNCEMENT_TEMPLATE = (() => {
  if (!Object.prototype.hasOwnProperty.call(process.env, 'ANNOUNCEMENT_TEXT')) {
    return '안녕하세요! TCP 테스트 서버에서 보내는 알림입니다. 현재 시간: {time}';
  }
  const raw = (process.env.ANNOUNCEMENT_TEXT || '').trim();
  if (!raw) {
    return null;
  }
  return raw;
})();
const OUTBOUND_JSON_TEMPLATE = process.env.OUTBOUND_JSON_TEMPLATE || null;
const OUTBOUND_PACKET_INTERVAL = Math.max(1, parseInt(process.env.OUTBOUND_PACKET_INTERVAL || '10', 10));
const FORWARD_WS_URL = process.env.FORWARD_WS_URL || null;
const FORWARD_WS_RETRY_MS = Math.max(1000, parseInt(process.env.FORWARD_WS_RETRY_MS || '5000', 10));
const MAX_FORWARD_QUEUE = Math.max(0, parseInt(process.env.FORWARD_WS_MAX_QUEUE || '200', 10));

const KOREAN_SENTENCES = [
  '실시간 음성 테스트를 진행하고 있습니다.',
  '지금은 예시 데이터를 기반으로 응답합니다.',
  '패킷 수신에 따라 한국어 문장을 전송합니다.',
  '현재 연결 상태가 정상적으로 유지되고 있어요.',
  '서비스 품질 확인을 위해 자동 메시지를 보냅니다.',
  '이 문장은 약 사십 글자로 구성된 안내입니다.'
];

const pickKoreanSentence = () => {
  if (!KOREAN_SENTENCES.length) {
    return '테스트용 한국어 문장을 전송합니다.';
  }
  const idx = Math.floor(Math.random() * KOREAN_SENTENCES.length);
  return KOREAN_SENTENCES[idx];
};

const deepClone = (value) => {
  if (value === null || value === undefined) return {};
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (err) {
    void err;
    return {};
  }
};

const safeJson = (value) => {
  try {
    return JSON.stringify(value);
  } catch (err) {
    void err;
    return String(value);
  }
};

const tryParseJson = (value) => {
  if (typeof value !== 'string') {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    void err;
    return null;
  }
};

const toPlainObject = (value) => {
  if (!value) {
    return {};
  }
  if (value instanceof Map) {
    return Object.fromEntries(value.entries());
  }
  if (typeof value === 'object') {
    return { ...value };
  }
  return {};
};

const parseJsonIfNeeded = (value) => {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return value;
  }
  const parsed = tryParseJson(trimmed);
  return parsed ?? value;
};

const applyConversationLookup = (raw, dest) => {
  if (raw === undefined || raw === null) {
    return;
  }
  const value = parseJsonIfNeeded(raw);
  if (typeof value === 'string' || value === undefined || value === null) {
    return;
  }
  if (Array.isArray(value)) {
    for (const record of value) {
      if (record && typeof record === 'object') {
        extractContextFields(record, dest);
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    extractContextFields(value, dest);
    const nested = value.conversation_lookup ?? value.conversationLookup;
    if (nested !== undefined) {
      applyConversationLookup(nested, dest);
    }
  }
};

const applyConversationMetadata = (raw, dest) => {
  if (raw === undefined || raw === null) {
    return;
  }
  const value = parseJsonIfNeeded(raw);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        updateConversationContext(item, dest);
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    updateConversationContext(value, dest);
  }
};

const CONTEXT_FIELDS = [
  ['conversation_id', 'conversationId'],
  ['direction', 'direction'],
  ['remote_number', 'remoteNumber'],
  ['dnis', 'dnis'],
  ['queue_id', 'queueId'],
  ['queue_name', 'queueName'],
  ['agent_dn', 'agentDn'],
  ['agent_id', 'agentId'],
  ['agent_name', 'agentName'],
  ['user_name', 'userName']
];

const extractContextFields = (source, dest) => {
  if (!source || typeof source !== 'object') {
    return;
  }
  for (const [snake, camel] of CONTEXT_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(dest, snake) && dest[snake] !== undefined && dest[snake] !== null) {
      continue;
    }
    const value = source[snake] ?? source[camel];
    if (value !== undefined && value !== null) {
      dest[snake] = value;
    }
  }
};

const updateConversationContext = (payload, dest) => {
  if (!payload || typeof payload !== 'object') {
    return;
  }
  extractContextFields(payload, dest);
  applyConversationLookup(payload.conversation_lookup ?? payload.conversationLookup, dest);
  applyConversationMetadata(payload.conversation_metadata ?? payload.conversationMetadata, dest);
  if (payload.tags) {
    updateContextFromTags(payload.tags, dest);
  }
  const vendorParams = toPlainObject(payload.vendor_params ?? payload.vendorParams ?? null);
  if (Object.keys(vendorParams).length > 0) {
    updateContextFromVendorParams(vendorParams, dest);
  }
  if (payload.payload && typeof payload.payload === 'object') {
    updateConversationContext(payload.payload, dest);
  }
  if (payload.init && typeof payload.init === 'object') {
    updateConversationContext(payload.init, dest);
    const initVendor = toPlainObject(payload.init.vendor_params ?? payload.init.vendorParams ?? null);
    if (Object.keys(initVendor).length > 0) {
      updateContextFromVendorParams(initVendor, dest);
    }
  }
};

const updateContextFromTags = (tags, dest) => {
  if (!tags || typeof tags !== 'object') {
    return;
  }
  const plain = toPlainObject(tags);
  for (const [snake, camel] of CONTEXT_FIELDS) {
    const raw = plain[snake] ?? plain[camel];
    if (raw === undefined || raw === null) {
      continue;
    }
    const normalized = parseJsonIfNeeded(raw);
    if (Array.isArray(normalized)) {
      applyConversationLookup(normalized, dest);
      continue;
    }
    if (normalized && typeof normalized === 'object') {
      updateConversationContext(normalized, dest);
      continue;
    }
    dest[snake] = normalized;
  }
  applyConversationLookup(plain.conversation_lookup ?? plain.conversationLookup, dest);
  applyConversationMetadata(plain.conversation_metadata ?? plain.conversationMetadata, dest);
};

const updateContextFromVendorParams = (params, dest) => {
  if (!params || typeof params !== 'object') {
    return;
  }
  const plain = toPlainObject(params);
  applyConversationMetadata(plain.conversation_metadata ?? plain.conversationMetadata, dest);
  applyConversationLookup(plain.conversation_lookup ?? plain.conversationLookup, dest);
};

const buildOutboundEnvelope = ({ transport, event, sentAt, sequence, payload, context, meta }) => {
  const envelope = {
    type: event,
    serverEvent: event,
    transport,
    sentAt,
    packetSequence: sequence ?? null,
    payload
  };
  if (meta && typeof meta === 'object') {
    for (const [key, value] of Object.entries(meta)) {
      if (value !== undefined && value !== null) {
        envelope[key] = value;
      }
    }
  }
  if (context && typeof context === 'object' && Object.keys(context).length > 0) {
    const ctx = { ...context };
    envelope.context = ctx;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      for (const [key, value] of Object.entries(ctx)) {
        if (value !== undefined && value !== null && payload[key] === undefined) {
          payload[key] = value;
        }
      }
    }
    for (const [key, value] of Object.entries(ctx)) {
      if (value !== undefined && value !== null && envelope[key] === undefined) {
        envelope[key] = value;
      }
    }
  }
  return envelope;
};

let outboundTemplateObject = null;
if (OUTBOUND_JSON_TEMPLATE) {
  try {
    outboundTemplateObject = JSON.parse(OUTBOUND_JSON_TEMPLATE);
  } catch (err) {
    log('warn', 'invalid_outbound_template', { error: err?.message || String(err) });
  }
}

const cloneOutboundTemplate = () => (outboundTemplateObject ? deepClone(outboundTemplateObject) : null);

class WsForwarder {
  constructor(url, retryMs, maxQueue) {
    this.url = url;
    this.retryMs = retryMs;
    this.maxQueue = maxQueue;
    this.socket = null;
    this.connecting = false;
    this.retryHandle = null;
    this.queue = [];
  }

  queueLength() {
    return this.queue.length;
  }

  ensureConnected() {
    if (!this.url) {
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (this.connecting) {
      return;
    }
    this.connect();
  }

  connect() {
    if (!this.url) {
      return;
    }
    this.connecting = true;
    log('info', 'forward_connecting', { url: this.url });
    const ws = new WebSocket(this.url);
    this.socket = ws;

    ws.on('open', () => {
      this.connecting = false;
      log('info', 'forward_connected', { url: this.url });
      this.flushQueue();
    });

    ws.on('message', (data, isBinary) => {
      const preview = isBinary ? `<binary ${data.length || 0}>` : String(data).slice(0, 80);
      log('debug', 'forward_inbound', { preview });
    });

    ws.on('close', (code, reason) => {
      const r = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
      log('warn', 'forward_closed', { url: this.url, code, reason: r });
      this.socket = null;
      this.connecting = false;
      this.scheduleReconnect();
    });

    ws.on('error', (err) => {
      log('error', 'forward_error', { url: this.url, err: err?.message || String(err) });
      try {
        ws.close();
      } catch (closeErr) {
        void closeErr;
      }
    });
  }

  scheduleReconnect() {
    if (this.retryHandle || !this.url) {
      return;
    }
    this.retryHandle = setTimeout(() => {
      this.retryHandle = null;
      this.ensureConnected();
    }, this.retryMs);
    if (typeof this.retryHandle.unref === 'function') {
      this.retryHandle.unref();
    }
  }

  flushQueue() {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.queue.length) {
      const payload = this.queue.shift();
      try {
        this.socket.send(payload);
      } catch (err) {
        log('warn', 'forward_flush_failed', { err: err?.message || String(err) });
        this.queue.unshift(payload);
        try {
          this.socket.close();
        } catch (closeErr) {
          void closeErr;
        }
        return;
      }
    }
  }

  send(payload) {
    if (!this.url) {
      return false;
    }
    this.ensureConnected();
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      try {
        this.socket.send(payload);
        return true;
      } catch (err) {
        log('warn', 'forward_send_failed', { err: err?.message || String(err) });
        try {
          this.socket.close();
        } catch (closeErr) {
          void closeErr;
        }
      }
    }
    if (this.maxQueue === 0) {
      return false;
    }
    if (this.queue.length >= this.maxQueue) {
      this.queue.shift();
    }
    this.queue.push(payload);
    return false;
  }
}

const forwarder = FORWARD_WS_URL ? new WsForwarder(FORWARD_WS_URL, FORWARD_WS_RETRY_MS, MAX_FORWARD_QUEUE) : null;

function log(level, msg, extra) {
  if (LOG_JSON) {
    const line = { ts: new Date().toISOString(), level, msg, ...(extra || {}) };
    console.log(JSON.stringify(line));
  } else {
    const kv = Object.entries(extra || {}).map(([k,v])=>`${k}=${v}`).join(' ');
    console.log(`[${level}] ${msg}${kv ? ' ' + kv : ''}`);
  }
}

log('info', 'config', {
  port: PORT,
  framing: FRAMING,
  channels: CHANNELS,
  audioEncoding: AUDIO_ENCODING,
  logSamples: LOG_SAMPLES,
  captureDir: CAPTURE_DIR,
  packetInterval: OUTBOUND_PACKET_INTERVAL,
  forwardUrl: FORWARD_WS_URL,
  forwardRetryMs: FORWARD_WS_RETRY_MS,
  forwardQueueMax: MAX_FORWARD_QUEUE,
  outboundTemplate: !!outboundTemplateObject
});

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
  if (forwarder) {
    forwarder.ensureConnected();
  }
  const serverSessionId = `ttcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const connectedAtTs = Date.now();
  const connectedAt = new Date(connectedAtTs).toISOString();

  let metadataLogged = false;
  let jsonScanBuffer = '';
  const conversationContext = {};
  let contextLogged = false;

  const maybeLogContext = (reason) => {
    if (contextLogged) {
      return;
    }
    const keys = Object.keys(conversationContext);
    if (keys.length === 0) {
      return;
    }
    contextLogged = true;
    log('debug', 'conversation_context', { reason, context: safeJson(conversationContext) });
  };

  const scanForConversationMetadata = (chunk) => {
    jsonScanBuffer += chunk.toString('utf8');
    if (jsonScanBuffer.length > 32768) {
      jsonScanBuffer = jsonScanBuffer.slice(-16384);
    }
    while (true) {
      const start = jsonScanBuffer.indexOf('{');
      if (start === -1) {
        if (jsonScanBuffer.length > 4096) {
          jsonScanBuffer = jsonScanBuffer.slice(-2048);
        }
        return;
      }
      let depth = 0;
      let end = -1;
      let inString = false;
      for (let i = start; i < jsonScanBuffer.length; i++) {
        const ch = jsonScanBuffer[i];
        if (ch === '"') {
          let backslashes = 0;
          for (let k = i - 1; k >= start && jsonScanBuffer[k] === '\\'; k -= 1) {
            backslashes += 1;
          }
          if ((backslashes % 2) === 0) {
            inString = !inString;
          }
        }
        if (inString) {
          continue;
        }
        if (ch === '{') {
          depth += 1;
        } else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      if (end === -1) {
        jsonScanBuffer = jsonScanBuffer.slice(start);
        return;
      }
      const candidate = jsonScanBuffer.slice(start, end + 1);
      jsonScanBuffer = jsonScanBuffer.slice(end + 1);
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          updateConversationContext(parsed, conversationContext);
          maybeLogContext(parsed.type || 'json_scan');
          if (parsed.type === 'conversationMetadata' && !metadataLogged) {
            log('info', 'conversation_metadata', { payload: safeJson(parsed) });
            metadataLogged = true;
            jsonScanBuffer = '';
            return;
          }
          if (parsed.type === 'init' && !metadataLogged) {
            log('info', 'init_payload', { payload: safeJson(parsed) });
          }
        }
      } catch {}
    }
  };

  let bytes = 0;
  let frames = 0;
  let texts = 0;
  let packetSequence = 0;
  let aggregatePackets = 0;
  let aggregateBytes = 0;
  let aggregateSamples = 0;
  let lastPacketInfo = null;
  let forwardedMessages = 0;

  const buildBasePayload = () => {
    const template = cloneOutboundTemplate();
    if (template) {
      return template;
    }
    if (ECHO_TEXT) {
      return { message: ECHO_TEXT };
    }
    return {};
  };

  const deliverPayload = (payloadStr, reason) => {
    if (!forwarder) {
      return { forwardStatus: 'skipped', forwardQueue: null };
    }
    const delivered = forwarder.send(payloadStr);
    const queueLen = forwarder.queueLength();
    log(delivered ? 'info' : 'debug', delivered ? 'forward_send' : 'forward_queue', { reason, queue: queueLen });
    return { forwardStatus: delivered ? 'sent' : 'queued', forwardQueue: queueLen };
  };

  const resetAggregates = () => {
    aggregatePackets = 0;
    aggregateBytes = 0;
    aggregateSamples = 0;
    lastPacketInfo = null;
  };

  const sendAugmentedMessage = (reason, extra) => {
    let payload = buildBasePayload();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      payload = {};
    }
    payload.koreanMessage = pickKoreanSentence();
    if (extra && typeof extra === 'object') {
      Object.assign(payload, extra);
    }
    const sentAt = new Date().toISOString();
    const envelope = buildOutboundEnvelope({
      transport: 'tcp',
      event: reason,
      sentAt,
      sequence: packetSequence,
      payload,
      context: conversationContext,
      meta: {
        serverSessionId,
        remote: ip,
        framing: FRAMING,
        channels: CHANNELS,
        audioEncoding: AUDIO_ENCODING,
        connectedAt,
        forwardedMessages
      }
    });
    const payloadStr = JSON.stringify(envelope);
    log('info', 'outbound_json', { reason, payload: payloadStr });
    const { forwardStatus, forwardQueue } = deliverPayload(payloadStr, reason);
    if (forwardStatus === 'sent') {
      forwardedMessages += 1;
    }
    const previewExtra = {
      reason,
      preview: payloadStr.slice(0, 120),
      forwardStatus,
      forwardQueue,
      forwardedMessages
    };
    const logLevel = forwardStatus === 'sent' ? 'info' : 'debug';
    log(logLevel, 'outbound_summary', previewExtra);
  };

  const recordPacket = (len, samples) => {
    packetSequence += 1;
    aggregatePackets += 1;
    aggregateBytes += len;
    aggregateSamples += samples;
    lastPacketInfo = { sequence: packetSequence, bytes: len, samples };
    if (aggregatePackets >= OUTBOUND_PACKET_INTERVAL) {
      sendAugmentedMessage('packet_interval', {
        intervalPackets: aggregatePackets,
        intervalBytes: aggregateBytes,
        intervalSamples: aggregateSamples,
        lastPacket: lastPacketInfo,
        channels: CHANNELS,
        encoding: AUDIO_ENCODING
      });
      resetAggregates();
    }
  };

  const flushAggregates = (trigger) => {
    if (aggregatePackets > 0) {
      sendAugmentedMessage('packet_interval_flush', {
        intervalPackets: aggregatePackets,
        intervalBytes: aggregateBytes,
        intervalSamples: aggregateSamples,
        lastPacket: lastPacketInfo,
        trigger,
        channels: CHANNELS,
        encoding: AUDIO_ENCODING
      });
      resetAggregates();
    }
  };

  sendAugmentedMessage('init', {
    connectedAt,
    forwardedMessages,
    remote: ip
  });
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

  // send INIT_HEX if provided (support alias STT_TCP_INIT_HEX)
  try {
    const initHexRaw = process.env.INIT_HEX || process.env.STT_TCP_INIT_HEX || '';
    const initHex = initHexRaw.replace(/[^0-9a-fA-F]/g, '');
    if (initHex) {
      socket.write(Buffer.from(initHex, 'hex'));
      log('info', 'send_init_hex', { bytes: Math.ceil(initHex.length / 2), hex: initHex });
    }
  } catch {}

  // 3s tick: send a Korean text line
  const speakTimer = setInterval(() => {
    if (socket.destroyed) { clearInterval(speakTimer); return; }
    const msg = (() => {
      if (!ANNOUNCEMENT_TEMPLATE) {
        return null;
      }
      const nowStr = new Date().toLocaleString();
      const sentence = pickKoreanSentence();
      return ANNOUNCEMENT_TEMPLATE
        .replace(/\{time\}/g, nowStr)
        .replace(/\{sentence\}/g, sentence);
    })();
    if (!msg) {
      return;
    }
    try {
      const payload = frame(Buffer.from(msg, 'utf8'));
      socket.write(payload);
      log('info', 'send_text', { bytes: payload.length, preview: msg.slice(0,80) });
    } catch {}
  }, Math.max(500, MESSAGE_INTERVAL_MS));
  if (typeof speakTimer.unref === 'function') speakTimer.unref();

  socket.on('data', (buf) => {
    scanForConversationMetadata(buf);
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
    recordPacket(buf.length, samples);
  });

  socket.on('end', () => {
    // Send BYE_HEX (or STT_TCP_BYE_HEX) before we close our write side, so the client can actually receive it.
    try {
      const byeHexRaw = process.env.BYE_HEX || process.env.STT_TCP_BYE_HEX || '';
      const byeHex = byeHexRaw.replace(/[^0-9a-fA-F]/g, '');
      if (byeHex && !socket.destroyed) {
        // Send BYE payload and FIN in one go
        socket.end(Buffer.from(byeHex, 'hex'));
        log('info', 'send_bye_hex', { bytes: Math.ceil(byeHex.length / 2), hex: byeHex });
      } else {
        // Gracefully half-close our side
        try { socket.end(); } catch {}
      }
    } catch {}
    flushAggregates('end');
    log('debug', 'end', { ip });
  });

  socket.on('close', () => {
    flushAggregates('close');
    sendAugmentedMessage('connection_closed', {
      reason: 'client_close',
      forwardedMessages,
      lastPacket: lastPacketInfo,
      sessionDurationMs: Date.now() - connectedAtTs
    });
    log('info', 'close', { ip });
    clearInterval(speakTimer);
    try { caps.combined.end(); } catch {}
    try { caps.rx.end(); } catch {}
    try { caps.tx.end(); } catch {}
    log('info', 'capture_saved', { combined: caps.combinedPath, rx: caps.rxPath, tx: caps.txPath, mono: caps.monoPath || undefined });
    // NOTE: BYE_HEX is now sent during 'end' to ensure delivery before the socket fully closes.
  });

  socket.on('error', (err) => {
    flushAggregates('error');
    sendAugmentedMessage('connection_error', {
      reason: 'socket_error',
      error: err?.message || String(err),
      forwardedMessages,
      lastPacket: lastPacketInfo
    });
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
