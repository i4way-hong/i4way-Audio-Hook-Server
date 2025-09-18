export function resampleL16(input: Int16Array, inRate: number, outRate: number, channels: number): Int16Array {
    if (inRate === outRate) {
        return input;
    }
    const frames = (input.length / channels) | 0;
    const ratio = outRate / inRate;
    const outFrames = Math.max(1, Math.floor(frames * ratio));
    const out = new Int16Array(outFrames * channels);
    for (let ch = 0; ch < channels; ch++) {
        for (let i = 0; i < outFrames; i++) {
            const t = i / ratio;
            const i0 = Math.floor(t);
            const i1 = Math.min(i0 + 1, frames - 1);
            const frac = t - i0;
            const s0 = input[i0 * channels + ch];
            const s1 = input[i1 * channels + ch];
            const v = s0 + (s1 - s0) * frac;
            out[i * channels + ch] = Math.max(-32768, Math.min(32767, Math.round(v)));
        }
    }
    return out;
}
