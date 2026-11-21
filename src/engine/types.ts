/** Скорость: 0 🐇 быстро, 1 ● обычно, 2 🐢 медленно, 3 — замедленное 🐢 (после Озноба). */
export type Speed = 0 | 1 | 2 | 3;

export type HeroId = 'guard' | 'blade' | 'mystic';

/**
 * Позиции на одной линии: 0 — наш тыл, 1 — наш фронт, 2 — фронт врага, 3 — тыл врага.
 * Герой стоит на 0..2 (2 — «в гуще»), враг на 1..3 (1 — прорвался к нам).
 * Ближняя атака достаёт на расстояние не больше 1.
 */
export type Pos = 0 | 1 | 2 | 3;

export type StatusId =
  | 'mark' // 🎯 до конца раунда
  | 'chill' // ❄ −1 ступень скорости, раунды
  | 'stun' // 💫 пропускает следующее действие
  | 'hold' // вместе со stun: намерение не сменится
  | 'vuln' // 🩸 +2 к каждому удару, раунды
  | 'burn' // 🔥 урон в конце раунда, слабеет на 1
  | 'away' // 💨 отрыв: недоступен для ближних атак, раунды
  | 'taunt' // 📣 ближние враги бьют его, до конца раунда
  | 'thorns' // 🌵 отвечает уроном на ближние удары, до конца раунда
  | 'str'; // 💪 +урон, навсегда

export type Statuses = Partial<Record<StatusId, number>>;

export interface CardInst {
  uid: string;
  id: string;
}

export type PlanItem =
  | { t: 'card'; uid: string; target?: string }
  | { t: 'move'; dir: 1 | -1 };

interface UnitBase {
  uid: string;
  name: string;
  icon: string;
  hp: number;
  maxHp: number;
  block: number;
  st: Statuses;
  pos: Pos;
}

export interface Hero extends UnitBase {
  side: 'hero';
  id: HeroId;
  energy: number;
  owned: CardInst[];
  draw: CardInst[];
  hand: CardInst[];
  discard: CardInst[];
  /** Атак за бой (для пассивки Клинка). */
  attacks: number;
  down: boolean;
  plan: PlanItem[];
  ready: boolean;
  /** Бонус к следующей атаке в этом раунде. */
  nextBonus: number;
  /** Бонус ко всем атакам в этом раунде. */
  rally: number;
}

export interface Enemy extends UnitBase {
  side: 'enemy';
  kind: string;
  /** Индекс в шаблоне действий. */
  step: number;
  intent: Intent | null;
  acted: boolean;
  leapUsed: boolean;
}

export type Unit = Hero | Enemy;

export interface Intent {
  move: string;
  target?: string;
}

export type Phase = 'plan' | 'reward' | 'won' | 'lost';

export interface GameState {
  rng: number;
  phase: Phase;
  battle: number;
  round: number;
  heroes: Hero[];
  enemies: Enemy[];
  /** Предложенные награды: id карт; null — уже выбрано. */
  offers: Partial<Record<HeroId, string[] | null>>;
  uidSeq: number;
  /** Записи последнего розыгрыша. */
  log: string[];
}

export interface Step {
  text: string;
  state: GameState;
}

export interface PlayCtx {
  s: GameState;
  hero: Hero;
  target: Unit | null;
  /** Цель как враг / как герой (по типу цели карты). */
  enemy: Enemy;
  ally: Hero;
  /** Одна атака: учитывает пассивки, бонусы, Метку (markMult). Возвращает нанесённый урон. */
  strike(target: Enemy, base: number, o?: { markMult?: number }): number;
  /** Одна атака сразу по нескольким целям. */
  strikeMany(targets: Enemy[], base: number): void;
  block(u: Hero, n: number): void;
  status(u: Unit, st: StatusId, n: number): void;
  move(h: Hero, dir: 1 | -1): boolean;
  reachableEnemies(): Enemy[];
  liveEnemies(): Enemy[];
  liveHeroes(): Hero[];
  log(text: string): void;
}

export type CardKind = 'melee' | 'spell' | 'skill';
export type CardTarget = 'enemy' | 'ally' | 'other' | 'none';

export interface CardDef {
  id: string;
  hero: HeroId;
  name: string;
  cost: number;
  /** 'move' — срабатывает в начале раунда вместе с перемещениями. */
  speed: Speed | 'move';
  kind: CardKind;
  target: CardTarget;
  /** Атака: если цель погибла, переходит на случайного доступного врага. */
  attack?: boolean;
  /** Перемещение героя при планировании (для проверки досягаемости). */
  moves?: 1 | -1;
  text: string;
  play(c: PlayCtx): void;
}

export interface MoveDef {
  name: string;
  speed: Speed;
  range: 'melee' | 'ranged' | 'self' | 'ally';
  dmg?: number;
  all?: boolean;
  heal?: number;
  block?: number;
  str?: number;
  preferRear?: boolean;
}

export interface EnemyKind {
  name: string;
  icon: string;
  hp: number;
  pos: Pos;
  pattern: string[];
  leaps?: boolean;
}

export interface Encounter {
  name: string;
  enemies: string[];
  boss?: boolean;
}

export interface HeroDef {
  id: HeroId;
  name: string;
  icon: string;
  hp: number;
  pos: Pos;
  passive: string;
  deck: string[];
  rewards: string[];
}
