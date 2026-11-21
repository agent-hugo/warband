import { CARDS, ENCOUNTERS, ENEMIES, HEROES, HERO_ORDER, MOVES, POS_NAME, SPEED_ICON, SPEED_NAME, STATUS_ICON, STATUS_NAME } from '../engine/content';
import { ENERGY, HAND_SIZE } from '../engine/engine';
import type { CardDef, MoveDef } from '../engine/types';

const REPO = 'https://github.com/agent-hugo/warband';

function speedLabel(sp: CardDef['speed']): string {
  return sp === 'move' ? '↕ в начале раунда' : `${SPEED_ICON[sp]} ${SPEED_NAME[sp]}`;
}

function kindLabel(c: CardDef): string {
  return c.kind === 'melee' ? '⚔ ближняя' : c.kind === 'spell' ? '✦ магия' : 'умение';
}

function CardLine({ c, count }: { c: CardDef; count?: number }) {
  return (
    <li>
      <b>{c.name}</b>{count && count > 1 ? ` ×${count}` : ''} — {c.cost}⚡, {speedLabel(c.speed)}, {kindLabel(c)}. {c.text}
    </li>
  );
}

function moveText(id: string, m: MoveDef): string {
  if (id === 'leap') return `${m.dmg} урона ближнему герою и 💨 на 2 раунда (один раз за бой)`;
  if (m.range === 'ally') return `лечит самого раненого из своих на ${m.heal}`;
  if (m.range === 'self') {
    const parts: string[] = [];
    if (m.str) parts.push(`+${m.str} 💪 к урону до конца боя`);
    if (m.heal) parts.push(`+${m.heal} HP`);
    if (m.block) parts.push(`${m.block} блока`);
    return parts.join(', ');
  }
  const who =
    m.range === 'melee'
      ? m.all ? 'всем героям рядом' : 'ближнему герою (с наименьшим HP; 📣 перетягивает)'
      : m.all ? 'всем героям' : m.preferRear ? 'герою в тылу (если есть, иначе любому)' : 'любому герою с наименьшим HP';
  return `${m.dmg} урона ${who}`;
}

function Rules() {
  return (
    <>
      <p><b>Раунд.</b> Каждый герой тайно (своей вкладкой) планирует карты на {ENERGY}⚡. Когда все нажали «Готов» — розыгрыш.</p>
      <p><b>Скорость.</b> Сначала шаги и карты «↕ в начале раунда», потом ⚡ быстро → ● обычно → 🐢 медленно. В каждой ступени сначала герои (Страж, Клинок, Мистик), потом враги. ❄ замедляет врага на ступень.</p>
      <p><b>Ряды.</b> Слева направо: {POS_NAME.join(' · ')}. ⚔ ближняя атака достаёт только соседнюю полосу, ✦ магия — любого. Шаг вперёд или назад стоит 1⚡. Пройти «в гущу» (на фронт врага) можно, только когда он пуст.</p>
      <p><b>Враги</b> показывают намерение заранее. Ближние враги, которым некого бить, наступают. Лучник отскакивает 💨, если к нему подошли.</p>
      <p><b>Карты.</b> У каждого героя своя колода. В начале боя она тасуется, и каждый раунд берётся {HAND_SIZE} карт. Что не сыграно — не копится: в конце раунда вся рука (сыгранное и нет) уходит в сброс. Когда колода кончилась, сброс перетасовывается в новую колоду. Блок, 🎯, 📣 и 🌵 сгорают в конце раунда.</p>
      <p><b>Награда.</b> После победы каждому герою предлагают 3 карты из его набора наград. Взятая карта навсегда добавляется в колоду героя до конца похода; убрать из колоды ничего нельзя. «Пропустить» — колода остаётся прежней: полезно, если не хочется разбавлять её картой, которая не подходит. Следующий бой начинается, когда выбрали все.</p>
      <p><b>Здоровье</b> между боями не восстанавливается. Герой без сознания поднимается после победы с ¼ HP. Перед логовом вожака привал: все восстанавливают 30% HP.</p>
      <p><b>Цель погибла:</b> атака уходит на случайного доступного врага, остальные карты на неё сгорают.</p>
      <p><b>Состояния:</b></p>
      <ul>
        {Object.entries(STATUS_NAME).filter(([k]) => k !== 'hold').map(([k, v]) => <li>{STATUS_ICON[k]} {v}</li>)}
      </ul>
    </>
  );
}

function Heroes() {
  return (
    <>
      {HERO_ORDER.map((id) => {
        const h = HEROES[id];
        const counts = new Map<string, number>();
        h.deck.forEach((c) => counts.set(c, (counts.get(c) ?? 0) + 1));
        return (
          <details class="help-sub">
            <summary>{h.icon} {h.name} — {h.hp} HP, {POS_NAME[h.pos].toLowerCase()}</summary>
            <p><b>Особенность:</b> {h.passive}.</p>
            <p><b>Стартовая колода ({h.deck.length}):</b></p>
            <ul>{[...counts].map(([c, n]) => <CardLine c={CARDS[c]!} count={n} />)}</ul>
            <p><b>Возможные награды:</b></p>
            <ul>{h.rewards.map((c) => <CardLine c={CARDS[c]!} />)}</ul>
          </details>
        );
      })}
    </>
  );
}

function Enemies() {
  return (
    <>
      <p class="muted">Враги ходят по кругу своих действий; первое в бою — случайное. Скорость: {SPEED_ICON.slice(0, 3).map((x, i) => `${x} ${SPEED_NAME[i]}`).join(', ')}.</p>
      {Object.entries(ENEMIES).map(([k, e]) => (
        <details class="help-sub">
          <summary>{e.icon} {e.name} — {e.hp} HP, {POS_NAME[e.pos].toLowerCase()}</summary>
          <ul>
            {e.pattern.map((m) => {
              const mv = MOVES[m]!;
              return <li><b>{mv.name}</b> {SPEED_ICON[mv.speed]} — {moveText(m, mv)}</li>;
            })}
            {e.leaps && <li><b>Отскок</b> {SPEED_ICON[MOVES.leap!.speed]} — вместо обычного хода, если к нему подошёл герой: {moveText('leap', MOVES.leap!)}</li>}
            {e.pattern.some((m) => MOVES[m]!.range === 'melee') && <li><b>Наступает</b> — вместо ближнего удара, если рядом нет героев.</li>}
          </ul>
          <p class="muted">Встречается: {ENCOUNTERS.filter((x) => x.enemies.includes(k)).map((x) => x.name).join(', ')}</p>
        </details>
      ))}
    </>
  );
}

export function Help() {
  return (
    <div class="help">
      <details open>
        <summary>Правила</summary>
        <Rules />
      </details>
      <details>
        <summary>Герои и их карты</summary>
        <Heroes />
      </details>
      <details>
        <summary>Враги</summary>
        <Enemies />
      </details>
      <p class="muted small">
        Исходники: <a href={REPO} target="_blank" rel="noopener">{REPO.replace('https://', '')}</a>
      </p>
    </div>
  );
}
