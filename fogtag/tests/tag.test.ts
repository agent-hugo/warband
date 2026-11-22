import { describe, expect, it } from 'vitest';
import { Predictor } from '../src/game/predict';
import { Sim } from '../src/game/sim';
import { END_TICKS, FREEZE_TICKS, HIDE_TICKS, IT_SPEED, ROUND_TICKS, Tag, speedOf } from '../src/game/tag';
import { BUSHES, DIRS, SPEED, WALLS, blocked, clearLine, sees, step, type Vec } from '../src/game/world';

const at = (o: Record<string, Vec>) => new Map(Object.entries(o));

describe('world for tag', () => {
  it('keeps bushes clear of walls', () => {
    for (const b of BUSHES)
      for (const w of WALLS) expect(b.x < w.x + w.w && b.x + b.w > w.x && b.y < w.y + w.h && b.y + b.h > w.y).toBe(false);
  });

  it('moves at the given speed', () => {
    expect(step({ x: 300, y: 100 }, 0, IT_SPEED).x).toBeCloseTo(300 + IT_SPEED / 30, 1);
    expect(step({ x: 300, y: 100 }, 0, 0)).toEqual({ x: 300, y: 100 });
  });

  it('sees near, not through walls, not into a far bush', () => {
    expect(sees({ x: 100, y: 100 }, { x: 200, y: 100 })).toBe(true);
    expect(sees({ x: 100, y: 100 }, { x: 400, y: 100 })).toBe(false); // too far
    // the centre block 540..660 × 390..510
    expect(clearLine({ x: 520, y: 450 }, { x: 680, y: 450 })).toBe(false);
    expect(sees({ x: 520, y: 450 }, { x: 680, y: 450 })).toBe(false);
    const b = BUSHES[0]!;
    const inside = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
    expect(sees({ x: inside.x + 100, y: inside.y }, inside)).toBe(false);
    expect(sees({ x: inside.x + 30, y: inside.y }, inside)).toBe(true);
    expect(blocked(inside)).toBe(false);
  });
});

describe('tag', () => {
  it('waits for two players, then hides, chases and ends', () => {
    const t = new Tag(() => 0);
    t.update(1, at({ a: { x: 100, y: 100 } }));
    expect(t.st.ph).toBe('wait');
    const ps = at({ a: { x: 100, y: 100 }, b: { x: 800, y: 800 } });
    t.update(2, ps);
    expect(t.st).toMatchObject({ ph: 'hide', it: 'a' });
    expect(t.speed('a', 3)).toBe(0);
    expect(t.speed('b', 3)).toBe(SPEED);
    let n = 2;
    while (t.st.ph === 'hide') t.update(++n, ps);
    expect(n).toBe(2 + HIDE_TICKS);
    expect(t.speed('a', n + 1)).toBe(IT_SPEED);
    while (t.st.ph === 'chase') t.update(++n, ps);
    expect(t.st.sc.find(([id]) => id === 'b')).toEqual(['b', 0, 1]);
    expect(t.st.sc.find(([id]) => id === 'a')![1]).toBe(ROUND_TICKS);
    const endAt = n;
    while (t.st.ph === 'end') t.update(++n, ps);
    expect(n).toBe(endAt + END_TICKS);
    expect(t.st).toMatchObject({ ph: 'hide', it: 'a' });
    expect(t.st.sc.find(([id]) => id === 'a')![1]).toBe(0);
  });

  it('waits until everyone has a direct link', () => {
    const t = new Tag(() => 0);
    const ps = at({ a: { x: 100, y: 100 }, b: { x: 800, y: 800 } });
    const ready = new Set(['a']);
    t.update(1, ps, (id) => ready.has(id));
    expect(t.st).toMatchObject({ ph: 'wait', wt: ['b'] });
    ready.add('b');
    t.update(2, ps, (id) => ready.has(id));
    expect(t.st).toMatchObject({ ph: 'hide', it: 'a', wt: [] });
    // Once the round is on, a lost link does not stop it.
    ready.delete('b');
    t.update(3, ps, (id) => ready.has(id));
    expect(t.st.ph).toBe('hide');
  });

  it('passes the role on a touch and freezes the new one', () => {
    const t = new Tag(() => 0);
    const ps = at({ a: { x: 100, y: 100 }, b: { x: 500, y: 100 } });
    let n = 1;
    t.update(n, ps);
    while (t.st.ph === 'hide') t.update(++n, ps);
    ps.set('b', { x: 115, y: 100 });
    t.update(++n, ps);
    expect(t.st.it).toBe('b');
    expect(t.st.tag).toEqual(['a', 'b', n]);
    expect(t.speed('b', n + 1)).toBe(0);
    // Still touching while frozen: no touch back.
    for (let i = 0; i < FREEZE_TICKS - 1; i++) t.update(++n, ps);
    expect(t.st.it).toBe('b');
    t.update(++n, ps);
    expect(t.st.it).toBe('a');
  });

  it('gives the role to someone else when "it" leaves', () => {
    const t = new Tag(() => 0);
    t.update(1, at({ a: { x: 100, y: 100 }, b: { x: 500, y: 100 }, c: { x: 500, y: 500 } }));
    expect(t.st.it).toBe('a');
    t.update(2, at({ b: { x: 500, y: 100 }, c: { x: 500, y: 500 } }));
    expect(['b', 'c']).toContain(t.st.it);
  });

  it('sends only what a player sees while it is foggy', () => {
    const t = new Tag(() => 0);
    const ps = at({ a: { x: 100, y: 100 }, b: { x: 200, y: 100 }, c: { x: 1000, y: 700 } });
    t.update(1, ps);
    expect([...t.visibleTo('a', 1, ps, ps)].sort()).toEqual(['a', 'b']);
    // Just gone out of sight: kept a moment, then dropped.
    ps.set('b', { x: 1000, y: 100 });
    expect(t.visibleTo('a', 2, ps, ps).has('b')).toBe(true);
    expect(t.visibleTo('a', 20, ps, ps).has('b')).toBe(false);
    t.st.ph = 'end';
    expect(t.visibleTo('a', 21, ps, ps).size).toBe(3);
  });
});

describe('prediction with roles', () => {
  it('matches the host when running faster as "it"', () => {
    const sim = new Sim();
    sim.add('a', { x: 300, y: 300 });
    const g = { ph: 'chase' as const, end: 1e9, it: 'a', fz: 0, sc: [], tag: null };
    const pr = new Predictor();
    pr.speed = speedOf(g, 'a', 1);
    pr.server({ x: 300, y: 300 }, 0, true);
    for (let t = 0; t < 40; t++) {
      const inp = pr.input(t < 20 ? 0 : DIRS / 4, true)!;
      sim.input('a', [inp]);
      sim.tick(() => speedOf(g, 'a', sim.n + 1));
    }
    const [, x, y, , ack] = sim.snapshot(0).ps[0]!;
    pr.server({ x, y }, ack, true);
    expect(pr.self).toEqual({ x, y });
    expect(pr.corrections).toBe(0);
    expect(x).toBeGreaterThan(300 + 20 * (SPEED / 30));
  });
});
