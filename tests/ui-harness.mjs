// A "phone" for Node tests: a store + the real UI. It can only click controls that
// appear in the rendered HTML and are not disabled, exactly like a person's finger.
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import { createStore } from '../src/store.js';
import { render, act } from '../src/ui.js';
import { makeEnv, settle } from './mock-peer.js';

const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const unescapeHtml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/** Extracts every <button data-act=...> from an HTML string. */
export function parseControls(html) {
  const out = [];
  const re = /<button\b([^>]*)>([\s\S]*?)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const data = {};
    for (const a of attrs.matchAll(/data-([a-z0-9-]+)="([^"]*)"/g)) data[camel(a[1])] = unescapeHtml(a[2]);
    if (!data.act) continue;
    const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1];
    out.push({
      act: data.act, data, cls,
      disabled: /(^|\s)disabled(\s|=|$)/.test(attrs),
      label: unescapeHtml(m[2].replace(/<[^>]*>/g, '')).trim(),
    });
  }
  return out;
}

export function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

export class Phone {
  constructor(store, name = 'phone') { this.store = store; this.name = name; }
  html() { return render(this.store.getModel()); }
  controls() { return parseControls(this.html()); }
  enabled(actName, pred = () => true) { return this.controls().filter((c) => c.act === actName && !c.disabled && pred(c)); }
  find(actName, pred) { return this.enabled(actName, pred)[0]; }
  /** Click a control by what the screen shows; `fields` = text typed in the inputs. */
  click(actName, pred, fields = {}) {
    const c = this.find(actName, pred);
    assert.ok(c, `${this.name}: no enabled "${actName}" control on screen`);
    return this.clickControl(c, fields);
  }
  clickControl(c, fields = {}) {
    assert.ok(!c.disabled, `${this.name}: control "${c.act}" is disabled`);
    act(this.store, c.act, { ...c.data, ...fields });
    return true;
  }
  isOver() { return /\bwins!/.test(this.html()); }
  text() { return this.html().replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '); }
  /** Can this phone make a game move right now? */
  canMove() { return this.controls().some((c) => !c.disabled && ['card', 'draw', 'pass', 'play', 'color'].includes(c.act)); }
}

/** One UI-driven move with a seeded random choice. Returns true if something was clicked. */
export function uiMove(phone, rng) {
  const pick = (arr) => arr[Math.floor(rng.next() * arr.length)];
  const c = phone.controls();
  const on = (a) => c.filter((x) => x.act === a && !x.disabled);
  const colors = on('color');
  if (colors.length) return phone.clickControl(pick(colors));
  const cards = on('card');
  const playBtn = on('play')[0];
  if (playBtn) {
    const partners = cards.filter((x) => /\bpartner\b/.test(x.cls));
    if (partners.length && rng.next() < 0.5) return phone.clickControl(pick(partners));
    return phone.clickControl(playBtn);
  }
  const pass = on('pass')[0];
  if (pass && rng.next() < 0.2) return phone.clickControl(pass);
  const playable = cards.filter((x) => x.data.playable === '1');
  if (playable.length) return phone.clickControl(pick(playable));
  if (pass) return phone.clickControl(pass);
  const draw = on('draw')[0];
  if (draw) return phone.clickControl(draw);
  return false;
}

/** Test-only seeded random32 (the app uses crypto). */
export function seededRandom32(seed) {
  const r = E.makeRng(seed);
  return () => Math.floor(r.next() * 4294967296) >>> 0;
}

export function newPhone(env, { name, seed, storage, vibrations, transportOptions } = {}) {
  const store = createStore({
    storage: storage || memStorage(),
    timers: env.timers,
    random32: seededRandom32(seed || 1),
    loadPeer: async () => env.Peer,
    vibrate: (ms) => { if (vibrations) vibrations.push(ms); },
    transportOptions: transportOptions || {},
  });
  return new Phone(store, name);
}

export const codeFrom = (html) => {
  const m = html.match(/class="code"[^>]*>([A-HJ-NP-Z2-9]{5})</);
  assert.ok(m, 'no room code on screen');
  return m[1];
};

/** Host creates a room, guests join with sloppy codes, everyone ends up in the lobby. */
export async function openLobby(env, host, guests, { names = [] } = {}) {
  host.click('nav', (c) => c.data.to === 'setup-host');
  host.click('host-create', undefined, { name: 'Anna' });
  await env.clock.tick(1000);
  const code = codeFrom(host.html());
  for (let i = 0; i < guests.length; i++) {
    const g = guests[i];
    g.click('nav', (c) => c.data.to === 'setup-join');
    const sloppy = ` ${code.slice(0, 2).toLowerCase()} ${code.slice(2).toLowerCase()} `; // lowercase + spaces
    g.click('join', undefined, { code: sloppy, name: names[i] || `Guest${i + 1}` });
    await env.clock.tick(1500);
  }
  return code;
}

/** Plays until every phone shows the game-over sheet. Calls onStep(i) between moves. */
export async function playToEnd(phones, env, rng, { maxSteps = 3000, onStep } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    if (phones.every((p) => p.isOver())) return i;
    let moved = false;
    for (const p of phones) {
      if (p.isOver()) continue;
      const ready = p.controls().find((c) => c.act === 'ready' && !c.disabled);
      if (ready) { p.clickControl(ready); moved = true; await settle(); break; }
      if (uiMove(p, rng)) { moved = true; await settle(); break; }
    }
    if (!moved) await env.clock.tick(500); // waiting for a sync or a reconnection
    if (onStep) await onStep(i);
  }
  throw new Error('the game did not finish');
}

export { makeEnv, settle };
