/**
 * Firefox hides its address in the home network behind a random ".local"
 * name, and in some networks nobody can turn that name back into an address,
 * so a direct link cannot start. A page that may use the microphone gets
 * the real address instead. With this on, the microphone is opened while a
 * link collects its addresses and closed right after; nothing is recorded.
 */

import { save, load } from '../ui/storage';
import type { Diag } from './diag';

const KEY = 'wb:reveal';

let on = typeof localStorage !== 'undefined' && load(KEY) === '1';
let stream: MediaStream | null = null;
let opening: Promise<MediaStream | null> | null = null;
let holders = 0;

export const reveal = {
  get on() {
    return on;
  },
  set on(v: boolean) {
    on = v;
    save(KEY, v ? '1' : null);
    if (!v) stop();
  },
};

function stop() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
}

function open(): Promise<MediaStream | null> {
  if (stream) return Promise.resolve(stream);
  opening ??= navigator.mediaDevices
    .getUserMedia({ audio: true })
    .then((s) => {
      // A link may have finished while the browser asked.
      if (holders > 0 && on) stream = s;
      else s.getTracks().forEach((t) => t.stop());
      return s;
    })
    .finally(() => (opening = null));
  return opening;
}

/**
 * Opens the microphone, if the option is on, until the returned function is
 * called. Waits for the answer to the browser's question.
 */
export async function holdMic(d: Diag | null): Promise<() => void> {
  if (!on || typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return () => {};
  holders++;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (--holders === 0) stop();
  };
  try {
    await open();
    d?.add('микрофон открыт, чтобы показать адрес');
  } catch (e) {
    d?.add(`микрофон не дали: ${(e as Error)?.name ?? String(e)}`);
  }
  return release;
}

/** Asks for the microphone now, from a tap, so the question is not lost. */
export async function askMic(): Promise<string> {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    return '';
  } catch (e) {
    return (e as Error)?.name ?? String(e);
  }
}
