import { EventEmitter } from 'events';
import { ResultSimulator } from '../../src/sidecar/signaling/result-simulator';

describe('ResultSimulator', () => {
  test('emits >=2 partials then final with latency field', async () => {
    jest.setTimeout(5000);
    const emitter = new EventEmitter();
    const partials: any[] = [];
    let final: any | null = null;

    emitter.on('result', (ev) => {
      if (ev.stage === 'partial') partials.push(ev);
      else if (ev.stage === 'final') final = ev;
    });

    const sim = new ResultSimulator(emitter, {
      partialIntervalMs: 70,
      finalAfterMs: 300,
      textPool: ['alpha', 'beta']
    });
    sim.start();

    await new Promise(r => setTimeout(r, 520));
    sim.stop();

    expect(partials.length).toBeGreaterThanOrEqual(2);
    expect(final).not.toBeNull();
    expect(final && final.latencyMs).toBeGreaterThanOrEqual(290);
  });
});