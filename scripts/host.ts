/**
 * A host without a browser, for an always-on machine.
 * Usage: MQTT_TOKEN=... npm run host -- CODE   (MQTT_URL defaults to wss://mqtt.flespi.io)
 */
import { Host } from '../src/net/host';
import { Bus } from '../src/net/mqtt';
import { normalizeRoom, randomId, topics, type HostMsg } from '../src/net/protocol';

const url = process.env.MQTT_URL || 'wss://mqtt.flespi.io';
const token = process.env.MQTT_TOKEN;
const code = normalizeRoom(process.argv[2] ?? '');
if (!token || !code) {
  console.error('usage: MQTT_TOKEN=... npm run host -- CODE');
  process.exit(2);
}

const id = randomId();
const bus = new Bus({ url, token }, { will: { topic: topics.host(code), payload: { id, online: false } satisfies HostMsg } });
bus.onStatus((on) => log(on ? 'connected' : 'connection lost, reconnecting'));
await bus.ready();
const host = new Host(bus, code, id);
let last = '';
host.subscribe(() => {
  const g = host.room.game;
  const line = host.stopped
    ? 'another host took over'
    : g
      ? `battle ${g.battle + 1} round ${g.round} ${g.phase}`
      : `lobby · ${Object.values(host.room.seats).map((p) => (p ? (host.presence.get(p)?.name ?? '?') : '-')).join(', ')}`;
  if (line !== last) log(`${code}: ${(last = line)}`);
  if (host.stopped) void stop();
});
await host.start();

async function stop() {
  await host.stop().catch(() => {});
  await bus.end();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

function log(msg: string) {
  console.log(`${new Date().toISOString().slice(0, 19)} ${msg}`);
}
