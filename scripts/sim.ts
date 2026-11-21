/**
 * Balance check: a greedy party plays many campaigns.
 * Usage: npm run sim -- [games=300]
 */
import { ENCOUNTERS } from '../src/engine/content';
import {
  allReady, canHeroStep, card, energyLeft, liveEnemies, newGame, pickReward, planCard, planMove, plannedPos,
  resolveRound, setReady, validTargets, canReach,
} from '../src/engine/engine';
import type { GameState, Hero } from '../src/engine/types';

const games = Number(process.argv[2] ?? 300);

/** Damage first (focus the weakest reachable enemy), then defence. */
function planHero(s: GameState, h: Hero) {
  if (h.down) return setReady(s, h.id, true);
  const melee = h.id !== 'mystic';
  if (melee && !liveEnemies(s).some((e) => canReach(plannedPos(s, h), e, 'melee')) && canHeroStep(s, plannedPos(s, h), 1))
    planMove(s, h.id, 1);
  const score = (id: string) => {
    const d = card(id);
    return (d.attack ? 10 : 0) + (d.target === 'enemy' && !d.attack ? 5 : 0) - d.cost;
  };
  for (const c of [...h.hand].sort((a, b) => score(b.id) - score(a.id))) {
    const d = card(c.id);
    if (d.cost > energyLeft(h)) continue;
    let target: string | undefined;
    if (d.target === 'enemy') {
      const ts = validTargets(s, h, d).map((u) => s.enemies.find((e) => e.uid === u)!).sort((a, b) => a.hp - b.hp);
      target = ts[0]?.uid;
      if (!target) continue;
    } else if (d.target === 'ally' || d.target === 'other') {
      const ts = validTargets(s, h, d).map((u) => s.heroes.find((x) => x.uid === u)!).sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
      target = ts[0]?.uid;
      if (!target) continue;
    }
    planCard(s, h.id, c.uid, target);
  }
  setReady(s, h.id, true);
}

interface BattleStat { rounds: number[]; firstRound: number[]; hpLost: number[]; reached: number; won: number }
const stats: BattleStat[] = ENCOUNTERS.map(() => ({ rounds: [], firstRound: [], hpLost: [], reached: 0, won: 0 }));
let wins = 0;

for (let g = 0; g < games; g++) {
  let s = newGame(1000 + g);
  let battle = -1;
  let rounds = 0;
  let hpStart = 0;
  let enemyHp = 0;
  while (s.phase !== 'won' && s.phase !== 'lost') {
    if (s.battle !== battle) {
      battle = s.battle;
      rounds = 0;
      stats[battle]!.reached++;
      hpStart = s.heroes.reduce((a, h) => a + h.hp, 0);
      enemyHp = s.enemies.reduce((a, e) => a + e.maxHp, 0);
    }
    if (s.phase === 'reward') {
      for (const h of s.heroes) pickReward(s, h.id, s.offers[h.id]?.[g % 3] ?? null);
      continue;
    }
    for (const h of s.heroes) planHero(s, h);
    if (!allReady(s)) throw new Error('stuck');
    const before = s.battle;
    s = resolveRound(s).state;
    rounds++;
    const st = stats[before]!;
    if (rounds === 1) {
      const left = s.battle === before && s.phase === 'plan' ? s.enemies.reduce((a, e) => a + Math.max(0, e.hp), 0) : 0;
      st.firstRound.push(1 - left / enemyHp);
    }
    if (s.phase !== 'plan' || s.battle !== before) {
      st.rounds.push(rounds);
      st.hpLost.push(hpStart - s.heroes.reduce((a, h) => a + h.hp, 0));
      if (s.phase !== 'lost') st.won++;
    }
    if (rounds > 60) throw new Error('too long');
  }
  if (s.phase === 'won') wins++;
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
console.log(`games ${games}, campaign wins ${((wins / games) * 100).toFixed(0)}%`);
ENCOUNTERS.forEach((e, i) => {
  const st = stats[i]!;
  console.log(
    `${i + 1}. ${e.name.padEnd(18)} reached ${String(st.reached).padStart(4)}  won ${((st.won / Math.max(1, st.reached)) * 100).toFixed(0).padStart(3)}%` +
      `  rounds ${avg(st.rounds).toFixed(1)}  1st-round dmg ${(avg(st.firstRound) * 100).toFixed(0)}%  party HP lost ${avg(st.hpLost).toFixed(0)}`,
  );
});
