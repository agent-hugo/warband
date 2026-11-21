import type { CardDef, Encounter, EnemyKind, HeroDef, HeroId, MoveDef } from './types';

const cards: CardDef[] = [
  // ── Страж ──
  { id: 'g_strike', hero: 'guard', name: 'Удар', cost: 1, speed: 1, kind: 'melee', target: 'enemy', attack: true,
    text: '6 урона', play: (c) => void c.strike(c.enemy, 6) },
  { id: 'g_defend', hero: 'guard', name: 'Защита', cost: 1, speed: 1, kind: 'skill', target: 'none',
    text: '6 блока себе', play: (c) => c.block(c.hero, 6) },
  { id: 'g_parry', hero: 'guard', name: 'Парирование', cost: 1, speed: 0, kind: 'skill', target: 'none',
    text: '4 блока себе', play: (c) => c.block(c.hero, 4) },
  { id: 'g_cover', hero: 'guard', name: 'Щит для друга', cost: 1, speed: 1, kind: 'skill', target: 'other',
    text: '8 блока союзнику', play: (c) => c.block(c.ally, 8) },
  { id: 'g_taunt', hero: 'guard', name: 'Вызов', cost: 1, speed: 0, kind: 'skill', target: 'none',
    text: 'Ближние враги бьют Стража. 3 блока', play: (c) => { c.status(c.hero, 'taunt', 1); c.block(c.hero, 3); } },
  { id: 'g_bash', hero: 'guard', name: 'Удар щитом', cost: 2, speed: 2, kind: 'melee', target: 'enemy', attack: true,
    text: 'Урон = текущий блок', play: (c) => void c.strike(c.enemy, c.hero.block) },
  // награды
  { id: 'g_spikes', hero: 'guard', name: 'Шипастый щит', cost: 1, speed: 1, kind: 'skill', target: 'none',
    text: '5 блока, 3 урона каждому ближнему атакующему', play: (c) => { c.block(c.hero, 5); c.status(c.hero, 'thorns', 3); } },
  { id: 'g_wall', hero: 'guard', name: 'Стена', cost: 2, speed: 1, kind: 'skill', target: 'none',
    text: '5 блока всем героям', play: (c) => c.liveHeroes().forEach((h) => c.block(h, 5)) },
  { id: 'g_cry', hero: 'guard', name: 'Боевой клич', cost: 1, speed: 0, kind: 'skill', target: 'none',
    text: 'Все герои: +2 к атакам в этом раунде', play: (c) => { c.liveHeroes().forEach((h) => (h.rally += 2)); c.log('Все атаки +2 в этом раунде'); } },
  { id: 'g_charge', hero: 'guard', name: 'За мной!', cost: 1, speed: 'move', kind: 'skill', target: 'other', moves: 1,
    text: 'В начале раунда: Страж и союзник шагают вперёд', play: (c) => { c.move(c.hero, 1); c.move(c.ally, 1); } },
  { id: 'g_crush', hero: 'guard', name: 'Сокрушение', cost: 2, speed: 2, kind: 'melee', target: 'enemy', attack: true,
    text: '14 урона', play: (c) => void c.strike(c.enemy, 14) },

  // ── Клинок ──
  { id: 'b_strike', hero: 'blade', name: 'Удар', cost: 1, speed: 1, kind: 'melee', target: 'enemy', attack: true,
    text: '6 урона', play: (c) => void c.strike(c.enemy, 6) },
  { id: 'b_defend', hero: 'blade', name: 'Защита', cost: 1, speed: 1, kind: 'skill', target: 'none',
    text: '5 блока себе', play: (c) => c.block(c.hero, 5) },
  { id: 'b_trip', hero: 'blade', name: 'Подсечка', cost: 1, speed: 0, kind: 'melee', target: 'enemy', attack: true,
    text: '4 урона. По 🎯 — оглушает 💫', play: (c) => {
      const t = c.enemy;
      const marked = !!t.st.mark;
      c.strike(t, 4);
      if (marked && t.hp > 0) c.status(t, 'stun', 1);
    } },
  { id: 'b_exec', hero: 'blade', name: 'Казнь', cost: 2, speed: 2, kind: 'melee', target: 'enemy', attack: true,
    text: '12 урона. По 🎯 ×2', play: (c) => void c.strike(c.enemy, 12, { markMult: 2 }) },
  { id: 'b_whirl', hero: 'blade', name: 'Вихрь', cost: 1, speed: 1, kind: 'melee', target: 'none',
    text: '3 урона всем доступным врагам', play: (c) => c.strikeMany(c.reachableEnemies(), 3) },
  { id: 'b_dash', hero: 'blade', name: 'Рывок', cost: 0, speed: 'move', kind: 'skill', target: 'none', moves: 1,
    text: 'В начале раунда: шаг вперёд, следующая атака +3', play: (c) => { if (c.move(c.hero, 1)) c.hero.nextBonus += 3; } },
  // награды
  { id: 'b_double', hero: 'blade', name: 'Двойной выпад', cost: 1, speed: 1, kind: 'melee', target: 'enemy', attack: true,
    text: '2 удара по 4 (две атаки)', play: (c) => { const t = c.enemy; c.strike(t, 4); if (t.hp > 0) c.strike(t, 4); } },
  { id: 'b_bleed', hero: 'blade', name: 'Кровопускание', cost: 1, speed: 1, kind: 'melee', target: 'enemy', attack: true,
    text: '3 урона и 🩸 на 2 раунда', play: (c) => { const t = c.enemy; c.strike(t, 3); c.status(t, 'vuln', 2); } },
  { id: 'b_finish', hero: 'blade', name: 'Добивание', cost: 1, speed: 1, kind: 'melee', target: 'enemy', attack: true,
    text: '5 урона, +8 если у цели ≤ половины HP', play: (c) => { const t = c.enemy; c.strike(t, t.hp * 2 <= t.maxHp ? 13 : 5); } },
  { id: 'b_quick', hero: 'blade', name: 'Быстрый клинок', cost: 1, speed: 0, kind: 'melee', target: 'enemy', attack: true,
    text: '5 урона', play: (c) => void c.strike(c.enemy, 5) },
  { id: 'b_feint', hero: 'blade', name: 'Финт', cost: 1, speed: 0, kind: 'skill', target: 'none',
    text: '4 блока, следующая атака +4', play: (c) => { c.block(c.hero, 4); c.hero.nextBonus += 4; } },

  // ── Мистик ──
  { id: 'm_spark', hero: 'mystic', name: 'Искра', cost: 1, speed: 1, kind: 'spell', target: 'enemy', attack: true,
    text: '4 урона', play: (c) => void c.strike(c.enemy, 4) },
  { id: 'm_mark', hero: 'mystic', name: 'Метка', cost: 0, speed: 0, kind: 'spell', target: 'enemy',
    text: '🎯 на врага до конца раунда', play: (c) => c.status(c.enemy, 'mark', 1) },
  { id: 'm_frost', hero: 'mystic', name: 'Ледяная хватка', cost: 1, speed: 1, kind: 'spell', target: 'enemy', attack: true,
    text: '5 урона и ❄ на 2 раунда', play: (c) => { const t = c.enemy; c.strike(t, 5); if (t.hp > 0) c.status(t, 'chill', 2); } },
  { id: 'm_delay', hero: 'mystic', name: 'Отсрочка', cost: 2, speed: 1, kind: 'spell', target: 'enemy',
    text: 'Враг пропускает следующее действие и повторит его позже', play: (c) => { c.status(c.enemy, 'stun', 1); c.status(c.enemy, 'hold', 1); } },
  { id: 'm_ward', hero: 'mystic', name: 'Оберег', cost: 1, speed: 1, kind: 'skill', target: 'ally',
    text: '5 блока герою', play: (c) => c.block(c.ally, 5) },
  // награды
  { id: 'm_chain', hero: 'mystic', name: 'Цепная молния', cost: 2, speed: 1, kind: 'spell', target: 'enemy', attack: true,
    text: '6 урона цели, 3 остальным', play: (c) => {
      const t = c.enemy;
      c.strike(t, 6);
      c.strikeMany(c.liveEnemies().filter((e) => e !== t), 3);
    } },
  { id: 'm_frail', hero: 'mystic', name: 'Хрупкость', cost: 1, speed: 0, kind: 'spell', target: 'enemy',
    text: '🩸 на 2 раунда (+2 к каждому удару)', play: (c) => c.status(c.enemy, 'vuln', 2) },
  { id: 'm_fire', hero: 'mystic', name: 'Огненный знак', cost: 1, speed: 1, kind: 'spell', target: 'enemy',
    text: '🔥 5: урон в конце раунда, слабеет на 1', play: (c) => c.status(c.enemy, 'burn', 5) },
  { id: 'm_cold', hero: 'mystic', name: 'Стужа', cost: 2, speed: 0, kind: 'spell', target: 'none',
    text: '❄ всем врагам на 2 раунда', play: (c) => c.liveEnemies().forEach((e) => c.status(e, 'chill', 2)) },
  { id: 'm_bolt', hero: 'mystic', name: 'Разряд', cost: 2, speed: 2, kind: 'spell', target: 'enemy', attack: true,
    text: '13 урона', play: (c) => void c.strike(c.enemy, 13) },
];

export const CARDS: Record<string, CardDef> = Object.fromEntries(cards.map((c) => [c.id, c]));

export const HEROES: Record<HeroId, HeroDef> = {
  guard: {
    id: 'guard', name: 'Страж', icon: '🛡️', hp: 55, pos: 1,
    passive: 'Каждый удар по Стражу слабее на 1',
    deck: ['g_strike', 'g_strike', 'g_strike', 'g_defend', 'g_defend', 'g_defend', 'g_parry', 'g_cover', 'g_taunt', 'g_bash'],
    rewards: ['g_spikes', 'g_wall', 'g_cry', 'g_charge', 'g_crush'],
  },
  blade: {
    id: 'blade', name: 'Клинок', icon: '🗡️', hp: 45, pos: 1,
    passive: 'Каждая 3-я атака за бой — двойной урон',
    deck: ['b_strike', 'b_strike', 'b_strike', 'b_strike', 'b_defend', 'b_defend', 'b_trip', 'b_exec', 'b_whirl', 'b_dash'],
    rewards: ['b_double', 'b_bleed', 'b_finish', 'b_quick', 'b_feint'],
  },
  mystic: {
    id: 'mystic', name: 'Мистик', icon: '🔮', hp: 40, pos: 0,
    passive: 'Видит намерения врагов на раунд вперёд',
    deck: ['m_spark', 'm_spark', 'm_spark', 'm_mark', 'm_mark', 'm_frost', 'm_frost', 'm_delay', 'm_ward', 'm_ward'],
    rewards: ['m_chain', 'm_frail', 'm_fire', 'm_cold', 'm_bolt'],
  },
};

export const HERO_ORDER: HeroId[] = ['guard', 'blade', 'mystic'];

export const MOVES: Record<string, MoveDef> = {
  hit: { name: 'Удар', speed: 1, range: 'melee', dmg: 10 },
  smash: { name: 'Сокрушить', speed: 2, range: 'melee', dmg: 18 },
  rage: { name: 'Ярость', speed: 0, range: 'self', str: 4 },
  slash: { name: 'Рубящий удар', speed: 1, range: 'melee', dmg: 9 },
  stab: { name: 'Укол', speed: 0, range: 'melee', dmg: 5 },
  bite: { name: 'Укус', speed: 0, range: 'melee', dmg: 7 },
  maul: { name: 'Трёпка', speed: 1, range: 'melee', dmg: 10 },
  shot: { name: 'Выстрел', speed: 0, range: 'ranged', dmg: 8, preferRear: true },
  volley: { name: 'Залп', speed: 1, range: 'ranged', dmg: 5, all: true },
  heal: { name: 'Лечение', speed: 1, range: 'ally', heal: 10 },
  hex: { name: 'Порча', speed: 1, range: 'ranged', dmg: 7 },
  sweep: { name: 'Размах', speed: 1, range: 'melee', dmg: 9, all: true },
  slam: { name: 'Сокрушающий удар', speed: 2, range: 'melee', dmg: 22 },
  regen: { name: 'Регенерация', speed: 0, range: 'self', heal: 10, block: 8 },
  // особые: вычисляются из обстановки
  advance: { name: 'Наступает', speed: 1, range: 'self' },
  leap: { name: 'Отскок', speed: 0, range: 'ranged', dmg: 4 },
};

export const ENEMIES: Record<string, EnemyKind> = {
  brute: { name: 'Орк-громила', icon: '🪓', hp: 55, pos: 2, pattern: ['hit', 'smash', 'rage'] },
  cutter: { name: 'Гоблин-рубака', icon: '🔪', hp: 36, pos: 2, pattern: ['slash', 'stab'] },
  archer: { name: 'Гоблин-лучник', icon: '🏹', hp: 24, pos: 3, pattern: ['shot', 'volley'], leaps: true },
  shaman: { name: 'Гоблин-шаман', icon: '🪄', hp: 24, pos: 3, pattern: ['heal', 'hex'] },
  wolf: { name: 'Волк', icon: '🐺', hp: 30, pos: 2, pattern: ['bite', 'maul'] },
  troll: { name: 'Тролль-вожак', icon: '👹', hp: 120, pos: 2, pattern: ['sweep', 'slam', 'regen'] },
};

export const ENCOUNTERS: Encounter[] = [
  { name: 'Засада на тракте', enemies: ['cutter', 'cutter', 'archer'] },
  { name: 'Волчья тропа', enemies: ['wolf', 'wolf', 'wolf'] },
  { name: 'Гоблинский дозор', enemies: ['brute', 'shaman', 'archer'] },
  { name: 'Логово вожака', enemies: ['troll', 'cutter', 'shaman'], boss: true },
];

export const SPEED_ICON = ['⚡', '●', '🐢', '🐢'] as const;
export const SPEED_NAME = ['быстро', 'обычно', 'медленно', 'очень медленно'] as const;
export const STATUS_ICON: Record<string, string> = {
  mark: '🎯', chill: '❄️', stun: '💫', hold: '⏸', vuln: '🩸', burn: '🔥', away: '💨', taunt: '📣', thorns: '🌵', str: '💪',
};
export const STATUS_NAME: Record<string, string> = {
  mark: 'Метка: до конца раунда, бонусы картам «по 🎯»',
  chill: 'Озноб: действует на ступень медленнее (раунды)',
  stun: 'Оглушение: пропустит следующее действие',
  hold: 'Отсрочка: после пропуска повторит то же действие',
  vuln: 'Уязвимость: +2 к каждому удару (раунды)',
  burn: 'Горение: урон в конце раунда',
  away: 'Отрыв: недоступен для ближних атак (раунды)',
  taunt: 'Вызов: ближние враги бьют его',
  thorns: 'Шипы: урон ближним атакующим',
  str: 'Сила: +урон',
};
export const POS_NAME = ['Наш тыл', 'Наш фронт', 'Фронт врага', 'Тыл врага'] as const;
