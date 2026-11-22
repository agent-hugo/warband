/**
 * Prints the WebRTC reports players and hosts left on the broker.
 *   MQTT_TOKEN=... npm run diag            — every room
 *   MQTT_TOKEN=... npm run diag -- ABCD    — one room
 */
import mqtt from 'mqtt';
import { diagText, type DiagReport } from '../src/net/diag';
import { PREFIX } from '../src/net/protocol';

const token = process.env.MQTT_TOKEN;
if (!token) throw new Error('MQTT_TOKEN is not set');
const room = process.argv[2]?.toUpperCase() || '+';
const c = mqtt.connect(process.env.MQTT_URL || 'wss://mqtt.flespi.io', { username: token, protocolVersion: 5 });
const found: [string, DiagReport][] = [];
c.on('message', (t, m) => {
  if (m.length) found.push([t, JSON.parse(m.toString()) as DiagReport]);
});
c.on('connect', () => {
  c.subscribe(`${PREFIX}/${room}/diag/+`, () =>
    setTimeout(() => {
      found.sort((a, b) => a[1].at - b[1].at);
      for (const [t, r] of found) console.log(`\n=== ${t} · ${new Date(r.at).toLocaleString()}\n${diagText(r)}`);
      if (!found.length) console.log('Отчётов нет.');
      c.end();
    }, 1500),
  );
});
