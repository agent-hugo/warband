import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Pose } from '../game/predict';
import { foggy, speedOf, type TagState } from '../game/tag';
import { TICK_HZ } from '../game/world';
import { Host, type PlayerRow } from '../net/host';
import { COLORS, normalizeRoom, randomRoomCode, type PresenceMsg } from '../net/protocol';
import { routeLabel } from '../net/rtc';
import { browserName, diagText, type DiagReport } from '../net/diag';
import { askMic, reveal } from '../net/mic';
import { Session, type SessionInfo } from '../net/session';
import { decodeInvite, inviteHash } from './invite';
import { Joystick } from './joystick';
import { Renderer, type Who } from './render';
import { settings } from './storage';

const REPO = 'https://github.com/agent-hugo/warband';

type Route = { page: 'home'; code?: string } | { page: 'play'; code: string } | { page: 'host'; code: string };

/** Reads the hash; an invite (`i=` with room and token) saves the token and becomes a plain `r=`. */
function parseRoute(): Route {
  const h = new URLSearchParams(location.hash.slice(1));
  const inv = decodeInvite(h.get('i'));
  if (inv.token) settings.token = inv.token;
  if (h.has('i')) {
    if (inv.room) h.set('r', inv.room);
    h.delete('i');
    history.replaceState(null, '', `${location.pathname}${location.search}#${h.toString()}`);
  }
  const host = normalizeRoom(h.get('host') ?? '');
  if (host) return { page: 'host', code: host };
  const r = normalizeRoom(h.get('r') ?? '');
  if (r) return settings.name && settings.token ? { page: 'play', code: r } : { page: 'home', code: r };
  return { page: 'home' };
}

function inviteUrl(code: string): string {
  return `${location.origin}${location.pathname}#${inviteHash(code, settings.token)}`;
}

function cfg() {
  return { url: settings.brokerUrl, token: settings.token };
}

export function App() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  if (route.page === 'play') return <Play key={route.code} code={route.code} />;
  if (route.page === 'host') return <HostPage key={route.code} code={route.code} />;
  return <Home code={route.code} />;
}

// ───────── главная ─────────

function Home({ code: initial }: { code?: string }) {
  const [name, setName] = useState(settings.name);
  const [color, setColor] = useState(settings.color);
  const [token, setToken] = useState(settings.token);
  const [code, setCode] = useState(initial ?? settings.lastRoom);
  const [broker, setBroker] = useState(settings.brokerUrl);
  const [turn, setTurn] = useState(settings.turn ?? { url: '', user: '', pass: '' });
  const ok = !!token.trim();
  const go = (hash: string) => {
    settings.name = name;
    settings.color = color;
    settings.token = token;
    settings.brokerUrl = broker;
    settings.turn = turn.url.trim() ? turn : null;
    location.hash = hash;
  };
  return (
    <div class="page">
      <h1>Warband</h1>
      <p class="muted">
        Проверка игры в реальном времени: телефоны ходят человечками по общей карте. Связь с хостом — напрямую через
        WebRTC, а если не вышло — через MQTT-брокер.
      </p>
      <div class="panel">
        <label>
          Имя
          <input value={name} maxLength={16} onInput={(e) => setName(e.currentTarget.value)} placeholder="Как вас зовут" />
        </label>
        <div class="swatches">
          {COLORS.map((c, i) => (
            <button class={`swatch ${i === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(i)} aria-label={`цвет ${i + 1}`} />
          ))}
        </div>
        <label>
          Токен брокера
          <input value={token} type="password" onInput={(e) => setToken(e.currentTarget.value)} placeholder="придёт в ссылке-приглашении" />
        </label>
        <div class="row">
          <input class="code" value={code} onInput={(e) => setCode(normalizeRoom(e.currentTarget.value))} placeholder="КОД" />
          <button class="primary" disabled={!ok || !name.trim() || !code} onClick={() => go(`r=${code}`)}>
            Войти
          </button>
        </div>
        <div class="row">
          <button disabled={!ok || !name.trim()} onClick={() => go(`r=${randomRoomCode()}`)}>
            📱 Новая комната
          </button>
          <button disabled={!ok} onClick={() => go(`host=${code || randomRoomCode()}`)}>
            💻 Хост-страница{code ? ` для ${code}` : ''}
          </button>
        </div>
        <p class="muted small">
          Хостом станет телефон первого вошедшего, если хоста нет. Хост-страница на ноутбуке надёжнее: телефон с
          погашенным экраном перестаёт считать игру, и хост переходит к другому.
        </p>
        <details>
          <summary>Дополнительно</summary>
          <label>
            Брокер
            <input value={broker} onInput={(e) => setBroker(e.currentTarget.value)} />
          </label>
          <p class="muted small">TURN-сервер нужен, только если телефоны не соединяются напрямую (мобильный интернет за NAT оператора).</p>
          <label>
            TURN
            <input value={turn.url} placeholder="turn:host:3478" onInput={(e) => setTurn({ ...turn, url: e.currentTarget.value })} />
          </label>
          <div class="row">
            <input value={turn.user} placeholder="логин" onInput={(e) => setTurn({ ...turn, user: e.currentTarget.value })} />
            <input value={turn.pass} type="password" placeholder="пароль" onInput={(e) => setTurn({ ...turn, pass: e.currentTarget.value })} />
          </div>
        </details>
      </div>
      <p class="muted small">
        Исходники: <a href={REPO} target="_blank" rel="noopener">{REPO.replace('https://', '')}</a>
      </p>
    </div>
  );
}

// ───────── общее ─────────

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  return <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function Invite({ code }: { code: string }) {
  const url = inviteUrl(code);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      prompt('Скопируйте ссылку', url);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <div class="invite">
      <Qr text={url} />
      <button onClick={copy}>{copied ? 'Скопировано' : 'Скопировать ссылку'}</button>
      <p class="muted small">В ссылке токен брокера: отправляйте только своим.</p>
    </div>
  );
}

const ms = (v: number | null) => (v === null ? '—' : `${v} мс`);

function viaText(row: Pick<PlayerRow, 'via' | 'route'>): string {
  if (row.via === 'local') return 'хост на этом устройстве';
  if (row.via === 'rtc') return `WebRTC, ${row.route ? routeLabel(row.route.local, row.route.remote) : 'напрямую'}`;
  return 'через брокер';
}

function useWakeLock() {
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null;
    const take = async () => {
      try {
        if (document.visibilityState === 'visible') lock = await (navigator as any).wakeLock?.request('screen');
      } catch {
        /* not allowed */
      }
    };
    void take();
    document.addEventListener('visibilitychange', take);
    return () => {
      document.removeEventListener('visibilitychange', take);
      void lock?.release().catch(() => {});
    };
  }, []);
}

function whoFrom(presence: Map<string, PresenceMsg>) {
  return (pid: string): Who => {
    const p = presence.get(pid);
    return { name: p?.name ?? '?', color: p?.color ?? 7, online: !!p?.online };
  };
}

/** How the last WebRTC attempt went, with a copy button. */
/** Option to show the real address to other devices; see net/mic.ts. */
function RevealCheck({ onChange }: { onChange?: () => void }) {
  const [, redraw] = useState(0);
  const [err, setErr] = useState('');
  return (
    <>
      <label class="check">
        <input
          type="checkbox"
          checked={reveal.on}
          onChange={async (e) => {
            const v = e.currentTarget.checked;
            setErr('');
            if (v) {
              const bad = await askMic();
              if (bad) {
                setErr(`Микрофон не дали (${bad}), адрес останется скрытым.`);
                redraw((x) => x + 1);
                return;
              }
            }
            reveal.on = v;
            redraw((x) => x + 1);
            onChange?.();
          }}
        />
        Показывать свой адрес в сети: для Firefox, если WebRTC не соединяется. Браузер спросит микрофон; он открывается на
        секунду при соединении, звук никуда не идёт
      </label>
      {err && <p class="bad small">{err}</p>}
    </>
  );
}

function DiagBox({ report, title = 'Диагностика WebRTC' }: { report: DiagReport | null; title?: string }) {
  const [copied, setCopied] = useState(false);
  const text = diagText(report);
  return (
    <details class="diag">
      <summary>{title}</summary>
      <p class="muted small">{browserName()}</p>
      <pre>{text}</pre>
      <button
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(
            () => setCopied(true),
            () => {},
          )
        }
      >
        {copied ? 'Скопировано' : 'Скопировать'}
      </button>
    </details>
  );
}

// ───────── игра ─────────

const clock = (ticks: number) => {
  const sec = Math.max(0, Math.ceil(ticks / TICK_HZ));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};

/** What is going on in the game, one or two lines; `me` is '' on the host page. */
function GameBanner({ g, n, me, name }: { g: TagState | null; n: number; me: string; name: (pid: string) => string }) {
  if (!g) return null;
  const left = g.end - n;
  const mine = g.it === me;
  let line: string;
  if (g.ph === 'wait')
    line = !g.wt?.length
      ? 'Догонялки начнутся, когда в комнате будет хотя бы двое'
      : g.wt.includes(me)
        ? 'Ждём прямого соединения с хостом…'
        : `Ждём прямого соединения: ${g.wt.map(name).join(', ')}`;
  else if (g.ph === 'hide')
    line = mine ? `Вы водите! Остальные прячутся: ${Math.ceil(left / TICK_HZ)}` : `Прячьтесь! Водит ${name(g.it)}: ${Math.ceil(left / TICK_HZ)}`;
  else if (g.ph === 'chase') {
    const fz = g.fz - n;
    if (mine) line = fz > 0 ? `❄ Вы водите, стоите ещё ${Math.ceil(fz / TICK_HZ)}` : `🔴 Вы водите — догоните кого-нибудь · ${clock(left)}`;
    else line = `Водит ${name(g.it)}${fz > 0 ? ' ❄' : ''} · ${clock(left)}`;
  } else line = `Раунд окончен. Следующий через ${Math.ceil(left / TICK_HZ)}`;
  const t = g.tag && n - g.tag[2] < 2 * TICK_HZ && g.ph === 'chase' ? g.tag : null;
  return (
    <div class={`banner ${mine && g.ph !== 'wait' && g.ph !== 'end' ? 'it' : ''}`}>
      <div>{line}</div>
      {g.ph === 'wait' && g.wt?.includes(me) && (
        <div class="small">Не соединяется? В меню: «Показывать свой адрес в сети» или «Только брокер».</div>
      )}
      {t && <div class="small">{t[1] === me ? 'Вас осалили — теперь вы водите!' : `${name(t[1])} теперь водит`}</div>}
      {g.ph === 'end' && <Scores g={g} name={name} me={me} />}
    </div>
  );
}

/** Who was "it" how long this round; the least wins. */
function Scores({ g, name, me }: { g: TagState; name: (pid: string) => string; me: string }) {
  const rows = [...g.sc].sort((a, b) => a[1] - b[1]);
  const best = rows[0]?.[1];
  return (
    <table class="scores">
      <tbody>
        {rows.map(([pid, t, w]) => (
          <tr class={pid === me ? 'me' : ''}>
            <td>{g.ph === 'end' && t === best ? '🏆' : ''}</td>
            <td>{name(pid)}</td>
            <td>водил(а) {Math.round(t / TICK_HZ)} с</td>
            <td class="muted">побед: {w}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ───────── игрок ─────────

function Play({ code }: { code: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const session = useMemo(() => {
    settings.lastRoom = code;
    return new Session({ cfg: cfg(), code, pid: settings.playerId, name: settings.name, color: settings.color, turn: settings.turn });
  }, [code]);
  const [info, setInfo] = useState<SessionInfo>(() => session.info());
  const [menu, setMenu] = useState(false);
  const [ghost, setGhost] = useState(false);
  const ghostRef = useRef(ghost);
  ghostRef.current = ghost;
  const [, redraw] = useState(0);
  const [hint, setHint] = useState(true);
  useWakeLock();

  useEffect(() => {
    const el = canvas.current!;
    const r = new Renderer(el);
    const joy = new Joystick(el);
    let raf = 0;
    let last = performance.now();
    let buzzed = session.game?.tag?.[2] ?? -1;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      session.frame(now, joy.dir());
      const { all, ghost: g } = session.poses(now, now - last);
      last = now;
      const game = session.game;
      r.draw(now, all, whoFrom(session.presence), {
        follow: session.o.pid,
        me: session.o.pid,
        ghost: ghostRef.current ? g : null,
        minimap: true,
        it: game?.it,
        itFrozen: !!game && speedOf(game, game.it, session.gameN) === 0,
        fog: foggy(game) ? all.get(session.o.pid) : null,
      });
      // A buzz when touched.
      const t = game?.tag;
      if (t && t[1] === session.o.pid && t[2] !== buzzed) {
        buzzed = t[2];
        navigator.vibrate?.(250);
      }
      joy.draw(el.getContext('2d')!, Math.min(window.devicePixelRatio || 1, 3));
      if (joy.used) setHint(false);
    };
    raf = requestAnimationFrame(loop);
    const t = setInterval(() => setInfo(session.info()), 250);
    return () => {
      cancelAnimationFrame(raf);
      clearInterval(t);
      joy.destroy();
      void session.close();
    };
  }, [session]);

  const status = !info.connected ? 'Подключение к брокеру…' : !info.host?.online ? 'Хоста нет — сейчас кто-то из игроков станет хостом…' : null;
  const hostName = info.hosting ? 'этот телефон' : info.host?.online ? info.host.name || 'хост-страница' : '—';
  const viaShort =
    info.via === 'local'
      ? '🏠 хост здесь'
      : info.via === 'rtc'
        ? `⚡ WebRTC${info.route ? `, ${info.route}` : ''}`
        : info.via === 'mqtt'
          ? `☁ брокер${info.rtc === 'connecting' ? ' (WebRTC подключается…)' : info.rtc === 'failed' && session.mode === 'auto' ? ' (WebRTC не вышел)' : ''}`
          : '…';

  return (
    <div class="play">
      <canvas ref={canvas} class="world" />
      <div class="hud">
        <div>
          <b>{code}</b> · {viaShort}
        </div>
        <div class="small">
          RTT: WebRTC {ms(info.rttRtc)} · брокер {ms(info.rttMqtt)} · {info.snapRate} кадр/с
        </div>
      </div>
      <button class="menu-btn" onClick={() => setMenu(!menu)}>
        ☰
      </button>
      {!status && (
        <GameBanner g={info.game} n={info.gameN} me={session.o.pid} name={(pid) => session.presence.get(pid)?.name ?? '?'} />
      )}
      {status && <div class="status">{status}</div>}
      {hint && !status && <div class="hint">Коснитесь экрана и тяните в нужную сторону</div>}
      {menu && (
        <div class="menu" onPointerDown={(e) => e.stopPropagation()}>
          <h3>Комната {code}</h3>
          <p class="small">
            Хост: <b>{hostName}</b>
          </p>
          <ul class="players">
            {info.presence
              .filter(([, p]) => p.online)
              .map(([pid, p]) => (
                <li>
                  <span class="dot" style={{ background: COLORS[p.color] }} /> {p.name}
                  {pid === session.o.pid ? ' (вы)' : ''}
                </li>
              ))}
          </ul>
          {info.game && info.game.ph !== 'wait' && (
            <>
              <h4>Этот раунд</h4>
              <Scores g={info.game} me={session.o.pid} name={(pid) => session.presence.get(pid)?.name ?? '?'} />
              <p class="muted small">
                Водящий бегает быстрее. Кого коснулся — тот водит и пару секунд стоит. Видно только то, что рядом и не за стеной; в
                кустах — только вплотную. Побеждает тот, кто водил меньше всех.
              </p>
            </>
          )}
          <h4>Опыты</h4>
          <label class="check">
            <input type="checkbox" checked={session.predict} onChange={(e) => ((session.predict = e.currentTarget.checked), redraw((x) => x + 1))} />
            Предсказание: свой человечек идёт сразу, не дожидаясь хоста
          </label>
          <label class="check">
            <input type="checkbox" checked={session.interp} onChange={(e) => ((session.interp = e.currentTarget.checked), redraw((x) => x + 1))} />
            Сглаживание чужих: показывать их чуть в прошлом, между кадрами
          </label>
          <label class="check">
            <input type="checkbox" checked={ghost} onChange={(e) => setGhost(e.currentTarget.checked)} />
            Рамка: где вы сейчас у хоста
          </label>
          <label class="check">
            <input
              type="checkbox"
              checked={session.mode === 'mqtt'}
              disabled={info.hosting}
              onChange={(e) => (session.setMode(e.currentTarget.checked ? 'mqtt' : 'auto'), redraw((x) => x + 1))}
            />
            Только брокер, без WebRTC
          </label>
          <label class="check">
            <input type="checkbox" checked={session.brokerPing} onChange={(e) => ((session.brokerPing = e.currentTarget.checked), redraw((x) => x + 1))} />
            Пинговать брокер раз в секунду и при WebRTC (для сравнения RTT)
          </label>
          <RevealCheck onChange={() => session.retryRtc()} />
          <p class="muted small">Поправок предсказания: {info.corrections}</p>
          <div class="row">
            <button disabled={info.hosting} onClick={() => void session.becomeHost()}>
              Стать хостом
            </button>
            <button onClick={() => (location.hash = '')}>Выйти</button>
          </div>
          <h4>Позвать</h4>
          <Invite code={code} />
          <DiagBox report={session.diag?.r ?? null} />
          <button class="close" onClick={() => setMenu(false)}>
            Закрыть
          </button>
        </div>
      )}
    </div>
  );
}

// ───────── хост-страница ─────────

function HostPage({ code }: { code: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [gen, setGen] = useState(0);
  const host = useMemo(() => new Host({ cfg: cfg(), code, name: '', turn: settings.turn }), [code, gen]);
  const [rows, setRows] = useState<PlayerRow[]>([]);
  const [state, setState] = useState<'starting' | 'running' | 'retired' | 'error'>('starting');

  useEffect(() => {
    let alive = true;
    host.onRetire = () => alive && setState('retired');
    host.start().then(
      () => alive && !host.retired && setState('running'),
      () => alive && setState('error'),
    );
    const el = canvas.current!;
    const r = new Renderer(el);
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const poses = new Map<string, Pose>();
      for (const [pid, p] of host.sim.players) poses.set(pid, { x: p.x, y: p.y, dir: p.idle < 3 ? p.dir : -1 });
      const g = host.tag.st;
      r.draw(now, poses, whoFrom(host.presence), { it: g.it, itFrozen: speedOf(g, g.it, host.sim.n) === 0 });
    };
    raf = requestAnimationFrame(loop);
    const t = setInterval(() => setRows(host.rows()), 250);
    const leave = () => void host.stop();
    window.addEventListener('pagehide', leave);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      clearInterval(t);
      window.removeEventListener('pagehide', leave);
      void host.stop();
    };
  }, [host]);

  return (
    <div class="hostpage">
      <canvas ref={canvas} class="world" />
      <aside class="panel">
        <h2>Комната {code}</h2>
        {state === 'starting' && <p>Подключение к брокеру…</p>}
        {state === 'error' && <p class="bad">Не удалось подключиться к брокеру. Проверьте токен на главной.</p>}
        {state === 'retired' && (
          <p class="bad">
            Хостом стала другая страница или телефон.{' '}
            <button onClick={() => (setState('starting'), setGen(gen + 1))}>Снова стать хостом</button>
          </p>
        )}
        {state === 'running' && <p class="muted small">Хост работает: {host.tickRate} тактов/с. Вкладку можно оставить в фоне.</p>}
        {state === 'running' && (
          <div class="hostgame">
            <GameBanner g={host.tag.st} n={host.sim.n} me="" name={(pid) => host.presence.get(pid)?.name ?? '?'} />
            {host.tag.st.ph !== 'wait' && host.tag.st.ph !== 'end' && (
              <Scores g={host.tag.st} me="" name={(pid) => host.presence.get(pid)?.name ?? '?'} />
            )}
          </div>
        )}
        <table class="rows">
          <thead>
            <tr>
              <th>Игрок</th>
              <th>Связь</th>
              <th>RTT WebRTC</th>
              <th>RTT брокер</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr class={r.online ? '' : 'off'}>
                <td>
                  <span class="dot" style={{ background: COLORS[r.color] }} /> {r.name}
                  {r.online ? '' : ' 💤'}
                </td>
                <td>{viaText(r)}</td>
                <td>{ms(r.stats?.rttRtc ?? null)}</td>
                <td>{ms(r.stats?.rttMqtt ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && <p class="muted">Пока никого. Отсканируйте код телефоном:</p>}
        <Invite code={code} />
        <RevealCheck />
        {rows.map((r) => (host.diags.has(r.pid) ? <DiagBox title={`WebRTC с ${r.name}`} report={host.diags.get(r.pid)!} /> : null))}
        <p>
          <button onClick={() => (location.hash = '')}>На главную</button>
        </p>
      </aside>
    </div>
  );
}
