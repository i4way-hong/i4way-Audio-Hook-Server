// Quick test client for sidecar WS
// Usage: node scripts/test_sidecar_ws_client.js ws://127.0.0.1:9091/mrcp
const WebSocket = require('ws');
const url = process.argv[2] || process.env.MRCP_SIDECAR_URL || 'ws://127.0.0.1:9091/mrcp';

const ws = new WebSocket(url);
let codec = process.env.STT_ENCODING || 'PCMU';
let sampleRate = Number(process.env.STT_RATE || 8000);
let ptime = 20; // ms

function makeSilenceFrame() {
    if (codec.toUpperCase() === 'PCMU') {
        // 20ms @ 8kHz -> 160 bytes μ-law silence (0xFF)
        const bytes = Math.floor((sampleRate * ptime) / 1000);
        return Buffer.alloc(bytes, 0xff);
    }
    // L16 mono: 16-bit signed PCM zeros
    const samples = Math.floor((sampleRate * ptime) / 1000);
    const buf = Buffer.alloc(samples * 2);
    return buf;
}

ws.on('open', () => {
    console.log('WS connected:', url);
    const init = {
        type: 'init',
        endpoint: process.env.STT_ENDPOINT || 'rtsp://127.0.0.1:8060/unimrcp',
        profileId: process.env.STT_MRCP_PROFILE || 'ah-mrcpv1',
        codec,
        sampleRate,
        mono: true,
        ptime,
    };
    ws.send(JSON.stringify(init));
    console.log('sent init', init);
});

ws.on('message', (data, isBinary) => {
    if (isBinary) {
        return;
    }
    let obj;
    try {
        obj = JSON.parse(String(data));
    } catch (e) {
        console.log('text', String(data));
        return;
    }
    console.log('event', obj);
    if (obj && obj.type === 'rtp-started') {
        // send 5 seconds of silence frames then bye
        let sent = 0;
        const interval = setInterval(() => {
            const frame = makeSilenceFrame();
            ws.send(frame);
            sent += 1;
            if (sent >= (1000 / ptime) * 5) {
                clearInterval(interval);
                ws.send(JSON.stringify({ type: 'bye' }));
            }
        }, ptime);
    }
});

ws.on('close', () => console.log('WS closed'));
ws.on('error', (e) => console.error('WS error', e));
