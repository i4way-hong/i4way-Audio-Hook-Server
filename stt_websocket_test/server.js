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
const { WebSocketServer, WebSocket } = require('ws');
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
            v = v.replace(/^["']|["']$/g, '').trim();
            if (process.env[k] === undefined) process.env[k] = v;
        }
    } catch (err) {
        void err;
    }
})();

const PORT = parseInt(process.env.PORT || process.env.STT_TEST_PORT || '8080', 10);
const WS_PATH = process.env.WS_PATH || process.env.PATHNAME || '/stt';
const AUDIO_ENCODING = (process.env.AUDIO_ENCODING || 'PCMU').toUpperCase(); // 'PCMU' | 'L16'
const CHANNELS = Math.max(1, parseInt(process.env.CHANNELS || '1', 10));
const BYTES_PER_SAMPLE = AUDIO_ENCODING === 'L16' ? 2 : 1;
const LOG_SAMPLES = Math.max(0, parseInt(process.env.LOG_SAMPLES || '8', 10));
const LOG_JSON = /^(1|true|yes)$/i.test(process.env.LOG_JSON || '0');
const CAPTURE_DIR = process.env.CAPTURE_DIR || 'captures';
const ECHO_TEXT = process.env.ECHO_TEXT;
const OUTBOUND_JSON_TEMPLATE = process.env.OUTBOUND_JSON_TEMPLATE || process.env.STT_WS_INIT_JSON || null;
const OUTBOUND_PACKET_INTERVAL = Math.max(1, parseInt(process.env.OUTBOUND_PACKET_INTERVAL || '10', 10));
const FORWARD_WS_URL = process.env.FORWARD_WS_URL || null;
const FORWARD_WS_RETRY_MS = Math.max(1000, parseInt(process.env.FORWARD_WS_RETRY_MS || '5000', 10));
const MAX_FORWARD_QUEUE = Math.max(0, parseInt(process.env.FORWARD_WS_MAX_QUEUE || '200', 10));

function log(level, msg, extra) {
    if (LOG_JSON) {
        console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(extra||{}) }));
    } else {
        const kv = Object.entries(extra||{}).map(([k,v])=>`${k}=${v}`).join(' ');
        console.log(`[${level}] ${msg}${kv? ' '+kv:''}`);
    }
}

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
                updateContextFromPayload(item, dest);
            }
        }
        return;
    }
    if (value && typeof value === 'object') {
        updateContextFromPayload(value, dest);
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

log('info', 'config', { port: PORT, path: WS_PATH, channels: CHANNELS, audioEncoding: AUDIO_ENCODING, logSamples: LOG_SAMPLES, captureDir: CAPTURE_DIR, outboundTemplate: !!outboundTemplateObject, forwardUrl: FORWARD_WS_URL, packetInterval: OUTBOUND_PACKET_INTERVAL });

function makeCaptureDir() {
    const dir = path.resolve(__dirname, CAPTURE_DIR);
    try { fs.mkdirSync(dir, { recursive: true }); } catch (err) {
        void err;
    }
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
    log('info', 'conn', { ip, url: req.url, auth: !!auth });
    const serverSessionId = `tws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const connectedAt = new Date().toISOString();

    let bytes = 0;
    let frames = 0;
    let texts = 0;
    let forwardedMessages = 0;
    let packetSequence = 0;
    let initPayload = null;
    let aggregatePackets = 0;
    let aggregateBytes = 0;
    let aggregateSamples = 0;
    let lastPacketInfo = null;
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
        try { caps.combined.write(buf); } catch (err) {
            void err;
        }
        const stride = CHANNELS * BYTES_PER_SAMPLE;
        const samples = Math.floor(buf.length / stride);
        if (samples <= 0) return;
        for (let i = 0; i < samples; i++) {
            const base = i * stride;
            // CH0 -> RX
            const off0 = base + (0 * BYTES_PER_SAMPLE);
            const ch0 = buf.subarray(off0, off0 + BYTES_PER_SAMPLE);
            try { caps.rx.write(ch0); } catch (err) {
                void err;
            }
            // CH1 -> TX (존재 시)
            if (CHANNELS >= 2) {
                const off1 = base + (1 * BYTES_PER_SAMPLE);
                const ch1 = buf.subarray(off1, off1 + BYTES_PER_SAMPLE);
                try { caps.tx.write(ch1); } catch (err) {
                    void err;
                }
            }
        }
    };

    const buildBasePayload = () => {
        if (initPayload) {
            return deepClone(initPayload);
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
        const localStatus = 'skipped';
        let forwardStatus = null;
        let forwardQueue = null;
        if (forwarder) {
            const delivered = forwarder.send(payloadStr);
            forwardQueue = forwarder.queueLength();
            forwardStatus = delivered ? 'sent' : 'queued';
            log(delivered ? 'info' : 'debug', delivered ? 'forward_send' : 'forward_queue', { reason, queue: forwardQueue });
        }

        return { localStatus, forwardStatus, forwardQueue };
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
            transport: 'websocket',
            event: reason,
            sentAt,
            sequence: packetSequence,
            payload,
            context: conversationContext,
            meta: {
                serverSessionId,
                remote: ip,
                framing: null,
                channels: CHANNELS,
                audioEncoding: AUDIO_ENCODING,
                connectedAt,
                forwardedMessages
            }
        });
        const payloadStr = JSON.stringify(envelope);
            log('info', 'outbound_json', { reason, payload: payloadStr });
        const { localStatus, forwardStatus, forwardQueue } = deliverPayload(payloadStr, reason);
        if (forwardStatus === 'sent') {
            forwardedMessages += 1;
        }
        const previewExtra = { reason, preview: payloadStr.slice(0, 120), localStatus };
        if (forwarder) {
            previewExtra.forwardStatus = forwardStatus;
            previewExtra.forwardQueue = forwardQueue;
        }
        const logLevel = (forwardStatus === 'sent' || localStatus === 'sent') ? 'info' : 'debug';
        log(logLevel, 'outbound_summary', previewExtra);
    };

    const flushAggregates = (trigger) => {
        if (aggregatePackets > 0) {
            const extra = {
                intervalPackets: aggregatePackets,
                intervalBytes: aggregateBytes,
                intervalSamples: aggregateSamples,
                lastPacket: lastPacketInfo,
                flush: true,
                trigger
            };
            sendAugmentedMessage('packet_interval_flush', extra);
            aggregatePackets = 0;
            aggregateBytes = 0;
            aggregateSamples = 0;
            lastPacketInfo = null;
        }
    };

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

            packetSequence += 1;
            aggregatePackets += 1;
            aggregateBytes += len;
            aggregateSamples += samples;
            lastPacketInfo = { sequence: packetSequence, bytes: len, samples };

            if (aggregatePackets >= OUTBOUND_PACKET_INTERVAL) {
                const extra = {
                    intervalPackets: aggregatePackets,
                    intervalBytes: aggregateBytes,
                    intervalSamples: aggregateSamples,
                    lastPacket: lastPacketInfo,
                    receivedFrames: frames
                };
                sendAugmentedMessage('packet_interval', extra);
                aggregatePackets = 0;
                aggregateBytes = 0;
                aggregateSamples = 0;
                lastPacketInfo = null;
            }
            return;
        }
        texts += 1;
        const s = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    log('debug', 'text_recv', { len: s.length, preview: s.slice(0,80) });
        try {
            const obj = JSON.parse(s);
            if (obj && typeof obj === 'object') {
                if (obj.type === 'conversationMetadata') {
                    log('info', 'conversation_metadata', { payload: safeJson(obj) });
                    updateContextFromPayload(obj, conversationContext);
                    maybeLogContext('conversation_metadata');
                } else if (obj.type === 'init') {
                    log('info', 'init_payload', { payload: safeJson(obj) });
                    updateContextFromPayload(obj, conversationContext);
                    maybeLogContext('init_payload');
                }
            }
            if (obj && obj.type === 'init') {
                initPayload = deepClone(obj);
                packetSequence = 0;
                aggregatePackets = 0;
                aggregateBytes = 0;
                aggregateSamples = 0;
                lastPacketInfo = null;
                ws.send(JSON.stringify({ type: 'ack', ok: true }));
                sendAugmentedMessage('init', { ack: true });
            } else if (obj && obj.type === 'bye') {
                ws.send(JSON.stringify({ type: 'ack', bye: true }));
                flushAggregates('bye');
            }
        } catch (err) {
            void err;
        }
    });

    ws.on('close', (code, reason) => {
        flushAggregates('close');
        const r = Buffer.isBuffer(reason) ? reason.toString('utf8') : String(reason || '');
    log('info', 'close', { code, reason: r });
        try { caps.combined.end(); } catch (err) {
            void err;
        }
        try { caps.rx.end(); } catch (err) {
            void err;
        }
        try { caps.tx.end(); } catch (err) {
            void err;
        }
    log('info', 'capture_saved', { combined: caps.combinedPath, rx: caps.rxPath, tx: caps.txPath });
    });

    ws.on('error', (err) => {
    log('error', 'ws_error', { err: err?.message || String(err) });
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
            log('debug', 'stats', { rxFrames: frames, rxBytes: bytes, rxSamples, rxTexts: texts, channels: chStats, previews: prevParts.join(' | ') });
            // reset window
            frames = 0;
            bytes = 0;
            texts = 0;
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
    log('info', 'listening', { proto: 'ws', url: `ws://0.0.0.0:${PORT}${WS_PATH}`, health: `http://0.0.0.0:${PORT}/health` });
});
