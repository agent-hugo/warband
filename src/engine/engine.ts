import { CARDS, ENCOUNTERS, ENEMIES, HEROES, HERO_ORDER, MOVES, POS_NAME, STATUS_ICON } from './content';
import type {
  CardDef, CardKind, Enemy, GameState, Hero, HeroId, PlanItem, PlayCtx, Pos, Speed, StatusId, Step, Unit,
} from './types';

export const HAND_SIZE = 5;
export const ENERGY = 3;
export const MOVE_COST = 1;

// ───────── случайность (детерминированная, состояние в GameState) ─────────

export function rnd(s: GameState): number {
  s.rng = (s.rng + 0x6d2b79f5) | 0;
  let t = s.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function shuffle<T>(s: GameState, arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd(s) * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function pick<T>(s: GameState, arr: T[]): T {
  return arr[Math.floor(rnd(s) * arr.length)]!;
}

// ───────── выборки ─────────

export const card = (id: string): CardDef => {
  const c = CARDS[id];
  if (!c) throw new Error(`unknown card ${id}`);
  return c;
};
export const hero = (s: GameState, id: string): Hero => {
  const h = s.heroes.find((x) => x.uid === id);
  if (!h) throw new Error(`unknown hero ${id}`);
  return h;
};
export const liveEnemies = (s: GameState) => s.enemies.filter((e) => e.hp > 0);
export const liveHeroes = (s: GameState) => s.heroes.filter((h) => !h.down);
export const unitByUid = (s: GameState, uid: string | undefined): Unit | undefined =>
  uid === undefined ? undefined : [...s.heroes, ...s.enemies].find((u) => u.uid === uid);

/** Достаёт ли герой с позиции pos врага картой данного типа. */
export function canReach(pos: number, e: Enemy, kind: CardKind): boolean {
  if (e.hp <= 0) return false;
  if (kind === 'melee') return Math.abs(pos - e.pos) <= 1 && !e.st.away;
  return true;
}

/** Герои, до которых враг достаёт ближней атакой. */
export function heroesInMelee(s: GameState, e: Enemy): Hero[] {
  return liveHeroes(s).filter((h) => Math.abs(h.pos - e.pos) <= 1);
}

/** Можно ли герою шагнуть с позиции from: вперёд — только если там нет живых врагов. */
export function canHeroStep(s: GameState, from: number, dir: 1 | -1): boolean {
  const to = from + dir;
  if (to < 0 || to > 2) return false;
  if (dir === 1 && liveEnemies(s).some((e) => e.pos === to)) return false;
  return true;
}

function lowestHp<T extends Unit>(units: T[]): T | undefined {
  return units.reduce<T | undefined>((best, u) => (!best || u.hp < best.hp ? u : best), undefined);
}

// ───────── новая игра и бои ─────────

function uid(s: GameState): string {
  return `c${++s.uidSeq}`;
}

export function newGame(seed = Date.now(), battle = 0): GameState {
  const s: GameState = {
    rng: seed | 0, phase: 'plan', battle: 0, round: 0, heroes: [], enemies: [], offers: {}, uidSeq: 0, log: [],
  };
  s.heroes = HERO_ORDER.map((id) => {
    const d = HEROES[id];
    return {
      side: 'hero', id, uid: id, name: d.name, icon: d.icon, hp: d.hp, maxHp: d.hp, block: 0, st: {}, pos: d.pos,
      energy: ENERGY, owned: d.deck.map((c) => ({ uid: uid(s), id: c })), draw: [], hand: [], discard: [],
      attacks: 0, down: false, plan: [], ready: false, nextBonus: 0, rally: 0,
    };
  });
  startBattle(s, battle);
  return s;
}

export function startBattle(s: GameState, idx: number): void {
  const enc = ENCOUNTERS[idx];
  if (!enc) throw new Error(`no encounter ${idx}`);
  s.battle = idx;
  s.round = 0;
  s.phase = 'plan';
  s.offers = {};
  s.log = [];
  const counts: Record<string, number> = {};
  enc.enemies.forEach((k) => (counts[k] = (counts[k] ?? 0) + 1));
  const seen: Record<string, number> = {};
  s.enemies = enc.enemies.map((k, i) => {
    const d = ENEMIES[k]!;
    seen[k] = (seen[k] ?? 0) + 1;
    const name = counts[k]! > 1 ? `${d.name} ${'АБВГД'[seen[k]! - 1]}` : d.name;
    return {
      side: 'enemy', uid: `e${idx}_${i}`, kind: k, name, icon: d.icon, hp: d.hp, maxHp: d.hp, block: 0, st: {},
      pos: d.pos, step: Math.floor(rnd(s) * d.pattern.length), intent: null, acted: false, leapUsed: false,
    };
  });
  for (const h of s.heroes) {
    h.pos = HEROES[h.id].pos;
    h.block = 0;
    h.st = {};
    h.attacks = 0;
    h.draw = shuffle(s, h.owned);
    h.hand = [];
    h.discard = [];
  }
  startRound(s);
}

function drawCards(s: GameState, h: Hero, n: number): void {
  for (let i = 0; i < n; i++) {
    if (!h.draw.length) {
      if (!h.discard.length) return;
      h.draw = shuffle(s, h.discard);
      h.discard = [];
    }
    h.hand.push(h.draw.pop()!);
  }
}

export function startRound(s: GameState): void {
  s.round++;
  for (const h of s.heroes) {
    h.plan = [];
    h.nextBonus = 0;
    h.rally = 0;
    if (h.down) {
      h.ready = true;
      continue;
    }
    h.ready = false;
    h.energy = ENERGY;
    drawCards(s, h, HAND_SIZE);
  }
  for (const e of s.enemies) {
    e.acted = false;
    e.intent = e.hp > 0 ? makeIntent(s, e) : null;
  }
}

// ───────── намерения врагов ─────────

function patternMove(e: Enemy, ahead = 0): string {
  const p = ENEMIES[e.kind]!.pattern;
  return p[(e.step + ahead) % p.length]!;
}

function chooseHeroTarget(s: GameState, e: Enemy, move: string): Hero | undefined {
  const mv = MOVES[move]!;
  if (mv.range === 'melee') {
    const r = heroesInMelee(s, e);
    return r.find((h) => h.st.taunt) ?? lowestHp(r);
  }
  const live = liveHeroes(s);
  if (mv.preferRear) {
    const rear = live.filter((h) => h.pos === 0);
    if (rear.length) return lowestHp(rear);
  }
  return lowestHp(live);
}

function makeIntent(s: GameState, e: Enemy): Enemy['intent'] {
  const kind = ENEMIES[e.kind]!;
  const near = heroesInMelee(s, e);
  if (kind.leaps && !e.leapUsed && near.length) return { move: 'leap', target: lowestHp(near)!.uid };
  const move = patternMove(e);
  const mv = MOVES[move]!;
  if (mv.range === 'melee' && !near.length) return { move: 'advance' };
  if (mv.range === 'ally') {
    const hurt = liveEnemies(s).reduce((b, x) => (x.maxHp - x.hp > b.maxHp - b.hp ? x : b), e);
    return { move, target: hurt.uid };
  }
  if ((mv.range === 'melee' || mv.range === 'ranged') && !mv.all) {
    return { move, target: chooseHeroTarget(s, e, move)?.uid };
  }
  return { move };
}

export function enemySpeed(e: Enemy): Speed {
  const base = e.intent ? MOVES[e.intent.move]!.speed : 1;
  return Math.min(3, base + (e.st.chill ? 1 : 0)) as Speed;
}

export interface IntentInfo {
  speed: Speed;
  text: string;
  stunned: boolean;
}

export function intentInfo(s: GameState, e: Enemy): IntentInfo | null {
  if (!e.intent || e.hp <= 0) return null;
  const mv = MOVES[e.intent.move]!;
  const str = e.st.str ?? 0;
  const tgt = unitByUid(s, e.intent.target);
  let text = mv.name;
  if (e.intent.move === 'advance') text = `Наступает → ${POS_NAME[Math.max(1, e.pos - 1)]}`;
  else if (e.intent.move === 'leap') text = `Отскок: ${MOVES.leap!.dmg! + str} урона и 💨`;
  else if (mv.dmg) text += ` ${mv.dmg + str}${mv.all ? (mv.range === 'melee' ? ' всем рядом' : ' всем') : ''}`;
  else if (mv.range === 'ally') text += ` +${mv.heal}`;
  else if (mv.str) text += ` +${mv.str} 💪`;
  else if (mv.heal) text += ` +${mv.heal} HP, ${mv.block} блока`;
  if (tgt && e.intent.move !== 'leap') text += ` → ${tgt.name}`;
  if (e.intent.move === 'leap' && tgt) text += ` → ${tgt.name}`;
  return { speed: enemySpeed(e), text, stunned: !!e.st.stun };
}

/** Что враг собирается делать раундом позже (видит Мистик). */
export function foresight(e: Enemy): string {
  if (!e.intent || e.hp <= 0) return '';
  const generated = e.intent.move === 'advance' || e.intent.move === 'leap';
  const ahead = generated || (e.st.stun && e.st.hold) ? 0 : 1;
  return MOVES[patternMove(e, ahead)]!.name;
}

// ───────── планирование ─────────

const isCard = (p: PlanItem): p is Extract<PlanItem, { t: 'card' }> => p.t === 'card';

export function planCardDef(h: Hero, p: PlanItem): CardDef | undefined {
  if (!isCard(p)) return undefined;
  const inst = h.hand.find((c) => c.uid === p.uid);
  return inst ? card(inst.id) : undefined;
}

export function energyLeft(h: Hero): number {
  return h.plan.reduce((e, p) => e - (isCard(p) ? (planCardDef(h, p)?.cost ?? 0) : MOVE_COST), h.energy);
}

/** Позиция героя после запланированных перемещений (своих и чужих «За мной!»). */
export function plannedPos(s: GameState, h: Hero): number {
  let pos: number = h.pos;
  for (const p of h.plan) pos += isCard(p) ? (planCardDef(h, p)?.moves ?? 0) : p.dir;
  for (const o of s.heroes) {
    if (o === h) continue;
    for (const p of o.plan) {
      const d = planCardDef(o, p);
      if (d?.moves && d.target === 'other' && isCard(p) && p.target === h.uid) pos += d.moves;
    }
  }
  return pos;
}

export function validTargets(s: GameState, h: Hero, def: CardDef): string[] {
  const pos = plannedPos(s, h) + (def.moves ?? 0);
  switch (def.target) {
    case 'enemy':
      return liveEnemies(s).filter((e) => canReach(pos, e, def.kind)).map((e) => e.uid);
    case 'ally':
      return liveHeroes(s).map((x) => x.uid);
    case 'other':
      return liveHeroes(s).filter((x) => x !== h).map((x) => x.uid);
    default:
      return [];
  }
}

function canPlan(s: GameState, h: Hero): string | null {
  if (s.phase !== 'plan') return 'Сейчас не фаза планирования';
  if (h.down) return 'Герой без сознания';
  if (h.ready) return 'Уже готов — сначала отмените готовность';
  return null;
}

export function planCard(s: GameState, heroId: HeroId, cardUid: string, target?: string): string | null {
  const h = hero(s, heroId);
  const err = canPlan(s, h);
  if (err) return err;
  const inst = h.hand.find((c) => c.uid === cardUid);
  if (!inst) return 'Карты нет в руке';
  if (h.plan.some((p) => isCard(p) && p.uid === cardUid)) return 'Карта уже в плане';
  const def = card(inst.id);
  if (def.cost > energyLeft(h)) return 'Не хватает энергии';
  if (def.moves) {
    if (!canHeroStep(s, plannedPos(s, h), def.moves)) return 'Туда не пройти';
    if (def.target === 'other' && target) {
      const ally = hero(s, target);
      if (!canHeroStep(s, plannedPos(s, ally), def.moves)) return `${ally.name} не может пройти`;
    }
  }
  if (def.target !== 'none') {
    if (!target || !validTargets(s, h, def).includes(target)) return 'Недоступная цель';
  } else if (def.kind === 'melee' && !liveEnemies(s).some((e) => canReach(plannedPos(s, h), e, 'melee'))) {
    return 'Никого нет в досягаемости';
  }
  h.plan.push({ t: 'card', uid: cardUid, target });
  return null;
}

export function planMove(s: GameState, heroId: HeroId, dir: 1 | -1): string | null {
  const h = hero(s, heroId);
  const err = canPlan(s, h);
  if (err) return err;
  if (energyLeft(h) < MOVE_COST) return 'Не хватает энергии';
  if (!canHeroStep(s, plannedPos(s, h), dir)) return dir === 1 ? 'Впереди враги — сначала прорвите их строй' : 'Дальше некуда';
  h.plan.push({ t: 'move', dir });
  return null;
}

/** Убирает пункт плана и всё, что после этого стало невозможным. */
export function unplan(s: GameState, heroId: HeroId, index: number): void {
  const h = hero(s, heroId);
  if (canPlan(s, h)) return;
  const rest = h.plan.filter((_, i) => i !== index);
  h.plan = [];
  for (const p of rest) {
    if (isCard(p)) planCard(s, heroId, p.uid, p.target);
    else planMove(s, heroId, p.dir);
  }
}

export function setReady(s: GameState, heroId: HeroId, ready: boolean): void {
  const h = hero(s, heroId);
  if (s.phase !== 'plan' || h.down) return;
  h.ready = ready;
}

export const allReady = (s: GameState) => s.phase === 'plan' && s.heroes.every((h) => h.ready);

// ───────── розыгрыш раунда ─────────

export function resolveRound(input: GameState): { state: GameState; steps: Step[] } {
  const s: GameState = structuredClone(input);
  const steps: Step[] = [];
  s.log = [];
  let pending: string | null = null;
  const over = () => !liveEnemies(s).length || !liveHeroes(s).length;

  const log = (t: string) => {
    if (pending !== null) {
      t = `${pending} — ${t}`;
      pending = null;
    }
    s.log.push(t);
    steps.push({ text: t, state: structuredClone(s) });
  };
  const flush = () => {
    if (pending !== null) {
      const p = pending;
      pending = null;
      log(p);
    }
  };

  const damage = (src: Unit | null, t: Unit, amount: number, o: { melee?: boolean; pierce?: boolean; note?: string } = {}) => {
    if (t.hp <= 0) return 0;
    if (t.st.vuln) amount += 2;
    if (t.side === 'hero' && t.id === 'guard') amount = Math.max(0, amount - 1);
    let absorbed = 0;
    if (!o.pierce) {
      absorbed = Math.min(t.block, amount);
      t.block -= absorbed;
    }
    const dmg = amount - absorbed;
    const before = t.hp;
    t.hp = Math.max(0, t.hp - dmg);
    let text = `${t.name}: ${o.note ? `(${o.note}) ` : ''}${absorbed ? `блок −${absorbed}, ` : ''}−${dmg} HP (${before}→${t.hp})`;
    if (t.hp === 0) {
      if (t.side === 'hero') {
        t.down = true;
        t.block = 0;
        text += ' — без сознания!';
      } else {
        text += ' ☠';
      }
    }
    log(text);
    if (o.melee && src && src.hp > 0 && t.st.thorns) damage(t, src, t.st.thorns, { note: '🌵 шипы' });
    return dmg;
  };

  const addStatus = (u: Unit, st: StatusId, n: number) => {
    if (u.hp <= 0) return;
    if (st === 'burn' || st === 'str') u.st[st] = (u.st[st] ?? 0) + n;
    else u.st[st] = Math.max(u.st[st] ?? 0, n);
    if (st !== 'hold') log(`${u.name}: ${STATUS_ICON[st]}`);
  };

  const heroStep = (h: Hero, dir: 1 | -1): boolean => {
    if (h.down) return false;
    if (canHeroStep(s, h.pos, dir)) {
      h.pos = (h.pos + dir) as Pos;
      log(`${h.icon} ${h.name}: ${dir > 0 ? 'шаг вперёд' : 'шаг назад'} → ${POS_NAME[h.pos]}`);
      return true;
    }
    log(`${h.icon} ${h.name}: путь закрыт, шаг не удался`);
    return false;
  };

  const playCard = (h: Hero, item: Extract<PlanItem, { t: 'card' }>) => {
    if (h.down || over()) return;
    const inst = h.hand.find((c) => c.uid === item.uid);
    if (!inst) return;
    const def = card(inst.id);
    h.hand = h.hand.filter((c) => c !== inst);
    h.discard.push(inst);
    const head = `${h.icon} ${h.name}: ${def.name}`;
    let target: Unit | null = null;
    if (def.target === 'enemy') {
      const t = s.enemies.find((e) => e.uid === item.target);
      if (t && canReach(h.pos, t, def.kind)) target = t;
      else if (def.attack) {
        const alt = liveEnemies(s).filter((e) => canReach(h.pos, e, def.kind));
        if (!alt.length) return log(`${head} — нет доступной цели, карта сгорает`);
        target = pick(s, alt);
        pending = `${head} → ${target.name} (прежняя цель ${t && t.hp > 0 ? 'недоступна' : 'погибла'})`;
      } else return log(`${head} — цель ${t && t.hp > 0 ? 'недоступна' : 'погибла'}, карта сгорает`);
    } else if (def.target === 'ally' || def.target === 'other') {
      const t = s.heroes.find((x) => x.uid === item.target);
      if (!t || t.down) return log(`${head} — союзник без сознания, карта сгорает`);
      target = t;
    }
    if (pending === null) pending = target ? `${head} → ${target.name}` : head;

    const ctx: PlayCtx = {
      s, hero: h, target,
      enemy: target as Enemy,
      ally: target as Hero,
      strike: (t, base, o) => {
        h.attacks++;
        let amt = base;
        const notes: string[] = [];
        if (o?.markMult && t.st.mark) {
          amt *= o.markMult;
          notes.push(`🎯 ×${o.markMult}`);
        }
        if (h.id === 'blade' && h.attacks % 3 === 0) {
          amt *= 2;
          notes.push(`${h.attacks}-я атака ×2`);
        }
        if (h.nextBonus) {
          amt += h.nextBonus;
          notes.push(`+${h.nextBonus}`);
          h.nextBonus = 0;
        }
        if (h.rally) {
          amt += h.rally;
          notes.push(`клич +${h.rally}`);
        }
        return damage(h, t, amt, { melee: def.kind === 'melee', note: notes.join(', ') || undefined });
      },
      strikeMany: (targets, base) => {
        h.attacks++;
        let amt = base;
        const notes: string[] = [];
        if (h.id === 'blade' && h.attacks % 3 === 0) {
          amt *= 2;
          notes.push(`${h.attacks}-я атака ×2`);
        }
        if (h.nextBonus) {
          amt += h.nextBonus;
          notes.push(`+${h.nextBonus}`);
          h.nextBonus = 0;
        }
        amt += h.rally;
        if (!targets.length) log('никого рядом');
        for (const t of targets) damage(h, t, amt, { melee: def.kind === 'melee', note: notes.join(', ') || undefined });
      },
      block: (u, n) => {
        if (u.down) return;
        u.block += n;
        log(`${u.name}: +${n} блока (${u.block})`);
      },
      status: addStatus,
      move: heroStep,
      reachableEnemies: () => liveEnemies(s).filter((e) => canReach(h.pos, e, def.kind)),
      liveEnemies: () => liveEnemies(s),
      liveHeroes: () => liveHeroes(s),
      log,
    };
    def.play(ctx);
    flush();
  };

  const enemyAct = (e: Enemy) => {
    e.acted = true;
    const it = e.intent;
    if (!it || e.hp <= 0 || over()) return;
    const str = e.st.str ?? 0;
    const head = `${e.icon} ${e.name}`;
    if (e.st.stun) {
      const hold = !!e.st.hold;
      delete e.st.stun;
      delete e.st.hold;
      if (!hold && it.move !== 'advance' && it.move !== 'leap') e.step++;
      return log(`${head}: 💫 пропускает ход${hold ? ' (повторит позже)' : ''}`);
    }
    const mv = MOVES[it.move]!;
    if (it.move === 'advance') {
      const to = e.pos - 1;
      if (to >= 1 && !liveHeroes(s).some((h) => h.pos === to)) {
        e.pos = to as Pos;
        return log(`${head} наступает → ${POS_NAME[to]}`);
      }
      return log(`${head}: путь закрыт`);
    }
    if (it.move === 'leap') {
      const near = heroesInMelee(s, e);
      const t = near.find((h) => h.uid === it.target) ?? lowestHp(near) ?? lowestHp(liveHeroes(s));
      pending = `${head}: Отскок`;
      if (t) damage(e, t, MOVES.leap!.dmg! + str);
      e.leapUsed = true;
      e.st.away = 2;
      return log(`${e.name} разрывает дистанцию 💨 — ближние атаки до него не достают 2 раунда`);
    }
    pending = `${head}: ${mv.name}`;
    if (mv.range === 'melee' || mv.range === 'ranged') {
      let targets: Hero[];
      if (mv.all) targets = mv.range === 'melee' ? heroesInMelee(s, e) : liveHeroes(s);
      else {
        const intended = s.heroes.find((h) => h.uid === it.target);
        const valid = (h: Hero | undefined) =>
          !!h && !h.down && (mv.range === 'ranged' || Math.abs(h.pos - e.pos) <= 1);
        const taunter = mv.range === 'melee' ? heroesInMelee(s, e).find((h) => h.st.taunt) : undefined;
        const t = taunter ?? (valid(intended) ? intended : chooseHeroTarget(s, e, it.move));
        targets = t ? [t] : [];
      }
      if (!targets.length) log('никого не достаёт');
      for (const t of targets) damage(e, t, mv.dmg! + str, { melee: mv.range === 'melee' });
    } else if (mv.range === 'self') {
      if (mv.str) addStatus(e, 'str', mv.str);
      if (mv.heal) {
        const before = e.hp;
        e.hp = Math.min(e.maxHp, e.hp + mv.heal);
        log(`${e.name}: +${e.hp - before} HP (${e.hp})`);
      }
      if (mv.block) {
        e.block += mv.block;
        log(`${e.name}: +${mv.block} блока`);
      }
    } else if (mv.range === 'ally') {
      const t = s.enemies.find((x) => x.uid === it.target);
      if (!t || t.hp <= 0) log('цель погибла, лечение сгорает');
      else {
        const before = t.hp;
        t.hp = Math.min(t.maxHp, t.hp + mv.heal!);
        log(`${t.name}: +${t.hp - before} HP (${before}→${t.hp})`);
      }
    }
    flush();
    e.step++;
  };

  // 1. Перемещения — в самом начале раунда
  for (const h of s.heroes) {
    for (const p of [...h.plan]) {
      if (h.down) break;
      if (p.t === 'move') heroStep(h, p.dir);
      else if (planCardDef(h, p)?.speed === 'move') playCard(h, p);
    }
  }

  // 2. Шкала скорости: в каждой ступени сначала герои (по местам), потом враги
  for (const b of [0, 1, 2, 3] as Speed[]) {
    for (const h of s.heroes) {
      for (const p of [...h.plan]) {
        if (h.down) break;
        if (p.t === 'card' && planCardDef(h, p)?.speed === b) playCard(h, p);
      }
    }
    for (const e of s.enemies) {
      if (e.hp > 0 && !e.acted && enemySpeed(e) === b) enemyAct(e);
    }
  }

  // 3. Конец раунда
  for (const e of liveEnemies(s)) {
    if (e.st.burn) {
      damage(null, e, e.st.burn, { pierce: true, note: '🔥' });
      e.st.burn--;
    }
  }
  for (const u of [...s.heroes, ...s.enemies]) {
    u.block = 0;
    for (const k of ['mark', 'taunt', 'thorns'] as StatusId[]) delete u.st[k];
    for (const k of ['chill', 'vuln', 'away', 'burn'] as StatusId[]) {
      if (k !== 'burn' && u.st[k]) u.st[k]!--;
      if (!u.st[k]) delete u.st[k];
    }
  }
  for (const h of s.heroes) {
    h.discard.push(...h.hand);
    h.hand = [];
    h.plan = [];
  }

  if (!liveEnemies(s).length) {
    const last = s.battle >= ENCOUNTERS.length - 1;
    s.phase = last ? 'won' : 'reward';
    log(last ? '🏆 Вожак повержен! Победа!' : '⚔️ Победа в бою!');
    for (const h of s.heroes) {
      if (h.down) {
        h.down = false;
        h.hp = Math.ceil(h.maxHp / 4);
      }
      s.offers[h.id] = shuffle(s, HEROES[h.id].rewards).slice(0, 3);
    }
  } else if (!liveHeroes(s).length) {
    s.phase = 'lost';
    log('💀 Отряд пал');
  } else {
    startRound(s);
  }
  return { state: s, steps };
}

// ───────── награды ─────────

export function pickReward(s: GameState, heroId: HeroId, cardId: string | null): void {
  if (s.phase !== 'reward') return;
  const h = hero(s, heroId);
  const offer = s.offers[heroId];
  if (!offer) return;
  if (cardId && offer.includes(cardId)) h.owned.push({ uid: uid(s), id: cardId });
  s.offers[heroId] = null;
  if (HERO_ORDER.every((id) => s.offers[id] === null)) {
    const next = s.battle + 1;
    if (ENCOUNTERS[next]?.boss) {
      for (const x of s.heroes) x.hp = Math.min(x.maxHp, x.hp + Math.ceil(x.maxHp * 0.3));
    }
    startBattle(s, next);
    if (ENCOUNTERS[next]?.boss) s.log = ['🔥 Привал перед логовом: все восстановили 30% HP'];
  }
}
