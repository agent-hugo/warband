import { describe, expect, it } from 'vitest';
import { Predictor, Timeline } from '../src/game/predict';
import { Sim, type Input } from '../src/game/sim';
import { DIRS, STOP, WALLS, blocked, quantize, spawnPoint, step } from '../src/game/world';

describe('world', () => {
  it('quantizes directions', () => {
    expect(quantize(1, 0)).toBe(0);
    expect(quantize(0, 1)).toBe(DIRS / 4);
    expect(quantize(-1, 0)).toBe(DIRS / 2);
    expect(quantize(0, -1)).toBe((DIRS * 3) / 4);
    expect(quantize(0.1, 0, 5)).toBe(STOP);
  });

  it('moves at a constant speed and stops at walls', () => {
    let p = { x: 100, y: 100 };
    p = step(p, 0);
    expect(p).toEqual({ x: 105, y: 100 });
    for (let i = 0; i < 100; i++) p = step(p, DIRS / 2);
    expect(p.x).toBe(30 + 9); // against the left border
    expect(blocked(p)).toBe(false);
  });

  it('slides along a wall when moving diagonally into it', () => {
    let p = { x: 100, y: 50 };
    for (let i = 0; i < 20; i++) p = step(p, (DIRS * 5) / 8); // up-left
    expect(p.y).toBe(39);
    expect(p.x).toBeLessThan(100);
  });

  it('never ends inside a wall', () => {
    let p = spawnPoint([]);
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 5000; i++) {
      p = step(p, Math.floor(rnd() * DIRS));
      expect(blocked(p)).toBe(false);
    }
    expect(WALLS.length).toBeGreaterThan(4);
  });
});

describe('prediction', () => {
  it('matches the host after replaying unacknowledged inputs', () => {
    const sim = new Sim();
    sim.add('a', { x: 300, y: 300 });
    const pr = new Predictor();
    pr.server({ x: 300, y: 300 }, 0, true);
    // Inputs reach the host 4 ticks late, snapshots come back 3 ticks late.
    const toHost: Input[][] = [];
    const toClient: ReturnType<Sim['snapshot']>[] = [];
    for (let t = 0; t < 200; t++) {
      const dir = t < 60 ? 0 : t < 120 ? DIRS / 4 : t < 150 ? STOP : DIRS / 8;
      const inp = pr.input(dir, true);
      toHost.push(inp ? [inp] : []);
      if (toHost.length > 4) sim.input('a', toHost.shift()!);
      sim.tick();
      toClient.push(sim.snapshot(t));
      if (toClient.length > 3) {
        const s = toClient.shift()!;
        const [, x, y, , ack] = s.ps[0]!;
        pr.server({ x, y }, ack, true);
      }
    }
    for (const b of toHost) sim.input('a', b);
    for (let i = 0; i < 10; i++) sim.tick();
    const [, x, y, , ack] = sim.snapshot(0).ps[0]!;
    pr.server({ x, y }, ack, true);
    expect(pr.self).toEqual({ x, y });
    expect(pr.corrections).toBe(0);
  });

  it('applies two inputs a tick when they arrive in a burst', () => {
    const sim = new Sim();
    sim.add('a', { x: 300, y: 300 });
    sim.input('a', Array.from({ length: 9 }, (_, i) => [i + 1, 0] as Input));
    sim.tick();
    expect(sim.players.get('a')!.x).toBe(310);
    sim.input('a', [[3, 0], [10, 0]]); // a copy and a new one
    expect(sim.players.get('a')!.q.length).toBe(8);
  });
});

describe('timeline', () => {
  it('interpolates between snapshots on the host clock', () => {
    const tl = new Timeline();
    tl.push({ k: 's', n: 1, h: 1000, ps: [['a', 0, 0, 0, 0]] }, 5000);
    tl.push({ k: 's', n: 2, h: 1100, ps: [['a', 10, 0, 0, 0]] }, 5100);
    expect(tl.at(5150, 100)!.get('a')!.x).toBeCloseTo(5);
    expect(tl.at(5400, 100)!.get('a')!.x).toBe(10);
  });
});
