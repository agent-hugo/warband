import { describe, expect, it } from 'vitest';
import { CARDS, MOVES } from '../src/engine/content';
import {
  allReady, card, energyLeft, hero, liveEnemies, newGame, pickReward, planCard, planMove, resolveRound, rnd,
  setReady, validTargets,
} from '../src/engine/engine';
import type { GameState, HeroId } from '../src/engine/types';

function setHand(s: GameState, id: HeroId, cards: string[]) {
  const h = hero(s, id);
  h.hand = cards.map((c, i) => ({ uid: `${id}${i}`, id: c }));
}

/** «Гоблинский дозор», раунд 3 из обсуждения. */
function exampleRound() {
  const s = newGame(1, 2);
  const [orc, shaman, archer] = s.enemies;
  orc!.hp = 17;
  orc!.intent = { move: 'smash', target: 'blade' };
  shaman!.hp = 9;
  shaman!.intent = { move: 'heal', target: orc!.uid };
  archer!.hp = 10;
  archer!.intent = { move: 'shot', target: 'mystic' };
  hero(s, 'guard').hp = 38;
  hero(s, 'blade').hp = 22;
  hero(s, 'blade').attacks = 5;
  hero(s, 'mystic').hp = 30;
  setHand(s, 'guard', ['g_defend', 'g_defend', 'g_cover', 'g_taunt', 'g_bash']);
  setHand(s, 'blade', ['b_strike', 'b_strike', 'b_trip', 'b_exec', 'b_defend']);
  setHand(s, 'mystic', ['m_mark', 'm_spark', 'm_frost', 'm_delay', 'm_ward']);
  return { s, orc: orc!, shaman: shaman!, archer: archer! };
}

describe('пример раунда', () => {
  it('ближний бой не достаёт до тыла врага', () => {
    const { s, shaman } = exampleRound();
    expect(validTargets(s, hero(s, 'blade'), card('b_strike'))).not.toContain(shaman.uid);
    expect(validTargets(s, hero(s, 'mystic'), card('m_spark'))).toContain(shaman.uid);
    expect(planMove(s, 'blade', 1)).toMatch(/прорвите/);
  });

  it('розыгрыш идёт по скоростям: Озноб переносит лечение после Казни', () => {
    const { s, orc, shaman, archer } = exampleRound();
    expect(planCard(s, 'guard', 'guard3')).toBeNull(); // Вызов
    expect(planCard(s, 'guard', 'guard0')).toBeNull();
    expect(planCard(s, 'guard', 'guard1')).toBeNull();
    expect(planCard(s, 'blade', 'blade0', orc.uid)).toBeNull(); // Удар
    expect(planCard(s, 'blade', 'blade3', orc.uid)).toBeNull(); // Казнь
    expect(planCard(s, 'mystic', 'mystic0', orc.uid)).toBeNull(); // Метка
    expect(planCard(s, 'mystic', 'mystic1', archer.uid)).toBeNull(); // Искра
    expect(planCard(s, 'mystic', 'mystic2', shaman.uid)).toBeNull(); // Ледяная хватка
    expect(energyLeft(hero(s, 'mystic'))).toBe(1);
    expect(planCard(s, 'guard', 'guard4', orc.uid)).toMatch(/энергии/);

    const { state, steps } = resolveRound(s);
    const text = steps.map((x) => x.text).join('\n');
    const e = (uid: string) => state.enemies.find((x) => x.uid === uid)!;
    expect(e(orc.uid).hp).toBe(0);
    expect(e(shaman.uid).hp).toBe(4);
    expect(e(archer.uid).hp).toBe(6);
    expect(hero(state, 'mystic').hp).toBe(30 - MOVES.shot!.dmg!);
    expect(hero(state, 'blade').hp).toBe(22);
    expect(text).toMatch(/6-я атака ×2/);
    expect(text).toMatch(/🎯 ×2/);
    expect(text).toMatch(/лечение сгорает/);
    // Озноб на 2 раунда: после конца раунда остался 1
    expect(e(shaman.uid).st.chill).toBe(1);
    expect(state.round).toBe(2);
  });

  it('после гибели фронта можно пройти «в гущу» и достать тыл', () => {
    const { s, orc, shaman } = exampleRound();
    orc.hp = 0;
    expect(planMove(s, 'blade', 1)).toBeNull();
    expect(validTargets(s, hero(s, 'blade'), card('b_strike'))).toContain(shaman.uid);
  });
});

describe('случайные партии', () => {
  it('доходят до конца без ошибок', () => {
    let wins = 0;
    for (let seed = 1; seed <= 60; seed++) {
      let s = newGame(seed);
      const r = { ...s, rng: seed * 7919 } as GameState;
      for (let guard = 0; guard < 400 && (s.phase === 'plan' || s.phase === 'reward'); guard++) {
        if (s.phase === 'reward') {
          for (const id of ['guard', 'blade', 'mystic'] as HeroId[]) {
            const o = s.offers[id];
            if (o) pickReward(s, id, o[0] ?? null);
          }
          continue;
        }
        for (const h of s.heroes) {
          if (h.down) continue;
          if (rnd(r) < 0.3) planMove(s, h.id, rnd(r) < 0.7 ? 1 : -1);
          for (const c of [...h.hand]) {
            const def = CARDS[c.id]!;
            const targets = validTargets(s, h, def);
            const t = targets[Math.floor(rnd(r) * targets.length)];
            planCard(s, h.id, c.uid, def.target === 'none' ? undefined : t);
          }
          setReady(s, h.id, true);
        }
        expect(allReady(s)).toBe(true);
        s = resolveRound(s).state;
        for (const u of [...s.heroes, ...s.enemies]) expect(u.hp).toBeGreaterThanOrEqual(0);
      }
      expect(['won', 'lost']).toContain(s.phase);
      if (s.phase === 'won') wins++;
      expect(liveEnemies(s).length === 0 || s.phase === 'lost').toBe(true);
    }
    console.log(`случайные игроки: ${wins}/60 побед`);
  });
});
