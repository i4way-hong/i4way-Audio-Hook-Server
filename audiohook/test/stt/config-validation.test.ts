import sttConfig from '../../src/utils/stt-config';

// Smoke test to avoid intermittent "no tests" flake
test('smoke: jest sees tests (config-validation)', () => {
    expect(true).toBe(true);
});

describe('STT config validation/normalization', () => {
    test('invalid protocol falls back to websocket', () => {
        const restore = sttConfig.applyOverrides({ protocol: 'invalid' as unknown as never });
        expect(sttConfig.protocol).toBe('websocket');
        restore();
    });

    test('non-positive ping disables ping', () => {
        const restore = sttConfig.applyOverrides({ wsPingSec: 0 });
        expect(sttConfig.wsPingSec).toBeNull();
        restore();
    });

    test('negative ping disables ping', () => {
        const restore = sttConfig.applyOverrides({ wsPingSec: -5 });
        expect(sttConfig.wsPingSec).toBeNull();
        restore();
    });

    test('unknown tcp framing becomes raw', () => {
        const restore = sttConfig.applyOverrides({ tcpFraming: 'weird' as unknown as never });
        expect(sttConfig.tcpFraming).toBe('raw');
        restore();
    });

    test('invalid hex is sanitized to null', () => {
        const restore = sttConfig.applyOverrides({ tcpInitHex: 'zz', tcpByeHex: '1' });
        expect(sttConfig.tcpInitHex).toBeNull();
        expect(sttConfig.tcpByeHex).toBeNull();
        restore();
    });
});
