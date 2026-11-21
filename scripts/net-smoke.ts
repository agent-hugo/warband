/**
 * End-to-end check over a real broker: a host, two players, one round.
 * Usage: MQTT_TOKEN=... npm run net-smoke
 */
import { card, hero, validTargets } from '../src/engine/engine';
import { RoomClient } from '../src/net/client';
import { Host } from '../src/net/host';
import { Bus } from '../src/net/mqtt';
import { randomId, randomRoomCode, topics } from '../src/net/protocol';

const url = process.env.MQTT_URL || 'wss://mqtt.flespi.io';
const token = process.env.MQTT_TOKEN;
if (!token) {
  console.error('MQTT_TOKEN is required');
  process.exit(2);
}
const cfg = { url, token };
const code = `T${randomRoomCode()}`;
const until = (what: string, ok: () => boolean, ms = 8000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (ok()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - t0 > ms) {
        clearInterval(iv);
        reject(new Error(`timeout: ${what}`));
      }
    }, 50);
  });

const hid = randomId();
const hbus = new Bus(cfg, { will: { topic: topics.host(code), payload: { id: hid, online: false } } });
await hbus.ready();
const host = new Host(hbus, code, hid);
await host.start();
console.log('room', code, 'host up');

const a = new RoomClient(cfg, code, 'pa', 'Аня');
const b = new RoomClient(cfg, code, 'pb', 'Боря');
await until('clients see room', () => !!a.view.room && !!b.view.room && !!a.view.host?.online);
a.send({ op: 'seat', seat: 'guard', take: true });
a.send({ op: 'seat', seat: 'blade', take: true });
b.send({ op: 'seat', seat: 'mystic', take: true });
await until('seats', () => b.view.room?.seats.mystic === 'pb' && b.view.room.seats.blade === 'pa' && b.view.room.seats.guard === 'pa');
b.send({ op: 'seat', seat: 'guard', take: true }); // taken by an online player
await until('refusal', () => !!b.view.error);
console.log('refused as expected:', b.view.error);
a.send({ op: 'start', battle: 0 });
await until('game', () => !!b.view.room?.game);
const g = b.view.room!.game!;
for (const [cl, seat] of [[a, 'guard'], [a, 'blade'], [b, 'mystic']] as const) {
  const h = hero(g, seat);
  const c = h.hand.find((x) => card(x.id).cost <= 2)!;
  const d = card(c.id);
  cl.send({ op: 'card', seat, uid: c.uid, target: d.target === 'none' ? undefined : validTargets(g, h, d)[0] });
  cl.send({ op: 'ready', seat, ready: true });
}
await until('round resolved', () => (b.view.room?.anim?.id ?? 0) === 1 && b.view.room!.game!.round === 2);
console.log('round 1 resolved:', b.view.room!.anim!.steps.length, 'steps,', JSON.stringify(b.view.room).length, 'bytes');

// b falls asleep; a plays for the mystic
b.announce(false);
await until('presence', () => host.presence.get('pb')?.online === false);
a.send({ op: 'ready', seat: 'mystic', ready: true });
await until('play for sleeping', () => hero(a.view.room!.game!, 'mystic').ready);
console.log('played for a sleeping player');

// takeover: a second host continues from the retained state
const hid2 = randomId();
const hbus2 = new Bus(cfg);
await hbus2.ready();
const host2 = new Host(hbus2, code, hid2);
await host2.start();
await until('old host retired', () => host.stopped);
a.send({ op: 'ready', seat: 'guard', ready: true });
await until('new host serves', () => hero(a.view.room!.game!, 'guard').ready);
console.log('takeover ok, round', a.view.room!.game!.round);

// clean up the retained topics of the test room
await Promise.all([a.close(), b.close()]);
await host2.stop();
for (const t of [topics.state(code), topics.host(code), topics.presence(code, 'pa'), topics.presence(code, 'pb')])
  await hbus2.publish(t, null, true);
await Promise.all([hbus.end(), hbus2.end()]);
console.log('OK');
process.exit(0);
