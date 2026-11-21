import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { CARDS, ENCOUNTERS, HEROES, HERO_ORDER, POS_NAME, SPEED_ICON, SPEED_NAME, STATUS_ICON, STATUS_NAME } from '../engine/content';
import { card, energyLeft, foresight, hero, intentInfo, plannedPos, unitByUid, validTargets } from '../engine/engine';
import type { CardDef, Enemy, GameState, Hero, HeroId, PlanItem, Step, Unit } from '../engine/types';
import type { GameOp } from '../net/protocol';

export interface Playback {
  steps: Step[];
  i: number;
}

export interface GameViewProps {
  game: GameState;
  play: Playback | null;
  onSkip: () => void;
  /** Whether this screen may act for the hero. */
  canControl: (id: HeroId) => boolean;
  /** Applies or sends a command; an error text if refused at once. */
  send: (op: GameOp) => string | null;
  /** An error from elsewhere (the host). */
  err?: string;
  /** Who plays the hero, shown above its panel. */
  seatNote?: (id: HeroId) => ComponentChildren;
  onNewGame: () => void;
  /** Hot-seat: after «Готов» switch to the next hero. */
  autoNext?: boolean;
}

export function GameView(p: GameViewProps) {
  const { game, play } = p;
  const [active, setActive] = useState<HeroId>(() => HERO_ORDER.find(p.canControl) ?? 'guard');
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [showLog, setShowLog] = useState(false);

  useEffect(() => setErr(p.err ?? ''), [p.err]);
  // Новый раунд или розыгрыш — сброс выбора
  useEffect(() => setSel(null), [game.round, game.battle, game.phase, !!play]);
  // После розыгрыша — к своему герою
  useEffect(() => {
    if (!play && p.autoNext) setActive(firstNotReady(game) ?? 'guard');
  }, [!!play]);

  const view = play ? play.steps[play.i]!.state : game;
  const mine = p.canControl(active);
  const h = hero(view, active);
  const selDef = sel ? CARDS[h.hand.find((c) => c.uid === sel)?.id ?? ''] : undefined;
  const targets = selDef && !play ? validTargets(game, hero(game, active), selDef) : [];

  function send(op: GameOp): boolean {
    const e = p.send(op);
    setErr(e ?? '');
    return !e;
  }

  function chooseCard(uid: string) {
    if (play || game.phase !== 'plan' || !mine) return;
    if (sel === uid) return setSel(null);
    const def = card(hero(game, active).hand.find((c) => c.uid === uid)!.id);
    if (def.target === 'none') {
      send({ op: 'card', seat: active, uid });
      setSel(null);
    } else {
      setErr('');
      setSel(uid);
    }
  }

  function clickUnit(u: Unit) {
    if (!sel || !targets.includes(u.uid)) return;
    send({ op: 'card', seat: active, uid: sel, target: u.uid });
    setSel(null);
  }

  function toggleReady() {
    const ready = !hero(game, active).ready;
    setSel(null);
    if (send({ op: 'ready', seat: active, ready }) && ready && p.autoNext) {
      const next = HERO_ORDER.find((id) => id !== active && !hero(game, id).ready && !hero(game, id).down);
      if (next) setActive(next);
    }
  }

  const enc = ENCOUNTERS[view.battle]!;

  return (
    <>
      <div class="gamebar">
        бой {view.battle + 1}/{ENCOUNTERS.length}: <b>{enc.name}</b>
        {view.phase === 'plan' && <> · раунд {view.round}</>}
      </div>

      <Field
        s={view}
        targets={targets}
        onUnit={clickUnit}
        foresee={active === 'mystic' && mine && !play && view.phase === 'plan'}
        activeId={active}
      />

      {play && (
        <div class="playbar">
          <div class="caption">{play.steps[play.i]!.text}</div>
          <button onClick={p.onSkip}>Пропустить ⏭</button>
        </div>
      )}

      {!play && game.log.length > 0 && (
        <div class="lastlog">
          <button class="link" onClick={() => setShowLog(!showLog)}>
            {showLog ? '▾' : '▸'} Что было в прошлом раунде ({game.log.length})
          </button>
          {showLog && (
            <ol>
              {game.log.map((l) => (
                <li>{l}</li>
              ))}
            </ol>
          )}
        </div>
      )}

      {!play && game.phase === 'plan' && (
        <>
          <Tabs s={game} active={active} canControl={p.canControl} onPick={(id) => { setActive(id); setSel(null); setErr(''); }} />
          <HeroPanel
            s={game}
            h={hero(game, active)}
            mine={mine}
            note={p.seatNote?.(active)}
            sel={sel}
            selDef={selDef}
            err={err}
            onCard={chooseCard}
            onCancel={() => setSel(null)}
            onMove={(d) => send({ op: 'move', seat: active, dir: d })}
            onUnplan={(i) => send({ op: 'unplan', seat: active, index: i })}
            onReady={toggleReady}
          />
        </>
      )}

      {!play && game.phase === 'reward' && (
        <Rewards s={game} canControl={p.canControl} seatNote={p.seatNote} err={err} onPick={(id, c) => send({ op: 'reward', seat: id, card: c })} />
      )}

      {!play && (game.phase === 'won' || game.phase === 'lost') && (
        <div class="end">
          <h2>{game.phase === 'won' ? '🏆 Отряд победил!' : '💀 Отряд пал'}</h2>
          <p>Дошли до боя {game.battle + 1}: {enc.name}</p>
          <button class="primary" onClick={p.onNewGame}>Новая игра</button>
        </div>
      )}
    </>
  );
}

function firstNotReady(s: GameState): HeroId | undefined {
  return HERO_ORDER.find((id) => !hero(s, id).ready);
}

// ───────── поле ─────────

function Field(p: { s: GameState; targets: string[]; onUnit: (u: Unit) => void; foresee: boolean; activeId: HeroId }) {
  const { s } = p;
  return (
    <div class="field">
      {([3, 2, 1, 0] as const).map((pos) => {
        const units: Unit[] = [
          ...s.enemies.filter((e) => e.pos === pos && e.hp > 0),
          ...s.heroes.filter((h) => h.pos === pos),
        ];
        return (
          <div class={`band band-${pos}`}>
            <div class="band-label">{POS_NAME[pos]}</div>
            <div class="band-units">
              {units.map((u) => (
                <UnitView
                  u={u}
                  s={s}
                  target={p.targets.includes(u.uid)}
                  onClick={() => p.onUnit(u)}
                  foresee={p.foresee}
                  active={u.uid === p.activeId}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Statuses({ u }: { u: Unit }) {
  const list = Object.entries(u.st).filter(([k, v]) => v && k !== 'hold');
  if (!list.length && !u.block) return null;
  return (
    <div class="st">
      {u.block > 0 && <span title="Блок">🛡{u.block}</span>}
      {list.map(([k, v]) => (
        <span title={STATUS_NAME[k]}>
          {STATUS_ICON[k]}
          {k === 'mark' || k === 'taunt' || k === 'stun' ? '' : v}
        </span>
      ))}
    </div>
  );
}

function HpBar({ u }: { u: Unit }) {
  const pct = Math.max(0, (u.hp / u.maxHp) * 100);
  return (
    <div class="hp">
      <div class={`hp-fill ${pct < 34 ? 'low' : ''}`} style={{ width: `${pct}%` }} />
      <span>
        {u.hp}/{u.maxHp}
      </span>
    </div>
  );
}

function UnitView(p: { u: Unit; s: GameState; target: boolean; onClick: () => void; foresee: boolean; active: boolean }) {
  const { u, s } = p;
  const cls = ['unit', u.side, p.target ? 'target' : '', p.active ? 'active' : '', u.side === 'hero' && u.down ? 'down' : ''];
  return (
    <div class={cls.join(' ')} onClick={p.onClick}>
      <div class="u-name">
        {u.icon} {u.name}
        {u.side === 'hero' && u.ready && s.phase === 'plan' && !u.down && <span class="ok"> ✓</span>}
      </div>
      <HpBar u={u} />
      <Statuses u={u} />
      {u.side === 'enemy' ? <EnemyIntent e={u} s={s} foresee={p.foresee} /> : <HeroDraft h={u} s={s} />}
    </div>
  );
}

function EnemyIntent({ e, s, foresee }: { e: Enemy; s: GameState; foresee: boolean }) {
  const info = intentInfo(s, e);
  if (!info) return null;
  return (
    <>
      <div class={`intent ${info.stunned ? 'stunned' : ''}`} title={SPEED_NAME[info.speed]}>
        <span class="spd">{SPEED_ICON[info.speed]}</span> {info.stunned && '💫 '}
        {info.text}
      </div>
      {foresee && <div class="foresight">👁 далее: {foresight(e)}</div>}
    </>
  );
}

function planLabel(s: GameState, h: Hero, p: PlanItem): string {
  if (p.t === 'move') return p.dir > 0 ? '▲ вперёд' : '▼ назад';
  const inst = [...h.hand, ...h.discard].find((c) => c.uid === p.uid);
  const d = inst ? CARDS[inst.id] : undefined;
  if (!d) return '?';
  const t = unitByUid(s, p.target);
  return `${d.speed === 'move' ? '↕' : SPEED_ICON[d.speed]} ${d.name}${t ? ` → ${t.name}` : ''}`;
}

function HeroDraft({ h, s }: { h: Hero; s: GameState }) {
  if (h.down) return <div class="intent">без сознания</div>;
  if (s.phase !== 'plan' || !h.plan.length) return null;
  return (
    <div class="draft">
      {h.plan.map((p) => (
        <div>{planLabel(s, h, p)}</div>
      ))}
    </div>
  );
}

// ───────── панель героя ─────────

function Tabs(p: { s: GameState; active: HeroId; canControl: (id: HeroId) => boolean; onPick: (id: HeroId) => void }) {
  return (
    <div class="tabs">
      {p.s.heroes.map((h) => (
        <button class={`tab ${h.id === p.active ? 'on' : ''} ${p.canControl(h.id) ? 'mine' : ''}`} onClick={() => p.onPick(h.id)}>
          {h.icon} {h.name} {h.down ? '💤' : h.ready ? '✓' : ''}
        </button>
      ))}
    </div>
  );
}

function CardView(p: { def: CardDef; on?: boolean; dim?: boolean; order?: number; onClick?: () => void; hint?: string }) {
  const { def } = p;
  return (
    <div class={`card k-${def.kind} ${p.on ? 'on' : ''} ${p.dim ? 'dim' : ''}`} onClick={p.onClick}>
      <div class="c-top">
        <span class="cost">{def.cost}</span>
        <span class="c-name">{def.name}</span>
        <span class="spd" title={def.speed === 'move' ? 'в начале раунда' : SPEED_NAME[def.speed]}>
          {def.speed === 'move' ? '↕' : SPEED_ICON[def.speed]}
        </span>
      </div>
      <div class="c-kind">{def.kind === 'melee' ? '⚔ ближняя' : def.kind === 'spell' ? '✦ магия' : 'умение'}</div>
      <div class="c-text">{def.text}</div>
      {p.hint && <div class="c-hint">{p.hint}</div>}
      {p.order !== undefined && <div class="c-order">в плане #{p.order + 1}</div>}
    </div>
  );
}

function HeroPanel(p: {
  s: GameState; h: Hero; mine: boolean; note?: ComponentChildren; sel: string | null; selDef?: CardDef; err: string;
  onCard: (uid: string) => void; onCancel: () => void; onMove: (d: 1 | -1) => void; onUnplan: (i: number) => void; onReady: () => void;
}) {
  const { s, h } = p;
  const def = HEROES[h.id];
  if (h.down) return <div class="panel">{p.note}<p>{h.icon} {h.name} без сознания. Поднимется после боя.</p></div>;
  const locked = h.ready || !p.mine;
  const left = energyLeft(h);
  const ppos = plannedPos(s, h);
  const nextDouble = h.id === 'blade' && (h.attacks + 1) % 3 === 0;
  return (
    <div class="panel">
      {p.note}
      <div class="p-head">
        <span class="energy">{'⚡'.repeat(left)}<span class="spent">{'⚡'.repeat(Math.max(0, h.energy - left))}</span> {left}/{h.energy}</span>
        <span class="muted">позиция: {POS_NAME[ppos as 0]}{ppos !== h.pos && ' (после шага)'}</span>
      </div>
      <div class="passive">
        {def.passive}
        {h.id === 'blade' && <> · атак за бой: {h.attacks}{nextDouble && <b> — следующая ×2!</b>}</>}
      </div>

      {p.sel && p.selDef && (
        <div class="hint-bar">
          Выберите цель для «{p.selDef.name}» на поле <button onClick={p.onCancel}>Отмена</button>
        </div>
      )}
      {p.err && <div class="err">{p.err}</div>}

      <div class="hand">
        {h.hand.map((c) => {
          const d = CARDS[c.id]!;
          const order = h.plan.findIndex((x) => x.t === 'card' && x.uid === c.uid);
          return (
            <CardView
              def={d}
              on={p.sel === c.uid}
              order={order >= 0 ? order : undefined}
              dim={order >= 0 || (d.cost > left && order < 0) || locked}
              onClick={order >= 0 || locked ? undefined : () => p.onCard(c.uid)}
            />
          );
        })}
      </div>

      <div class="moves">
        <button disabled={locked} onClick={() => p.onMove(1)}>▲ Вперёд (1⚡)</button>
        <button disabled={locked} onClick={() => p.onMove(-1)}>▼ Назад (1⚡)</button>
        <span class="muted">шаги — в самом начале раунда</span>
      </div>

      <div class="plan">
        <div class="muted">План{h.plan.length ? '' : ': пусто'}</div>
        {h.plan.map((x, i) => (
          <span class="chip">
            {planLabel(s, h, x)}
            {!locked && <button onClick={() => p.onUnplan(i)}>✕</button>}
          </span>
        ))}
      </div>

      {p.mine ? (
        <button class={`primary ready ${h.ready ? 'is-ready' : ''}`} onClick={p.onReady}>
          {h.ready ? '✓ Готов (нажмите, чтобы изменить)' : 'Готов'}
        </button>
      ) : (
        <div class="muted ready-other">{h.ready ? '✓ Готов' : 'Планирует…'}</div>
      )}
      <div class="muted small">
        Колода: {h.draw.length} · сброс: {h.discard.length} · всего карт: {h.owned.length}
      </div>
    </div>
  );
}

// ───────── награды ─────────

function Rewards(p: {
  s: GameState; canControl: (id: HeroId) => boolean; seatNote?: (id: HeroId) => ComponentChildren; err: string;
  onPick: (id: HeroId, c: string | null) => void;
}) {
  return (
    <div class="panel">
      <h3>Награда: каждый герой берёт одну карту в колоду (или пропускает)</h3>
      {p.err && <div class="err">{p.err}</div>}
      {p.s.heroes.map((h) => {
        const offer = p.s.offers[h.id];
        return (
          <div class="reward">
            <div>
              {h.icon} <b>{h.name}</b> {offer === null && '✓ выбрано'} <span class="muted">({h.owned.length} карт, HP {h.hp}/{h.maxHp})</span>
            </div>
            {offer && p.seatNote?.(h.id)}
            {offer && !p.canControl(h.id) && <div class="muted small">выбирает…</div>}
            {offer && p.canControl(h.id) && (
              <div class="hand">
                {offer.map((id) => (
                  <CardView def={CARDS[id]!} onClick={() => p.onPick(h.id, id)} />
                ))}
                <button class="skip" onClick={() => p.onPick(h.id, null)}>Пропустить</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

