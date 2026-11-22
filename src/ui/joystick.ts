import { STOP, quantize } from '../game/world';

const RADIUS = 52;
const DEAD = 10;

/**
 * A floating on-screen stick: touch anywhere, drag to set the direction.
 * Speed does not depend on how far the finger goes. Arrows / WASD on a keyboard.
 */
export class Joystick {
  private id: number | null = null;
  private origin = { x: 0, y: 0 };
  private cur = { x: 0, y: 0 };
  private keys = new Set<string>();
  used = false;

  constructor(private el: HTMLElement) {
    el.addEventListener('pointerdown', this.down);
    el.addEventListener('pointermove', this.move);
    el.addEventListener('pointerup', this.up);
    el.addEventListener('pointercancel', this.up);
    window.addEventListener('keydown', this.key);
    window.addEventListener('keyup', this.key);
    window.addEventListener('blur', this.reset);
  }

  private down = (e: PointerEvent) => {
    if (this.id !== null) return;
    this.id = e.pointerId;
    this.el.setPointerCapture?.(e.pointerId);
    this.origin = this.cur = this.point(e);
    this.used = true;
    e.preventDefault();
  };

  private move = (e: PointerEvent) => {
    if (e.pointerId !== this.id) return;
    this.cur = this.point(e);
    // Drag past the rim: the stick follows the finger, so turning back is instant.
    const dx = this.cur.x - this.origin.x;
    const dy = this.cur.y - this.origin.y;
    const d = Math.hypot(dx, dy);
    if (d > RADIUS) {
      this.origin = { x: this.cur.x - (dx / d) * RADIUS, y: this.cur.y - (dy / d) * RADIUS };
    }
  };

  private up = (e: PointerEvent) => {
    if (e.pointerId === this.id) this.id = null;
  };

  private reset = () => {
    this.id = null;
    this.keys.clear();
  };

  private key = (e: KeyboardEvent) => {
    const k = e.code;
    if (!/^(Arrow(Up|Down|Left|Right)|Key[WASD])$/.test(k)) return;
    if (e.target instanceof HTMLInputElement) return;
    if (e.type === 'keydown') this.keys.add(k);
    else this.keys.delete(k);
    this.used = true;
    e.preventDefault();
  };

  private point(e: PointerEvent) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  dir(): number {
    if (this.id !== null) return quantize(this.cur.x - this.origin.x, this.cur.y - this.origin.y, DEAD);
    if (!this.keys.size) return STOP;
    const has = (...c: string[]) => c.some((x) => this.keys.has(x));
    const x = (has('ArrowRight', 'KeyD') ? 1 : 0) - (has('ArrowLeft', 'KeyA') ? 1 : 0);
    const y = (has('ArrowDown', 'KeyS') ? 1 : 0) - (has('ArrowUp', 'KeyW') ? 1 : 0);
    return quantize(x, y);
  }

  /** Draws the stick in CSS pixels (call with a dpr-only transform). */
  draw(g: CanvasRenderingContext2D, dpr: number) {
    if (this.id === null) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.globalAlpha = 0.35;
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(this.origin.x, this.origin.y, RADIUS, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 0.8;
    g.beginPath();
    g.arc(this.cur.x, this.cur.y, 22, 0, Math.PI * 2);
    g.fill();
    g.globalAlpha = 1;
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this.down);
    this.el.removeEventListener('pointermove', this.move);
    this.el.removeEventListener('pointerup', this.up);
    this.el.removeEventListener('pointercancel', this.up);
    window.removeEventListener('keydown', this.key);
    window.removeEventListener('keyup', this.key);
    window.removeEventListener('blur', this.reset);
  }
}
