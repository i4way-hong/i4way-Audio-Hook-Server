import { resampleL16 } from '../../src/audio/resample';
// Node < 18 혹은 JSDOM 환경 보정: globalThis.performance 없으면 perf_hooks 사용
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
if (typeof performance === 'undefined') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { performance: perf } = require('perf_hooks');
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    global.performance = perf;
}

// 타입 선언 (jest tsdom 환경에서 global.performance polyfill 시 만족)
declare global {
    // eslint-disable-next-line @typescript-eslint/no-namespace
    // @ts-ignore
    var performance: { now(): number };
}

describe('resampleL16 micro-benchmark', () => {
    function stats(values: number[]) {
        const n = values.length;
        const mean = values.reduce((a, b) => a + b, 0) / n;
        const variance = values.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
        const stdev = Math.sqrt(variance);
        return { mean, stdev };
    }

    test('8k -> 16k mono, 100ms x N iters', () => {
        const inRate = 8000;
        const outRate = 16000;
        const channels = 1;
        const frames = 800; // 100ms at 8k mono
        const input = new Int16Array(frames * channels);
        for (let i = 0; i < input.length; i++) input[i] = (i % 128) - 64;

        const iters = 20;
        const times: number[] = [];
        for (let i = 0; i < iters; i++) {
            const t0 = performance.now();
            const out = resampleL16(input, inRate, outRate, channels);
            const t1 = performance.now();
            times.push(t1 - t0);
            expect(out.length).toBe(frames * 2 * channels);
        }
        const { mean, stdev } = stats(times);
        // Sanity
        expect(Number.isFinite(mean)).toBe(true);
        expect(Number.isFinite(stdev)).toBe(true);
    });

    test('stereo 16k -> 8k, 100ms x N iters', () => {
        const inRate = 16000;
        const outRate = 8000;
        const channels = 2;
        const frames = 1600; // 100ms at 16k per channel => interleaved length = 3200
        const input = new Int16Array(frames * channels);
        for (let i = 0; i < frames; i++) {
            input[i * 2] = 1000;
            input[i * 2 + 1] = -2000;
        }
        const iters = 20;
        const times: number[] = [];
        for (let i = 0; i < iters; i++) {
            const t0 = performance.now();
            const out = resampleL16(input, inRate, outRate, channels);
            const t1 = performance.now();
            times.push(t1 - t0);
            expect(out.length).toBe(frames / 2 * channels);
        }
        const mean = times.reduce((a, b) => a + b, 0) / times.length;
        expect(Number.isFinite(mean)).toBe(true);
    });
});