import qrcode from 'qrcode-generator';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ENCOUNTERS, HEROES, HERO_ORDER } from '../engine/content';
import { allReady, newGame, resolveRound } from '../engine/engine';
import type { GameState, HeroId } from '../engine/types';
import { RoomClient, type ClientView } from '../net/client';
import { Host } from '../net/host';
import { Bus } from '../net/mqtt';
import {
  applyGameOp,
  normalizeRoom,
  randomId,
  randomRoomCode,
  topics,
  type GameOp,
  type HostMsg,
  type RoomState,
} from '../net/protocol';
import { GameView, Help, type Playback } from './GameView';
import { settings } from './storage';

const STEP_MS = 700;

type Route = { page: 'home' } | { page: 'local' } | { page: 'room'; code: string } | { page: 'host'; code: string };

/** Reads the hash; a token in it (`t=`) is saved and removed from the address. */
function parseRoute(): Route {
  const h = new URLSearchParams(location.hash.slice(1));
  const t = h.get('t');
  if (t) {
    settings.token = t;
    h.delete('t');
    history.replaceState(null, '', `${location.pathname}${location.search}#${h.toString()}`);
  }
  if (h.has('local')) return { page: 'local' };
  const r = normalizeRoom(h.get('r') ?? '');
  if (r) return { page: 'room', code: r };
  const host = normalizeRoom(h.get('host') ?? '');
  if (host) return { page: 'host', code: host };
  return { page: 'home' };
}

export function App() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const on = () => setRoute(parseRoute());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const [showHelp, setShowHelp] = useState(false);

  return (
    <div class="app">
      <header>
        <div>
          <a href="#" class="logo">Warband</a>
          {route.page === 'room' && <> · комната <b>{route.code}</b></>}
          {route.page === 'host' && <> · хост <b>{route.code}</b></>}
          {route.page === 'local' && <> · один экран</>}
        </div>
        <div class="hdr-btns">
          <button onClick={() => setShowHelp(!showHelp)}>?</button>
        </div>
      </header>
      {showHelp && <Help onClose={() => setShowHelp(false)} />}
      {route.page === 'home' && <Home />}
      {route.page === 'local' && <Local />}
      {route.page === 'room' && <NetRoom key={route.code} code={route.code} />}
      {route.page === 'host' && <HostPage key={route.code} code={route.code} />}
    </div>
  );
}

// ───────── главная ─────────

function Home() {
  const [name, setName] = useState(settings.name);
  const [token, setToken] = useState(settings.token);
  const [code, setCode] = useState(settings.lastRoom);
  const net = !!token.trim();
  const go = (hash: string) => {
    settings.name = name;
    settings.token = token;
    location.hash = hash;
  };
  return (
    <div class="panel home">
      <h3>Игра по сети</h3>
      <label>
        Ваше имя
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} placeholder="Как вас зовут" />
      </label>
      <label>
        Токен брокера
        <input value={token} type="password" onInput={(e) => setToken(e.currentTarget.value)} placeholder="придёт в ссылке-приглашении" />
      </label>
      <div class="row">
        <input class="code" value={code} onInput={(e) => setCode(normalizeRoom(e.currentTarget.value))} placeholder="КОД" />
        <button class="primary" disabled={!net || !name.trim() || !code} onClick={() => go(`r=${code}`)}>
          Войти в комнату
        </button>
      </div>
      <div class="row">
        <button disabled={!net} onClick={() => go(`host=${randomRoomCode()}`)}>
          🖥 Новая комната: хост-страница
        </button>
        <button disabled={!net || !name.trim()} onClick={() => go(`r=${randomRoomCode()}`)}>
          📱 Новая комната с этого телефона
        </button>
      </div>
      <p class="muted small">
        Хост-страница считает игру: откройте её на ноутбуке и покажите QR-код игрокам. Если хоста нет, любой телефон
        может запустить его у себя.
      </p>
      <h3>Без сети</h3>
      <button onClick={() => (location.hash = 'local')}>Все герои на одном экране</button>
    </div>
  );
}

// ───────── розыгрыш по шагам ─────────

function useStepTimer(play: Playback | null, next: (p: Playback | null) => void) {
  useEffect(() => {
    if (!play) return;
    const t = window.setTimeout(() => next(play.i + 1 < play.steps.length ? { ...play, i: play.i + 1 } : null), STEP_MS);
    return () => clearTimeout(t);
  }, [play]);
}

/** Plays a new resolution once; the one already there when the page opened is not replayed. */
function usePlayback(anim: RoomState['anim'] | undefined, ready: boolean) {
  const seen = useRef<number | undefined>(undefined);
  const [play, setPlay] = useState<Playback | null>(null);
  const id = anim?.id ?? 0;
  useEffect(() => {
    if (!ready) return;
    if (seen.current === undefined) seen.current = id;
    else if (id !== seen.current) {
      seen.current = id;
      setPlay(anim && anim.steps.length ? { steps: anim.steps, i: 0 } : null);
    }
  }, [id, ready]);
  useStepTimer(play, setPlay);
  return { play, skip: () => setPlay(null) };
}

// ───────── один экран ─────────

const SAVE_KEY = 'warband-proto-v1';

function Local() {
  const [game, setGame] = useState<GameState>(() => {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (raw) return JSON.parse(raw) as GameState;
    } catch {
      /* new game */
    }
    return newGame();
  });
  const [play, setPlay] = useState<Playback | null>(null);
  useEffect(() => localStorage.setItem(SAVE_KEY, JSON.stringify(game)), [game]);
  useStepTimer(play, setPlay);

  function send(op: GameOp): string | null {
    const s = structuredClone(game);
    const err = applyGameOp(s, op);
    if (err) return err;
    if (allReady(s)) {
      const { state, steps } = resolveRound(s);
      setGame(state);
      if (steps.length) setPlay({ steps, i: 0 });
    } else setGame(s);
    return null;
  }

  return (
    <>
      <div class="row right">
        <select
          value=""
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v !== '' && confirm('Начать заново?')) {
              setPlay(null);
              setGame(newGame(Date.now(), Number(v)));
            }
          }}
        >
          <option value="">Заново…</option>
          {ENCOUNTERS.map((x, i) => (
            <option value={i}>{i === 0 ? 'Новая игра' : `С боя ${i + 1}: ${x.name}`}</option>
          ))}
        </select>
      </div>
      <GameView
        game={game}
        play={play}
        onSkip={() => setPlay(null)}
        canControl={() => true}
        send={send}
        onNewGame={() => setGame(newGame())}
        autoNext
      />
    </>
  );
}

// ───────── игрок по сети ─────────

function useClient(code: string, name: string): [RoomClient, ClientView] {
  const client = useMemo(
    () => new RoomClient({ url: settings.brokerUrl, token: settings.token }, code, settings.playerId, name),
    [code, name],
  );
  const [view, setView] = useState(client.view);
  useEffect(() => {
    const off = client.subscribe(() => setView(client.view));
    const vis = () => client.announce(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', vis);
    const bye = () => client.announce(false);
    window.addEventListener('pagehide', bye);
    return () => {
      off();
      document.removeEventListener('visibilitychange', vis);
      window.removeEventListener('pagehide', bye);
      void client.close();
    };
  }, [client]);
  return [client, view];
}

function NetRoom({ code }: { code: string }) {
  const [name, setName] = useState(settings.name);
  if (!settings.token) return <NeedToken />;
  if (!name) return <AskName onDone={setName} />;
  return <NetRoomIn code={code} name={name} />;
}

function NeedToken() {
  return (
    <div class="panel">
      <p>Нужен токен брокера: откройте ссылку-приглашение (QR на хост-странице) или введите токен на главной.</p>
      <a href="#">На главную</a>
    </div>
  );
}

function AskName({ onDone }: { onDone: (n: string) => void }) {
  const [v, setV] = useState('');
  return (
    <div class="panel home">
      <label>
        Как вас зовут?
        <input value={v} onInput={(e) => setV(e.currentTarget.value)} autoFocus />
      </label>
      <button
        class="primary"
        disabled={!v.trim()}
        onClick={() => {
          settings.name = v;
          onDone(v.trim());
        }}
      >
        Дальше
      </button>
    </div>
  );
}

function NetRoomIn({ code, name }: { code: string; name: string }) {
  const [client, view] = useClient(code, name);
  const pid = client.pid;
  const room = view.room;
  const [localHost, setLocalHost] = useState<LocalHost | null>(null);
  const hostOnline = !!view.host?.online;
  const [playFor, setPlayFor] = useState<HeroId[]>([]);
  const { play, skip } = usePlayback(room?.anim, !!room);
  useEffect(() => {
    settings.lastRoom = code;
  }, [code]);
  useEffect(() => () => void localHost?.stop(), [localHost]);

  // Новая комната (ни состояния, ни хоста) — хост поднимается на этом телефоне
  const hosting = useRef(false);
  const hostHere = () => {
    if (hosting.current) return;
    hosting.current = true;
    startLocalHost(code).then(setLocalHost, () => (hosting.current = false));
  };
  useEffect(() => {
    if (!view.connected) return;
    const t = setTimeout(() => {
      if (!client.view.room && !client.view.host?.online) hostHere();
    }, 1500);
    return () => clearTimeout(t);
  }, [view.connected]);

  const ownerOnline = (id: HeroId) => {
    const o = room?.seats[id];
    return !!o && !!view.presence[o]?.online;
  };
  const canControl = (id: HeroId) => room?.seats[id] === pid || (playFor.includes(id) && !ownerOnline(id));
  const who = (p: string | null | undefined) => (p ? (view.presence[p]?.name ?? room?.names[p] ?? '?') : '');

  const sleeping = room?.game
    ? [...new Set(HERO_ORDER.map((id) => room.seats[id]).filter((p): p is string => !!p && p !== pid && !view.presence[p]?.online))]
    : [];

  function send(op: GameOp): string | null {
    if (!room?.game) return 'Нет игры';
    if (!hostOnline) return 'Хост не в сети';
    const err = applyGameOp(structuredClone(room.game), op);
    if (err) return err;
    client.send(op);
    return null;
  }

  const seatNote = (id: HeroId) => {
    const o = room?.seats[id];
    if (o === pid) return null;
    if (ownerOnline(id)) return <div class="note">Играет {who(o)}</div>;
    const on = playFor.includes(id);
    return (
      <div class="note sleep">
        😴 {who(o) || 'Никто'} не в сети — разбудите!{' '}
        <button onClick={() => setPlayFor(on ? playFor.filter((x) => x !== id) : [...playFor, id])}>
          {on ? 'Вернуть ход' : 'Сыграть за него'}
        </button>
      </div>
    );
  };

  return (
    <>
      <div class="status small">
        <span class={view.connected ? 'ok' : 'bad'}>● {view.connected ? 'на связи' : 'нет связи…'}</span>
        {' · '}
        <span class={hostOnline ? 'ok' : 'bad'}>
          хост {hostOnline ? (localHost && !localHost.host.stopped ? 'на этом телефоне' : 'в сети') : 'не в сети'}
        </span>
      </div>
      {!hostOnline && view.connected && room && (
        <div class="note warn">
          Хост не в сети. <button onClick={hostHere}>Запустить хост на этом телефоне</button>
        </div>
      )}
      {sleeping.length > 0 && <div class="note sleep">😴 {sleeping.map(who).join(', ')} — не в сети, разбудите!</div>}
      {!room && <p class="muted">Загрузка комнаты…</p>}
      {room && !room.game && <Lobby code={code} room={room} view={view} pid={pid} client={client} />}
      {room?.game && (
        <>
          <GameView
            game={room.game}
            play={play}
            onSkip={skip}
            canControl={canControl}
            send={send}
            err={view.error}
            seatNote={seatNote}
            onNewGame={() => client.send({ op: 'lobby' })}
          />
          <div class="row right">
            <button class="link" onClick={() => confirm('Вернуться в лобби? Текущая игра закончится.') && client.send({ op: 'lobby' })}>
              ⏏ В лобби
            </button>
          </div>
        </>
      )}
    </>
  );
}

function Lobby(p: { code: string; room: RoomState; view: ClientView; pid: string; client: RoomClient }) {
  const { room, view, pid, client } = p;
  const [battle, setBattle] = useState(0);
  const full = HERO_ORDER.every((id) => room.seats[id]);
  const seated = Object.values(room.seats);
  const others = Object.entries(view.presence).filter(([id, x]) => x.online && !seated.includes(id));
  return (
    <div class="panel">
      <h3>Лобби: выберите героев</h3>
      <p class="muted small">Один игрок может взять нескольких героев.</p>
      {view.error && <div class="err">{view.error}</div>}
      {HERO_ORDER.map((id) => {
        const d = HEROES[id];
        const o = room.seats[id];
        const on = !!o && !!view.presence[o]?.online;
        return (
          <div class="seat">
            <div>
              <b>
                {d.icon} {d.name}
              </b>{' '}
              <span class="muted small">{d.passive}</span>
              <div class="small">
                {o ? (
                  <>
                    {o === pid ? 'Вы' : (view.presence[o]?.name ?? room.names[o])} {on ? '' : '😴'}
                  </>
                ) : (
                  <span class="muted">свободно</span>
                )}
              </div>
            </div>
            {o === pid ? (
              <button onClick={() => client.send({ op: 'seat', seat: id, take: false })}>Освободить</button>
            ) : (
              <button disabled={on} onClick={() => client.send({ op: 'seat', seat: id, take: true })}>
                Взять
              </button>
            )}
          </div>
        );
      })}
      {others.length > 0 && <p class="small muted">Без героя: {others.map(([, x]) => x.name).join(', ')}</p>}
      <div class="row">
        <select value={battle} onChange={(e) => setBattle(Number(e.currentTarget.value))}>
          {ENCOUNTERS.map((x, i) => (
            <option value={i}>{i === 0 ? 'С начала' : `С боя ${i + 1}: ${x.name}`}</option>
          ))}
        </select>
        <button class="primary" disabled={!full} onClick={() => client.send({ op: 'start', battle })}>
          Начать
        </button>
      </div>
      <Invite code={p.code} />
    </div>
  );
}

function Invite({ code }: { code: string }) {
  const [withToken, setWithToken] = useState(true);
  const url = `${location.origin}${location.pathname}#r=${code}${withToken ? `&t=${encodeURIComponent(settings.token)}` : ''}`;
  const svg = useMemo(() => {
    const q = qrcode(0, 'M');
    q.addData(url);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [url]);
  return (
    <div class="invite">
      <div class="qr" dangerouslySetInnerHTML={{ __html: svg }} />
      <div>
        <div>
          Комната <b class="big">{code}</b>
        </div>
        <label class="small">
          <input type="checkbox" checked={withToken} onChange={(e) => setWithToken(e.currentTarget.checked)} /> ссылка с токеном
        </label>
        <div>
          <button onClick={() => void navigator.clipboard?.writeText(url)}>Скопировать ссылку</button>
        </div>
      </div>
    </div>
  );
}

// ───────── хост ─────────

interface LocalHost {
  host: Host;
  stop: () => Promise<void>;
}

async function startLocalHost(code: string): Promise<LocalHost> {
  const id = randomId();
  const bus = new Bus(
    { url: settings.brokerUrl, token: settings.token },
    { will: { topic: topics.host(code), payload: { id, online: false } satisfies HostMsg } },
  );
  await bus.ready();
  const host = new Host(bus, code, id);
  await host.start();
  return {
    host,
    stop: async () => {
      await host.stop();
      await bus.end();
    },
  };
}

function HostPage({ code }: { code: string }) {
  const [lh, setLh] = useState<LocalHost | null>(null);
  const [err, setErr] = useState('');
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!settings.token) return;
    let alive = true;
    let started: LocalHost | null = null;
    startLocalHost(code).then(
      (x) => {
        started = x;
        if (alive) setLh(x);
        else void x.stop();
      },
      (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
    );
    const bye = () => void started?.stop();
    window.addEventListener('pagehide', bye);
    return () => {
      alive = false;
      window.removeEventListener('pagehide', bye);
      void started?.stop();
    };
  }, [code]);
  useEffect(() => lh?.host.subscribe(() => setTick((t) => t + 1)), [lh]);
  const room = lh?.host.room;
  const { play, skip } = usePlayback(room?.anim, !!room);

  if (!settings.token) return <NeedToken />;
  if (err) return <div class="err">Ошибка подключения: {err}</div>;
  if (!lh || !room) return <p class="muted">Подключение…</p>;
  if (lh.host.stopped)
    return (
      <div class="note warn">
        Игру этой комнаты теперь считает другой хост. <button onClick={() => location.reload()}>Забрать обратно</button>
      </div>
    );
  const presence = lh.host.presence;
  const name = (p: string | null) => (p ? (presence.get(p)?.name ?? room.names[p] ?? '?') : '—');
  return (
    <>
      <div class="host-top">
        <Invite code={code} />
        <div class="panel host-seats">
          {HERO_ORDER.map((id) => {
            const o = room.seats[id];
            return (
              <div>
                {HEROES[id].icon} {HEROES[id].name}: <b>{name(o)}</b> {o && (presence.get(o)?.online ? '🟢' : '😴')}
              </div>
            );
          })}
          <div class="muted small">
            В комнате: {[...presence.values()].filter((x) => x.online).map((x) => x.name).join(', ') || 'никого'}
          </div>
          <div class="muted small">Не закрывайте эту страницу: она считает игру.</div>
        </div>
      </div>
      {room.game ? (
        <GameView
          game={room.game}
          play={play}
          onSkip={skip}
          canControl={() => false}
          send={() => 'Хост только показывает игру'}
          onNewGame={() => {}}
        />
      ) : (
        <p class="muted">Ждём, пока игроки займут героев и нажмут «Начать».</p>
      )}
    </>
  );
}
