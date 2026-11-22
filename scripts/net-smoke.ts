/**
 * Two players and a host over the broker only (Node has no WebRTC):
 * the players walk, and their positions must agree with the host's.
 *   MQTT_TOKEN=... npm run net-smoke
 */
import { DIRS } from '../src/game/world';
import { Host } from '../src/net/host';
import { randomRoomCode } from '../src/net/protocol';
import { Session } from '../src/net/session';

const token = process.env.MQTT_TOKEN;
if (!token) throw new Error('MQTT_TOKEN is not set');
const cfg = { url: process.env.MQTT_URL || 'wss://mqtt.flespi.io', token };
const code = `T${randomRoomCode()}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const host = new Host({ cfg, code, name: '', turn: null });
await host.start();
const a = new Session({ cfg, code, pid: 'aaaa', name: 'A', color: 0, turn: null });
const b = new Session({ cfg, code, pid: 'bbbb', name: 'B', color: 1, turn: null });
const t0 = performance.now();
let dir = 0;
const loop = setInterval(() => {
  const now = performance.now();
  a.frame(now, dir);
  b.frame(now, dir < 0 ? dir : (dir + DIRS / 2) % DIRS);
}, 16);
for (const [ms, d] of [[2000, 0], [2000, DIRS / 4], [1500, -1]] as const) {
  dir = d;
  await sleep(ms);
}
clearInterval(loop);
await sleep(800);
const sim = host.sim.players;
for (const s of [a, b]) {
  const hp = sim.get(s.o.pid);
  const i = s.info();
  console.log(s.o.name, 'host', hp && [hp.x, hp.y], 'predicted', s.pred.self, 'via', i.via, 'rtt', i.rttMqtt, 'ms, corrections', i.corrections);
  if (!hp || !s.pred.self || hp.x !== s.pred.self.x || hp.y !== s.pred.self.y) throw new Error(`${s.o.name}: prediction differs from host`);
}
console.log('ok in', Math.round(performance.now() - t0), 'ms; host ticks/s', host.tickRate);
await a.close();
await b.close();
await host.stop();
process.exit(0);
