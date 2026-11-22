import type { Pose } from '../game/predict';
import { BUSHES, VIEW, WALLS, WORLD, facesLeft, sees, sightPolygon, type Rect, type Vec } from '../game/world';
import { COLORS } from '../net/protocol';

// 8×9 pixel sprites facing right. H hat, S skin, E eye, B body, L legs.
const TOP = ['..HHHH..', '.HHHHHH.', '.HSSSES.', '..SSSS..', '.BBBBBB.', 'SBBBBBBS', '..BBBB..'];
const FRAMES = [
  [...TOP, '..L..L..', '..L..L..'],
  [...TOP, '.L...L..', 'L.....L.'],
  [...TOP, '...LL...', '...LL...'],
];
const SW = 8;
const SH = 9;
/** World units per sprite pixel. */
const PX = 3;

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = (s: number) => Math.max(0, Math.min(255, Math.round(((n >> s) & 255) * k)));
  return `rgb(${c(16)},${c(8)},${c(0)})`;
}

const cache = new Map<string, HTMLCanvasElement>();

function sprite(color: number, frame: number): HTMLCanvasElement {
  const key = `${color}:${frame}`;
  let c = cache.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = SW;
  c.height = SH;
  const g = c.getContext('2d')!;
  const body = COLORS[color] ?? COLORS[7]!;
  const pal: Record<string, string> = { H: shade(body, 0.6), S: '#f5c9a0', E: '#1a1a1a', B: body, L: '#2b2b33' };
  FRAMES[frame]!.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      const col = pal[ch];
      if (!col) return;
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }),
  );
  cache.set(key, c);
  return c;
}

export interface Who {
  name: string;
  color: number;
  online: boolean;
}

interface Motion {
  at: Vec;
  left: boolean;
  movingUntil: number;
}

export interface DrawOptions {
  /** Follow this player; otherwise fit the whole world. */
  follow?: string;
  me?: string;
  ghost?: Pose | null;
  minimap?: boolean;
  /** Who is "it", and whether they stand frozen. */
  it?: string;
  itFrozen?: boolean;
  /** Draw fog around this point. */
  fog?: Vec | null;
  /** Shown on the minimap even when out of sight (hiders who stood still too long, for "it"). */
  exposed?: Set<string>;
}

/** A few darker leaves in a bush, the same every frame. */
function leaves(r: Rect): Vec[] {
  const out: Vec[] = [];
  let s = r.x * 7 + r.y * 13;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < (r.w * r.h) / 260; i++) out.push({ x: r.x + 6 + rnd() * (r.w - 12), y: r.y + 6 + rnd() * (r.h - 12) });
  return out;
}
const LEAVES = BUSHES.map(leaves);

function roundRect(g: CanvasRenderingContext2D, r: Rect, rad: number) {
  g.beginPath();
  g.roundRect(r.x, r.y, r.w, r.h, rad);
}

/** Draws the world on a canvas that fills its element. */
export class Renderer {
  private motion = new Map<string, Motion>();
  /** Last camera transform: world → CSS px. */
  scale = 1;
  ox = 0;
  oy = 0;

  constructor(readonly canvas: HTMLCanvasElement) {}

  /** Resizes the backing store to the element; returns CSS size. */
  private fit(): { w: number; h: number; dpr: number } {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const bw = Math.round(w * dpr);
    const bh = Math.round(h * dpr);
    if (this.canvas.width !== bw || this.canvas.height !== bh) {
      this.canvas.width = bw;
      this.canvas.height = bh;
    }
    return { w, h, dpr };
  }

  draw(now: number, poses: Map<string, Pose>, who: (pid: string) => Who, o: DrawOptions = {}) {
    const { w, h, dpr } = this.fit();
    const g = this.canvas.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#0d0f12';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);

    const followed = o.follow ? poses.get(o.follow) : undefined;
    let scale: number;
    let cx: number;
    let cy: number;
    if (o.follow) {
      scale = Math.min(w, h) / 420;
      const at = followed ?? { x: WORLD.w / 2, y: WORLD.h / 2 };
      const hw = w / scale / 2;
      const hh = h / scale / 2;
      cx = hw * 2 >= WORLD.w ? WORLD.w / 2 : Math.max(hw, Math.min(WORLD.w - hw, at.x));
      cy = hh * 2 >= WORLD.h ? WORLD.h / 2 : Math.max(hh, Math.min(WORLD.h - hh, at.y));
    } else {
      scale = Math.min(w / WORLD.w, h / WORLD.h);
      cx = WORLD.w / 2;
      cy = WORLD.h / 2;
    }
    this.scale = scale;
    this.ox = w / 2 - cx * scale;
    this.oy = h / 2 - cy * scale;
    g.setTransform(dpr * scale, 0, 0, dpr * scale, dpr * this.ox, dpr * this.oy);
    g.imageSmoothingEnabled = false;

    // floor
    const T = 40;
    for (let y = 0; y < WORLD.h; y += T)
      for (let x = 0; x < WORLD.w; x += T) {
        g.fillStyle = ((x + y) / T) % 2 ? '#2f4d33' : '#33533a';
        g.fillRect(x, y, T, T);
      }
    // walls
    for (const r of WALLS) {
      g.fillStyle = '#5c4a3a';
      g.fillRect(r.x, r.y, r.w, r.h);
      g.fillStyle = '#7d6650';
      g.fillRect(r.x, r.y, r.w, Math.min(6, r.h));
    }

    if (o.ghost) {
      g.strokeStyle = '#ffffffaa';
      g.lineWidth = 1.5;
      g.strokeRect(o.ghost.x - 9, o.ghost.y - 9, 18, 18);
    }

    // players, back to front
    // In the fog, whoever this phone does not see right now is not drawn (the host keeps them a moment longer).
    const fog = o.fog;
    const list = [...poses].filter(([pid, p]) => !fog || pid === o.me || sees(fog, p)).sort((a, b) => a[1].y - b[1].y);
    for (const [pid, p] of list) this.player(g, now, pid, p, who(pid), pid === o.me, pid === o.it ? (o.itFrozen ? 'frozen' : 'it') : null);
    for (const pid of this.motion.keys()) if (!poses.has(pid)) this.motion.delete(pid);

    // bushes over whoever is inside
    BUSHES.forEach((b, i) => {
      g.globalAlpha = 0.82;
      g.fillStyle = '#2d7a34';
      roundRect(g, b, 14);
      g.fill();
      g.fillStyle = '#21602a';
      for (const l of LEAVES[i]!) {
        g.beginPath();
        g.arc(l.x, l.y, 5, 0, Math.PI * 2);
        g.fill();
      }
      g.globalAlpha = 1;
    });

    if (o.fog) this.fog(g, o.fog);

    if (o.minimap) {
      const ex = [...(o.exposed ?? [])].filter((pid) => poses.has(pid)).map((pid) => [pid, poses.get(pid)!] as const);
      this.minimap(g, now, dpr, w, new Map([...list, ...ex]), who, o.me, o.exposed);
    }
  }

  /** Darkness outside what is seen from `p`, softened towards the edge of sight. */
  private fog(g: CanvasRenderingContext2D, p: Vec) {
    const poly = sightPolygon(p);
    const m = 2000;
    g.beginPath();
    g.rect(-m, -m, WORLD.w + 2 * m, WORLD.h + 2 * m);
    g.moveTo(poly[0]!.x, poly[0]!.y);
    for (const q of poly) g.lineTo(q.x, q.y);
    g.closePath();
    g.fillStyle = 'rgba(4,6,10,0.72)';
    g.fill('evenodd');
    const grad = g.createRadialGradient(p.x, p.y, VIEW * 0.6, p.x, p.y, VIEW);
    grad.addColorStop(0, 'rgba(4,6,10,0)');
    grad.addColorStop(1, 'rgba(4,6,10,0.55)');
    g.beginPath();
    g.moveTo(poly[0]!.x, poly[0]!.y);
    for (const q of poly) g.lineTo(q.x, q.y);
    g.closePath();
    g.fillStyle = grad;
    g.fill();
  }

  private player(g: CanvasRenderingContext2D, now: number, pid: string, p: Pose, who: Who, me: boolean, role: 'it' | 'frozen' | null) {
    let m = this.motion.get(pid);
    if (!m) {
      m = { at: { x: p.x, y: p.y }, left: false, movingUntil: 0 };
      this.motion.set(pid, m);
    }
    const dx = p.x - m.at.x;
    if (Math.abs(dx) + Math.abs(p.y - m.at.y) > 0.05) m.movingUntil = now + 120;
    if (p.dir >= 0) m.left = facesLeft(p.dir);
    else if (Math.abs(dx) > 0.05) m.left = dx < 0;
    m.at = { x: p.x, y: p.y };
    const frame = now < m.movingUntil ? 1 + (Math.floor(now / 140) % 2) : 0;

    g.globalAlpha = who.online ? 1 : 0.45;
    g.fillStyle = '#00000055';
    g.beginPath();
    g.ellipse(p.x, p.y + 8, 10, 4, 0, 0, Math.PI * 2);
    g.fill();
    if (role) {
      g.fillStyle = role === 'frozen' ? '#7fc8ff66' : '#ff303066';
      g.beginPath();
      g.ellipse(p.x, p.y + 8, 17, 7, 0, 0, Math.PI * 2);
      g.fill();
    }
    if (me) {
      g.strokeStyle = '#ffffffcc';
      g.lineWidth = 1.2;
      g.beginPath();
      g.ellipse(p.x, p.y + 8, 13, 5.5, 0, 0, Math.PI * 2);
      g.stroke();
    }
    const img = sprite(who.color, frame);
    const top = p.y + 9 - SH * PX;
    g.save();
    if (m.left) {
      g.translate(p.x, 0);
      g.scale(-1, 1);
      g.drawImage(img, -(SW * PX) / 2, top, SW * PX, SH * PX);
    } else g.drawImage(img, p.x - (SW * PX) / 2, top, SW * PX, SH * PX);
    g.restore();

    g.font = 'bold 9px system-ui, sans-serif';
    g.textAlign = 'center';
    g.lineWidth = 2.5;
    g.strokeStyle = '#000000aa';
    const label = `${who.online ? '' : '💤 '}${role === 'frozen' ? '❄ ' : role === 'it' ? '🔴 ' : ''}${who.name}`;
    g.strokeText(label, p.x, top - 3);
    g.fillStyle = '#fff';
    g.fillText(label, p.x, top - 3);
    g.globalAlpha = 1;
  }

  private minimap(
    g: CanvasRenderingContext2D,
    now: number,
    dpr: number,
    w: number,
    poses: Map<string, Pose>,
    who: (pid: string) => Who,
    me?: string,
    exposed?: Set<string>,
  ) {
    const mw = 96;
    const k = mw / WORLD.w;
    const mh = WORLD.h * k;
    const x0 = w - mw - 8;
    const y0 = 52;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = 0.8;
    g.fillStyle = '#1d2a20';
    g.fillRect(x0, y0, mw, mh);
    g.fillStyle = '#7d6650';
    for (const r of WALLS) g.fillRect(x0 + r.x * k, y0 + r.y * k, Math.max(1, r.w * k), Math.max(1, r.h * k));
    g.fillStyle = '#2d7a34';
    for (const r of BUSHES) g.fillRect(x0 + r.x * k, y0 + r.y * k, r.w * k, r.h * k);
    for (const [pid, p] of poses) {
      g.fillStyle = COLORS[who(pid).color] ?? '#fff';
      const s = pid === me ? 4 : 3;
      g.fillRect(x0 + p.x * k - s / 2, y0 + p.y * k - s / 2, s, s);
      if (exposed?.has(pid)) {
        // A pulsing red ring, so "it" notices.
        g.strokeStyle = '#ff3030';
        g.lineWidth = 1.5;
        g.beginPath();
        g.arc(x0 + p.x * k, y0 + p.y * k, 4 + 2 * Math.abs(Math.sin(now / 200)), 0, Math.PI * 2);
        g.stroke();
      }
    }
    g.globalAlpha = 1;
  }
}
