'use strict';
/**
 * Lightweight gRPC STT test server
 *  - StreamingRecognize: expects first message with init + client_session_id
 *  - Replies with ready(serverSessionId, modelId)  (camelCase due to proto-loader keepCase=false)
 *  - Accepts audio { sequence, data, end_of_stream }
 *    * every N (TRANSCRIPT_INTERVAL) sequences -> partial transcript
 *    * on end_of_stream -> final transcript after FINAL_DELAY_MS
 *  - Accepts control { type } (type==4 FINALIZE -> final + close)
 *  - HealthCheck unary
 *  - UploadContext unary (counts phrases)
 *  - Optional auth via Authorization: Bearer <GRPC_TEST_AUTH_TOKEN>
 *  - Optional TLS / mTLS
 */
const fs = require('fs');
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const WebSocket = require('ws');

// .env loader (current dir)
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

const LOG_JSON = /^(1|true|yes)$/i.test(process.env.LOG_JSON || '1');
const CAPTURE_DIR = process.env.CAPTURE_DIR || 'captures';
function ensureCaptureDir() {
  const dir = path.resolve(__dirname, CAPTURE_DIR);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}
function log(level, msg, extra) {
  if (LOG_JSON) {
    const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra||{}) });
    console.log(line); // eslint-disable-line no-console
  } else {
    const kv = Object.entries(extra||{}).map(([k,v])=>`${k}=${v}`).join(' ');
    console.log(`[${level}] ${msg}${kv? ' '+kv:''}`); // eslint-disable-line no-console
  }
}

const PORT = parseInt(process.env.GRPC_TEST_PORT || '55051', 10);
const AUTH_TOKEN = process.env.GRPC_TEST_AUTH_TOKEN || '';
const INTERVAL = parseInt(process.env.TRANSCRIPT_INTERVAL || '12', 10);
const FINAL_DELAY = parseInt(process.env.FINAL_DELAY_MS || '250', 10);
const ECHO_TEXT = process.env.ECHO_TEXT; // if set, use this exact text for partials
const RANDOM_FINAL_ERROR_RATE = parseFloat(process.env.RANDOM_FINAL_ERROR_RATE || '0'); // 0~1
const LATENCY_LOG = /^(1|true|yes)$/i.test(process.env.LATENCY_LOG || '1');
// Backpressure & fault injection & CPU load
const BP_ENABLED = /^(1|true|yes)$/i.test(process.env.BACKPRESSURE_ENABLED || '0');
const BP_MAX_QUEUE = parseInt(process.env.BACKPRESSURE_MAX_QUEUE || '200', 10); // max pending audio messages
const BP_PROCESS_MS = parseInt(process.env.BACKPRESSURE_PROCESS_MS || '0', 10); // simulate processing time per audio msg
const CPU_SPIN_MS = parseInt(process.env.CPU_SPIN_MS || '0', 10); // spin milliseconds before sending partial/final
const RANDOM_STREAM_ERROR_RATE = parseFloat(process.env.RANDOM_STREAM_ERROR_RATE || '0');
const RANDOM_STREAM_ERROR_CODES = (process.env.RANDOM_STREAM_ERROR_CODES || 'INTERNAL,RESOURCE_EXHAUSTED,ABORTED').split(/[,\s]+/).filter(Boolean);
const RANDOM_FINAL_ERROR_CODES = (process.env.RANDOM_FINAL_ERROR_CODES || 'INTERNAL').split(/[,\s]+/).filter(Boolean);
const GRPC_CHANNELS = Math.max(1, Math.min(2, parseInt(process.env.GRPC_TEST_CHANNELS || '1', 10) || 1)); // 1 or 2 simulated channels
const PCMU_MONO_EXPORT = /^(1|true|yes)$/i.test(process.env.PCMU_MONO_EXPORT || '1'); // 다채널 PCMU 시 채널0 모노 파일 추가
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
        updateContextFromPayload(item, dest);
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    updateContextFromPayload(value, dest);
  }
};

const updateContextFromPayload = (payload, dest) => {
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
    updateContextFromPayload(payload.payload, dest);
  }
  if (payload.init && typeof payload.init === 'object') {
    updateContextFromPayload(payload.init, dest);
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
      updateContextFromPayload(normalized, dest);
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

function resolveProtoPath() {
  // 1) Explicit env override
  if (process.env.GRPC_TEST_PROTO_PATH) {
    return path.resolve(process.cwd(), process.env.GRPC_TEST_PROTO_PATH);
  }
  // 2) Search candidate locations
  const candidates = [
    path.resolve(process.cwd(), 'proto', 'speech_transcription.proto'), // when launched via root (not our current case)
    path.resolve(__dirname, '..', 'proto', 'speech_transcription.proto'),
    path.resolve(__dirname, '..', '..', 'proto', 'speech_transcription.proto'),
    path.resolve(__dirname, '..', '..', '..', 'proto', 'speech_transcription.proto'),
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  // 3) Fallback: relative to original working dir assumption
  return candidates[candidates.length - 1];
}

const protoFile = resolveProtoPath();
if (!fs.existsSync(protoFile)) {
  log('error', 'proto file not found', { protoFile });
  process.exit(1);
}
log('info', 'using proto file', { protoFile });

const packageDef = protoLoader.loadSync(
  protoFile,
  {
    keepCase: false,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  }
);
const proto = grpc.loadPackageDefinition(packageDef);

// helpers
function authOk(md) {
  if (!AUTH_TOKEN) return true;
  const auth = md.get('authorization');
  if (!auth || !auth.length) return false;
  const raw = String(auth[0]);
  if (/^Bearer /i.test(raw)) return raw.slice(7).trim() === AUTH_TOKEN;
  return false;
}

function healthCheck(call, cb) {
  cb(null, { status: 'SERVING', version: 'test', build_commit: 'local' });
}

function uploadContext(call, cb) {
  const phrases = Array.isArray(call.request?.phrases) ? call.request.phrases : [];
  cb(null, { context_id: call.request?.context_id || 'default', accepted_count: phrases.length });
}

function streamingRecognize(call) {
  if (!authOk(call.metadata)) {
    call.write({ error: { code: 'UNAUTHENTICATED', message: 'Invalid token', fatal: true } });
    call.end();
    return;
  }
  let initialized = false;
  const serverSessionId = `tgrpc-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const connectedAt = new Date().toISOString();
  const remote = typeof call.getPeer === 'function' ? call.getPeer() : 'unknown';
  let initAt = 0;
  let finalSentAt = 0;
  let closed = false;
  const audioQueue = [];
  let processing = false;
  let encodingType = 'UNKNOWN'; // LINEAR16 or PCMU 결정용
  let declaredSampleRate = 8000; // init에서 받은 값 (없으면 8000)
  let effectiveSampleRate = 8000; // WAV 헤더에 실제로 쓸 값
  let initSnapshot = null;
  let forwardedMessages = 0;
  let aggregatePackets = 0;
  let aggregateBytes = 0;
  let aggregateSamples = 0;
  let lastPacketInfo = null;
  let lastSequence = -1;
  const conversationContext = {};

  const buildBasePayload = () => {
    if (initSnapshot) {
      return deepClone(initSnapshot);
    }
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
      transport: 'grpc',
      event: reason,
      sentAt,
      sequence: lastSequence >= 0 ? lastSequence : null,
      payload,
      context: conversationContext,
      meta: {
        serverSessionId,
        remote,
        framing: null,
        channels: GRPC_CHANNELS,
        audioEncoding: encodingType,
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

  const recordPacket = (frame, seq) => {
    aggregatePackets += 1;
    const len = frame?.data ? frame.data.length : 0;
    aggregateBytes += len;
    const bytesPerSample = encodingType === 'LINEAR16' ? 2 : 1;
    const channelCount = Math.max(1, GRPC_CHANNELS);
    const samples = len > 0 ? Math.floor(len / (bytesPerSample * channelCount)) : 0;
    aggregateSamples += samples;
    lastSequence = typeof seq === 'number' ? seq : (lastSequence + 1);
    lastPacketInfo = { sequence: lastSequence, bytes: len, samples };
    if (aggregatePackets >= OUTBOUND_PACKET_INTERVAL) {
      sendAugmentedMessage('audio_interval', {
        intervalPackets: aggregatePackets,
        intervalBytes: aggregateBytes,
        intervalSamples: aggregateSamples,
        lastPacket: lastPacketInfo,
        encoding: encodingType,
        channels: channelCount,
        sampleRateHz: effectiveSampleRate
      });
      resetAggregates();
    }
  };

  const flushAggregates = (trigger) => {
    if (aggregatePackets > 0) {
      sendAugmentedMessage('audio_interval_flush', {
        intervalPackets: aggregatePackets,
        intervalBytes: aggregateBytes,
        intervalSamples: aggregateSamples,
        lastPacket: lastPacketInfo,
        trigger,
        encoding: encodingType,
        channels: GRPC_CHANNELS,
        sampleRateHz: effectiveSampleRate
      });
      resetAggregates();
    }
  };

  const state = {
    call,
    lastSeq: -1,
    firstPartialAt: 0,
    FINAL_DELAY,
    sendFinal,
    vars: { INTERVAL, ECHO_TEXT },
    recordPacket,
    flushAggregates
  };
  const handleAudioFrame = createAudioHandler(state);

  // capture file init (per stream)
  const capBaseDir = ensureCaptureDir();
  const tsStr = new Date().toISOString().replace(/[-:T.Z]/g,'').slice(0,14);
  const safePeer = (call.getPeer()||'peer').replace(/[^a-zA-Z0-9_.-]/g,'_');
  const baseName = `grpc_${tsStr}_${safePeer}_${Math.random().toString(36).slice(2,8)}`;
  // 확장자는 init 이후에 알 수 있으므로 일단 raw로 두고, init 처리 시 rename 수행
  let combinedPath = path.join(capBaseDir, `${baseName}_combined.raw`);
  let rxPath = path.join(capBaseDir, `${baseName}_rx.raw`);
  let txPath = GRPC_CHANNELS === 2 ? path.join(capBaseDir, `${baseName}_tx.raw`) : null;
  let monoPath = null; // channels=2 + PCMU 용 모노
  const metaPath = path.join(capBaseDir, `${baseName}_meta.json`);
  const finalMetaPath = path.join(capBaseDir, `${baseName}_final.json`); // optional second-stage timing metrics
  let combinedStream = null; let rxStream = null; let txStream = null;
  try { combinedStream = fs.createWriteStream(combinedPath); } catch {}
  try { rxStream = fs.createWriteStream(rxPath); } catch {}
  if (txPath) { try { txStream = fs.createWriteStream(txPath); } catch {} }
  const WANT_WAV = /^(1|true|yes)$/i.test(process.env.CAPTURE_WAV || '0');
  let wavPath = path.join(capBaseDir, `${baseName}.wav`);
  let wavBytesWritten = 0;
  let wavHeaderWritten = false;
  // 진단용: 수신 바이트 기반 추정
  let firstAudioAt = 0; // epoch ms
  let lastAudioAt = 0;
  let totalAudioBytes = 0; // raw bytes as received (interleaved if combined)
  function updateAudioStats(len){
    const now = Date.now();
    if (!firstAudioAt) firstAudioAt = now;
    lastAudioAt = now;
    totalAudioBytes += (len||0);
  }
  function maybeWriteWavHeader(sampleRate){
    if (!WANT_WAV || wavHeaderWritten === true) return;
    try {
      const fd = fs.openSync(wavPath, 'w');
  // 44 bytes placeholder, 채널=1|2, bitsPerSample=16 (디코딩 결과는 L16)
      const header = Buffer.alloc(44, 0);
      header.write('RIFF', 0);
      header.writeUInt32LE(36, 4); // size placeholder (36 + dataLen)
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16); // PCM fmt chunk size
      header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(GRPC_CHANNELS, 22); // channels
      header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2 * GRPC_CHANNELS, 28); // byteRate
  header.writeUInt16LE(2 * GRPC_CHANNELS, 32); // blockAlign
      header.writeUInt16LE(16, 34); // bitsPerSample
      header.write('data', 36);
      header.writeUInt32LE(0, 40); // data length placeholder
      fs.writeSync(fd, header);
      fs.closeSync(fd);
      wavHeaderWritten = true;
    } catch (e) { log('warn', 'wav_header_fail', { err: e.message }); }
  }
  function appendWavL16(int16Buf){
    if (!WANT_WAV) return;
    try {
      fs.appendFileSync(wavPath, Buffer.from(int16Buf.buffer, int16Buf.byteOffset, int16Buf.byteLength));
      wavBytesWritten += int16Buf.byteLength;
    } catch (e) { /* ignore */ }
  }
  function finalizeWav(){
    if (!WANT_WAV || !wavHeaderWritten) return;
    try {
      const fd = fs.openSync(wavPath, 'r+');
      const riffSize = 36 + wavBytesWritten;
      const chunkSize = wavBytesWritten;
      const tmp = Buffer.alloc(8);
      tmp.writeUInt32LE(riffSize, 0);
      fs.writeSync(fd, tmp, 0, 4, 4);
      tmp.writeUInt32LE(chunkSize, 0);
      fs.writeSync(fd, tmp, 0, 4, 40);
      fs.closeSync(fd);
      log('info', 'wav_saved', { wav: wavPath, bytes: wavBytesWritten });
    } catch (e) { log('warn', 'wav_finalize_fail', { err: e.message }); }
  }
  function decodeIfNeededAndAppend(audio){
    if (!WANT_WAV || !audio || !audio.data) return;
    if (encodingType === 'LINEAR16') {
      const int16 = new Int16Array(audio.data.buffer, audio.data.byteOffset, Math.floor(audio.data.length / 2));
      appendWavL16(int16);
    } else if (encodingType === 'PCMU') {
      try {
        const ulawBuf = audio.data;
        const size = ulawBuf.length;
        if (GRPC_CHANNELS === 1) {
          const out = new Int16Array(size);
          for (let i=0;i<size;i++) {
            const u = ulawBuf[i];
            let x = ~u & 0xFF; let sign = (x & 0x80) ? -1 : 1; let exponent = (x >> 4) & 0x07; let mantissa = x & 0x0F; let sample = ((mantissa << 3)+0x84) << exponent; sample -= 0x84; out[i] = sign * sample;
          }
          appendWavL16(out);
        } else { // stereo interleaved (L,R)
          const frames = Math.floor(size / 2);
          const out = new Int16Array(frames * 2);
          let o = 0;
          for (let i=0;i<frames;i++) {
            const uL = ulawBuf[i*2];
            const uR = ulawBuf[i*2+1];
            let xL = ~uL & 0xFF; let signL = (xL & 0x80) ? -1 : 1; let exponentL = (xL >> 4) & 0x07; let mantissaL = xL & 0x0F; let sampleL = ((mantissaL << 3)+0x84) << exponentL; sampleL -= 0x84; out[o++] = signL * sampleL;
            let xR = ~uR & 0xFF; let signR = (xR & 0x80) ? -1 : 1; let exponentR = (xR >> 4) & 0x07; let mantissaR = xR & 0x0F; let sampleR = ((mantissaR << 3)+0x84) << exponentR; sampleR -= 0x84; out[o++] = signR * sampleR;
          }
          appendWavL16(out);
        }
        if (ext === 'pcmu' && GRPC_CHANNELS === 2 && PCMU_MONO_EXPORT) {
          monoPath = path.join(capBaseDir, `${baseName}_combined_mono.pcmu`);
          try { fs.writeFileSync(monoPath, ''); } catch {}
        }
      } catch (e) { /* ignore */ }
    }
  }
  function writeCapture(buf) {
    try { combinedStream && combinedStream.write(buf); } catch {}
    if (GRPC_CHANNELS === 1) {
      try { rxStream && rxStream.write(buf); } catch {}
    } else if (GRPC_CHANNELS === 2) {
      if (buf && buf.length > 1) {
        if (encodingType === 'LINEAR16') {
          const rxParts = [];
          const txParts = [];
          for (let i=0;i+3<buf.length;i+=4) { // L16: L(low,high) R(low,high)
            rxParts.push(buf[i], buf[i+1]);
            txParts.push(buf[i+2], buf[i+3]);
          }
          try { rxStream && rxStream.write(Buffer.from(rxParts)); } catch {}
          try { txStream && txStream.write(Buffer.from(txParts)); } catch {}
        } else { // PCMU interleaved bytes L,R
          const rxParts = [];
          const txParts = [];
          for (let i=0;i<buf.length;i+=2) {
            rxParts.push(buf[i]);
            if (i+1 < buf.length) txParts.push(buf[i+1]);
          }
          try { rxStream && rxStream.write(Buffer.from(rxParts)); } catch {}
          try { txStream && txStream.write(Buffer.from(txParts)); } catch {}
          if (monoPath) { try { fs.appendFileSync(monoPath, Buffer.from(rxParts)); } catch {} }
        }
      }
    }
  }
  function handleAudio(audio) {
    if (audio && audio.data) writeCapture(audio.data);
    handleAudioFrame(audio);
  }

  function processQueue() {
    if (processing) return;
    processing = true;
    const next = () => {
      if (closed) { processing = false; return; }
      const frame = audioQueue.shift();
      if (!frame) { processing = false; return; }
      try {
        if (BP_PROCESS_MS > 0) {
          setTimeout(() => { handleAudio(frame); next(); }, BP_PROCESS_MS);
        } else {
          handleAudio(frame);
          setImmediate(next);
        }
      } catch (e) {
        log('error', 'audio frame process error', { err: e.message });
        setImmediate(next);
      }
    };
    next();
  }
  log('info', 'StreamingRecognize start', { remote: call.getPeer() });

  function sendFinal(reason) {
    if (closed) return;
    closed = true;
    flushAggregates(reason || 'final');
    // optional random error injection
    if (RANDOM_FINAL_ERROR_RATE > 0 && Math.random() < RANDOM_FINAL_ERROR_RATE) {
      const code = RANDOM_FINAL_ERROR_CODES[Math.floor(Math.random() * RANDOM_FINAL_ERROR_CODES.length)] || 'INTERNAL';
      try { call.write({ error: { code, message: 'Injected final error', fatal: true } }); } catch {}
      try { call.end(); } catch {}
      log('warn', 'Injected final error instead of transcript', { reason });
      return;
    }
    finalSentAt = Date.now();
  const finalText = ECHO_TEXT ? `${ECHO_TEXT} (final)` : `final transcript (${reason})`;
    try {
   call.write({ transcript: { text: finalText, is_final: true, confidence: 0.95, result_index: state.lastSeq + 1 } });
    } catch {}
    try { call.end(); } catch {}
    const lat = initAt ? (finalSentAt - initAt) : undefined;
    log('info', 'StreamingRecognize closed', { reason, latencyTotalMs: lat });
  }

  call.on('data', (msg) => {
    try {
      if (msg.init) {
        if (initialized) {
          call.write({ error: { code: 'ALREADY_INIT', message: 'already initialized', fatal: true } });
          call.end();
          return;
        }
        initialized = true;
        initAt = Date.now();
        encodingType = msg.init.encoding || 'LINEAR16';
        declaredSampleRate = msg.init.sample_rate_hz || 8000;
        log('info', 'init_payload', {
          clientSessionId: msg.client_session_id || null,
          init: safeJson(msg.init)
        });
        if (msg.tags && Object.keys(msg.tags).length > 0) {
          log('info', 'init_tags', { tags: safeJson(msg.tags) });
        }
        const vendorParamsRaw = msg.init.vendor_params ?? msg.init.vendorParams ?? null;
        const vendorParams = toPlainObject(vendorParamsRaw);
        if (Object.keys(vendorParams).length > 0) {
          log('info', 'init_vendor_params', { vendorParams: safeJson(vendorParams) });
        }
        updateContextFromPayload(msg.init, conversationContext);
        updateContextFromTags(msg.tags, conversationContext);
        updateContextFromVendorParams(vendorParams, conversationContext);
        if (Object.keys(conversationContext).length > 0) {
          log('debug', 'init_conversation_context', { conversationContext: safeJson(conversationContext) });
        } else {
          log('debug', 'init_conversation_context_empty', {});
        }
        // μ-law (PCMU)는 일반적으로 8kHz 고정. 잘못된 값이 들어오면 경고 후 8000으로 강제.
        if (encodingType === 'PCMU') {
          if (declaredSampleRate !== 8000) {
            log('warn', 'pcmu_sample_rate_mismatch_force_8000', { declared: declaredSampleRate });
          }
          effectiveSampleRate = 8000;
        } else {
          effectiveSampleRate = declaredSampleRate || 8000;
          if (![8000,16000,48000].includes(effectiveSampleRate)) {
            log('warn', 'unexpected_linear16_sample_rate', { declared: effectiveSampleRate });
          }
        }
        initSnapshot = {
          transport: 'grpc',
          serverSessionId,
          clientSessionId: msg.client_session_id || null,
          init: {
            languageCode: msg.init.language_code,
            sampleRateHz: msg.init.sample_rate_hz,
            encoding: msg.init.encoding,
            singleUtterance: msg.init.single_utterance,
            enableInterimResults: msg.init.enable_interim_results
          },
          audio: {
            channels: GRPC_CHANNELS,
            declaredSampleRateHz: declaredSampleRate,
            effectiveSampleRateHz: effectiveSampleRate
          },
          env: {
            intervalPackets: OUTBOUND_PACKET_INTERVAL,
            finalDelayMs: FINAL_DELAY
          }
        };
        forwardedMessages = 0;
        resetAggregates();
        lastSequence = -1;
        // 확장자 rename
        const ext = encodingType === 'PCMU' ? 'pcmu' : 'l16';
        const newCombined = path.join(capBaseDir, `${baseName}_combined.${ext}`);
        const newRx = path.join(capBaseDir, `${baseName}_rx.${ext}`);
        try { fs.renameSync(combinedPath, newCombined); combinedPath = newCombined; } catch {}
        try { fs.renameSync(rxPath, newRx); rxPath = newRx; } catch {}
        if (txPath) {
          const newTx = path.join(capBaseDir, `${baseName}_tx.${ext}`);
          try { fs.renameSync(txPath, newTx); txPath = newTx; } catch {}
        }
        if (WANT_WAV) { maybeWriteWavHeader(effectiveSampleRate); }
        // write meta file (initial snapshot)
        const meta = {
          type: 'stream_init',
          serverSessionId,
          modelId: 'test-model',
          clientSessionId: msg.client_session_id || null,
          init: {
            languageCode: msg.init.language_code,
            sampleRateHz: msg.init.sample_rate_hz,
            encoding: msg.init.encoding,
            enableInterimResults: msg.init.enable_interim_results,
            singleUtterance: msg.init.single_utterance,
            enableWordTimeOffsets: msg.init.enable_word_time_offsets,
            vendorParams
          },
          audio: {
            channels: GRPC_CHANNELS,
            declaredSampleRateHz: declaredSampleRate,
            effectiveSampleRateHz: effectiveSampleRate,
            note: encodingType === 'PCMU' ? 'PCMU forced to 8000Hz for WAV' : undefined
          },
          env: {
            INTERVAL,
            FINAL_DELAY,
            ECHO_TEXT: !!ECHO_TEXT,
            BP_ENABLED,
            BP_MAX_QUEUE,
            BP_PROCESS_MS,
            CPU_SPIN_MS,
            RANDOM_STREAM_ERROR_RATE,
            RANDOM_FINAL_ERROR_RATE
          },
          timestamps: { initAt: new Date(initAt).toISOString() }
        };
        try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); log('info', 'meta_saved', { meta: metaPath }); } catch (e) { log('warn', 'meta_write_fail', { err: e.message }); }
        call.write({ ready: { serverSessionId: serverSessionId, modelId: 'test-model' } });
        sendAugmentedMessage('init', {
          ack: true,
          encoding: encodingType,
          channels: GRPC_CHANNELS,
          sampleRateHz: effectiveSampleRate,
          clientSessionId: msg.client_session_id || null
        });
        return;
      }
      if (!initialized) {
        call.write({ error: { code: 'NOT_INITIALIZED', message: 'send init first', fatal: true } });
        call.end();
        return;
      }
      if (msg.audio) {
        if (msg.audio.data) updateAudioStats(msg.audio.data.length);
        if (BP_ENABLED) {
          if (audioQueue.length >= BP_MAX_QUEUE) {
            // simulate backpressure error
            log('warn', 'audio queue overflow', { size: audioQueue.length });
            call.write({ error: { code: 'RESOURCE_EXHAUSTED', message: 'audio queue overflow', fatal: false } });
          } else {
            audioQueue.push(msg.audio);
            if (!processing) processQueue();
          }
        } else {
          // handled by new backpressure / handler pipeline
          handleAudio(msg.audio);
        }
        decodeIfNeededAndAppend(msg.audio);
        return;
      }
      if (msg.control) {
        // type 4 == FINALIZE
        if (msg.control.type === 4) {
          flushAggregates('control_finalize');
          setTimeout(() => sendFinal('control_finalize'), FINAL_DELAY);
        } else {
          call.write({ control_ack: { type: msg.control.type, accepted: true, message: 'OK' } });
        }
        return;
      }
    } catch (e) {
      log('error', 'stream data exception', { err: e.message });
      flushAggregates('stream_exception');
      call.write({ error: { code: 'INTERNAL', message: 'exception', fatal: true } });
      call.end();
    }
  });

  call.on('error', (err) => {
    flushAggregates('stream_error');
    log('warn', 'client stream error', { err: err?.message });
  });
  call.on('end', () => {
    flushAggregates('stream_end');
    closed = true;
    if (LATENCY_LOG && initAt) {
      const now = Date.now();
  const firstPartialLatency = state.firstPartialAt ? (state.firstPartialAt - initAt) : null;
      const endLatency = now - initAt;
      // 추정 샘플레이트 계산: LINEAR16 인 경우 (bytes / 2 / channels) / seconds
      let derivedSampleRate = null;
      if (firstAudioAt && lastAudioAt && lastAudioAt > firstAudioAt && totalAudioBytes > 0) {
        const durSec = (lastAudioAt - firstAudioAt) / 1000;
        if (durSec > 0) {
          if (encodingType === 'LINEAR16') {
            const samples = totalAudioBytes / 2 / GRPC_CHANNELS; // 2 bytes per sample per channel
            derivedSampleRate = Math.round(samples / durSec);
          } else if (encodingType === 'PCMU') {
            // μ-law 1 byte per sample per channel
            const samples = totalAudioBytes / GRPC_CHANNELS;
            derivedSampleRate = Math.round(samples / durSec);
          }
        }
      }
      if (derivedSampleRate && Math.abs(derivedSampleRate - effectiveSampleRate) / effectiveSampleRate > 0.15) {
        log('warn', 'sample_rate_mismatch_detected', { declared: declaredSampleRate, effective: effectiveSampleRate, derived: derivedSampleRate });
      }
      log('debug', 'client end timing', { firstPartialLatencyMs: firstPartialLatency, sessionDurationMs: endLatency });
      // write final meta timing file (non-destructive separate file)
      try {
        const finalMeta = {
          type: 'stream_final',
          serverSessionId,
          metrics: {
            firstPartialLatencyMs: firstPartialLatency,
            totalSessionDurationMs: endLatency
          },
          audio: {
            channels: GRPC_CHANNELS,
            declaredSampleRateHz: declaredSampleRate,
            effectiveSampleRateHz: effectiveSampleRate
          },
          stats: {
            totalAudioBytes,
            firstAudioAt: firstAudioAt ? new Date(firstAudioAt).toISOString() : null,
            lastAudioAt: lastAudioAt ? new Date(lastAudioAt).toISOString() : null,
            derivedSampleRateHz: derivedSampleRate
          },
          timestamps: {
            initAt: new Date(initAt).toISOString(),
            endAt: new Date(now).toISOString()
          }
        };
        fs.writeFileSync(finalMetaPath, JSON.stringify(finalMeta, null, 2));
        log('info', 'meta_saved', { meta: finalMetaPath });
      } catch (e) {
        log('warn', 'final_meta_write_fail', { err: e.message });
      }
    } else {
      log('info', 'client stream ended', {});
    }
  try { combinedStream && combinedStream.end(); } catch {}
  try { rxStream && rxStream.end(); } catch {}
  try { txStream && txStream.end(); } catch {}
  log('info', 'capture_saved', { combined: combinedPath, rx: rxPath, tx: txPath || undefined, channels: GRPC_CHANNELS });
  log('info', 'capture_saved', { combined: combinedPath, rx: rxPath, tx: txPath || undefined, mono: monoPath || undefined, channels: GRPC_CHANNELS });
    finalizeWav();
    try { call.end(); } catch {}
  });
}

function spin(ms) {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy wait */ }
}

function maybeStreamError(call) {
  if (RANDOM_STREAM_ERROR_RATE > 0 && Math.random() < RANDOM_STREAM_ERROR_RATE) {
    const code = RANDOM_STREAM_ERROR_CODES[Math.floor(Math.random() * RANDOM_STREAM_ERROR_CODES.length)] || 'INTERNAL';
    try { call.write({ error: { code, message: 'Injected stream error', fatal: false } }); } catch {}
  }
}

function createAudioHandler(state) {
  return function handleAudioFrame(frame) {
    const { call, vars } = state;
    const { INTERVAL, ECHO_TEXT } = vars;
    const seq = typeof frame.sequence === 'number' ? frame.sequence : (state.lastSeq + 1);
    state.lastSeq = seq;
    if (typeof state.recordPacket === 'function') {
      try {
        state.recordPacket(frame, seq);
      } catch (err) {
        log('warn', 'record_packet_failed', { err: err?.message || String(err) });
      }
    }
    if (seq % INTERVAL === 0) {
      spin(CPU_SPIN_MS);
      const partialText = ECHO_TEXT ? ECHO_TEXT : `partial seq=${seq}`;
      try { call.write({ transcript: { text: partialText, is_final: false, confidence: 0.0, result_index: seq } }); } catch {}
      if (!state.firstPartialAt) state.firstPartialAt = Date.now();
      maybeStreamError(call);
    }
    if (frame.end_of_stream) {
      if (typeof state.flushAggregates === 'function') {
        state.flushAggregates('end_of_stream');
      }
      setTimeout(() => state.sendFinal('end_of_stream'), state.FINAL_DELAY);
    }
  };
}


function buildCredentials() {
  const cert = process.env.GRPC_TEST_TLS_CERT;
  const key = process.env.GRPC_TEST_TLS_KEY;
  const ca = process.env.GRPC_TEST_TLS_CA;
  if (cert && key) {
    const keyCertPairs = [{ private_key: fs.readFileSync(key), cert_chain: fs.readFileSync(cert) }];
    if (ca) {
      log('info', 'TLS (mTLS) enabled', {});
      return grpc.ServerCredentials.createSsl(fs.readFileSync(ca), keyCertPairs, true);
    }
    log('info', 'TLS enabled', {});
    return grpc.ServerCredentials.createSsl(null, keyCertPairs, false);
  }
  log('warn', 'running without TLS', {});
  return grpc.ServerCredentials.createInsecure();
}

function main() {
  const server = new grpc.Server();
  const svc = proto.audiohook.stt.v1.SpeechTranscription.service;
  server.addService(svc, {
    StreamingRecognize: streamingRecognize,
    HealthCheck: healthCheck,
    UploadContext: uploadContext,
  });

  const creds = buildCredentials();
  server.bindAsync(`0.0.0.0:${PORT}`, creds, (err, actualPort) => {
    if (err) {
      log('error', 'bind failed', { err: err.message });
      process.exit(1);
    }
    server.start();
    log('info', 'gRPC test server started', {
      port: actualPort,
      interval: INTERVAL,
      finalDelayMs: FINAL_DELAY,
      captureDir: CAPTURE_DIR,
      packetInterval: OUTBOUND_PACKET_INTERVAL,
      forwardUrl: FORWARD_WS_URL,
      forwardQueueMax: MAX_FORWARD_QUEUE
    });
  });

  function shutdown(sig) {
    log('warn', 'shutdown signal', { sig });
    server.tryShutdown(() => {
      log('info', 'shutdown complete', {});
      process.exit(0);
    });
  }
  ['SIGINT','SIGTERM'].forEach(s => process.on(s, () => shutdown(s)));
}

main();
