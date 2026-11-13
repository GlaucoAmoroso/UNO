// REAL CHROME test: two tabs play a whole online game through the real app.
//  * a local static server serves the app
//  * page.route REPLACES the PeerJS script on the CDN with a fake built on BroadcastChannel
//  * the game is played ONLY by clicking controls that are on screen
//  * light theme, then dark theme; a network drop in the middle; zero console errors
//  * then the offline Pass & Play (service worker) is checked
// Run: node tests/browser/chrome.e2e.mjs   (env SHOTS=/some/dir to keep screenshots)
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { startServer } from '../../tools/static-server.mjs';
import { makeRng } from '../../src/engine.js';

const { chromium } = createRequire(import.meta.url)('playwright');
const root = path.resolve(new URL('../..', import.meta.url).pathname);
const fakeSrc = fs.readFileSync(path.join(root, 'tests/browser/fake-peerjs.js'), 'utf8');
const SHOTS = process.env.SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('  •', ...a);
const problems = [];

const { server, port } = await startServer(root, 0);
const url = `http://127.0.0.1:${port}/`;
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light',
});

let cdnHits = [];
await context.route('https://unpkg.com/**', (route) => {
  cdnHits.push(route.request().url());
  route.fulfill({ status: 200, contentType: 'application/javascript', body: fakeSrc });
});

function watch(page, name) {
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${name}] console.${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${name}] pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`[${name}] request failed: ${r.url()} ${r.failure() && r.failure().errorText}`));
}
const shot = async (page, name) => { if (SHOTS) { await page.waitForTimeout(1300); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); } };

// ---------- a "finger": decisions are made only from what the page shows ----------
const snapshot = (page) => page.evaluate(() => ({
  over: document.body.innerText.includes(' wins!'),
  controls: [...document.querySelectorAll('[data-act]')].map((el) => ({
    act: el.dataset.act, disabled: !!el.disabled, id: el.dataset.id, color: el.dataset.color, playable: el.dataset.playable, cls: el.className, label: el.textContent.trim(),
  })),
}));
// Cards overlap in the fan, so (like a thumb) the test taps the always-visible index corner of a card.
const sel = (c) => (c.act === 'card' ? `[data-act="card"][data-id="${c.id}"] .corner:first-child` : c.act === 'color' ? `[data-act="color"][data-color="${c.color}"]` : `[data-act="${c.act}"]`);

function decide(controls, rng) {
  const pick = (a) => a[Math.floor(rng.next() * a.length)];
  const on = (act) => controls.filter((c) => c.act === act && !c.disabled);
  const colors = on('color');
  if (colors.length) return pick(colors);
  const cards = on('card');
  const play = on('play')[0];
  if (play) {
    const partners = cards.filter((c) => /\bpartner\b/.test(c.cls));
    return partners.length && rng.next() < 0.5 ? pick(partners) : play;
  }
  const pass = on('pass')[0];
  if (pass && rng.next() < 0.2) return pass;
  const playable = cards.filter((c) => c.playable === '1');
  if (playable.length) return pick(playable);
  return pass || on('draw')[0] || null;
}

async function playOut(pages, rng, { maxSteps = 1500, onStep } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    const snaps = await Promise.all(pages.map(snapshot));
    if (snaps.every((s) => s.over)) return i;
    let moved = false;
    for (let k = 0; k < pages.length && !moved; k++) {
      if (snaps[k].over) continue;
      const mv = decide(snaps[k].controls, rng);
      if (mv) { await pages[k].click(sel(mv)); moved = true; }
    }
    if (onStep) await onStep(i);
    await sleep(moved ? 15 : 120);
  }
  throw new Error('the game did not finish in time');
}
const click = (page, act, extra = '') => page.click(`[data-act="${act}"]${extra}`);
const waitText = (page, text, timeout = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), text, { timeout });

const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`); } catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${e.message}`); }
};

try {
  // ===== 1. first load: no CDN request until online mode is opened =====
  const host = await context.newPage(); watch(host, 'host');
  const guest = await context.newPage(); watch(guest, 'guest');
  await host.goto(url); await guest.goto(url);

  await check('home screen renders and PeerJS is NOT requested yet', async () => {
    await waitText(host, 'Color Rush');
    assert.equal(cdnHits.length, 0, 'the CDN script was requested before online mode');
    assert.ok(await host.locator('[data-act="nav"]').count() >= 3);
    await shot(host, '01-home-light');
  });

  // ===== 2. lobby =====
  let code = '';
  await check('host creates a room; PeerJS 1.5.4 is requested only now', async () => {
    await click(host, 'nav', '[data-to="setup-host"]');
    await host.fill('[data-field="name"]', 'Anna');
    await click(host, 'host-create');
    await host.waitForSelector('.code', { timeout: 10000 });
    await host.waitForFunction(() => !document.querySelector('.banner'), null, { timeout: 10000 });
    code = (await host.textContent('.code')).trim();
    assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/);
    assert.deepEqual(cdnHits, [PEERJS_URL], 'exactly the pinned PeerJS URL');
    await shot(host, '02-lobby-host-light');
  });

  await check('guest joins with a sloppy code (lowercase + spaces) and both see the lobby', async () => {
    await click(guest, 'nav', '[data-to="setup-join"]');
    await guest.fill('[data-field="code"]', ` ${code.slice(0, 2).toLowerCase()} ${code.slice(2).toLowerCase()} `);
    await guest.fill('[data-field="name"]', 'Bruno');
    await click(guest, 'join');
    await waitText(guest, 'Anna', 15000);
    await waitText(host, 'Bruno', 15000);
    await shot(guest, '03-lobby-guest-light');
  });

  await check('host sets all four house rules, guest sees them, Start works', async () => {
    for (const r of ['multiDrop', 'stackDraw2', 'brutalDraw4', 'twoPlayerBounce']) await host.click(`[data-act="rule"][data-rule="${r}"]`);
    await guest.waitForFunction(() => document.querySelectorAll('.toggle.on').length === 4, null, { timeout: 5000 });
    assert.equal(await guest.locator('[data-act="rule"]:not([disabled])').count(), 0, 'guest cannot change rules');
    await click(host, 'lobby-start');
    await host.waitForSelector('.hand .card', { timeout: 8000 });
    await guest.waitForSelector('.hand .card', { timeout: 8000 });
    await shot(host, '04-game-host-light');
    await shot(guest, '05-game-guest-light');
  });

  // ===== 3. a whole game, light theme, with a network drop in the middle =====
  const rng = makeRng(2026);
  await check('full game in LIGHT theme, with a network drop on the host mid-game', async () => {
    let dropped = false;
    const steps = await playOut([host, guest], rng, {
      async onStep(i) {
        if (i === 12 && !dropped) {
          dropped = true;
          await host.evaluate(() => window.__fakePeerDrop());
          await sleep(300);
          const txt = await guest.evaluate(() => document.body.innerText);
          assert.match(txt, /(Connection lost|disconnected)/, 'guest is told the connection is lost');
          await shot(guest, '06-guest-connection-lost');
          await host.waitForFunction(() => !document.querySelector('.banner'), null, { timeout: 30000 });
          await guest.waitForFunction(() => !document.querySelector('.banner'), null, { timeout: 30000 });
        }
      },
    });
    assert.ok(dropped, 'the drop happened');
    assert.ok(steps > 10);
    await shot(host, '07-gameover-light');
  });

  await check('both phones show the same winner and recorded one game', async () => {
    const a = await host.evaluate(() => document.querySelector('.sheet.over h2').textContent);
    const b = await guest.evaluate(() => document.querySelector('.sheet.over h2').textContent);
    assert.equal(a, b);
    const ga = await host.evaluate(() => JSON.parse(localStorage.getItem('uno.stats.v1')).games.length);
    assert.equal(ga, 1);
  });

  // ===== 4. rematch in DARK theme =====
  await host.emulateMedia({ colorScheme: 'dark' });
  await guest.emulateMedia({ colorScheme: 'dark' });
  await check('rematch, then a full game in DARK theme', async () => {
    const lightBg = null;
    await click(guest, 'rematch');
    await waitText(host, 'Bruno want a rematch', 8000);
    await click(host, 'rematch');
    await host.waitForSelector('.hand .card', { timeout: 8000 });
    await guest.waitForSelector('.hand .card', { timeout: 8000 });
    const bg = await host.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(bg, lightBg);
    const rgb = bg.match(/\d+/g).map(Number);
    assert.ok(rgb[0] < 60 && rgb[1] < 60 && rgb[2] < 60, `body is dark in dark theme (got ${bg})`);
    await shot(host, '08-game-host-dark');
    await shot(guest, '09-game-guest-dark');
    const steps = await playOut([host, guest], rng);
    assert.ok(steps > 5);
    await shot(guest, '10-gameover-dark');
    const games = await host.evaluate(() => JSON.parse(localStorage.getItem('uno.stats.v1')).games.length);
    assert.equal(games, 2, 'two games recorded, once each');
  });

  await check('menu opens in dark theme and the theme can be forced to light', async () => {
    await click(host, 'quit'); // game-over "Home" button
    await host.waitForSelector('[data-act="nav"]');
    await click(host, 'menu');
    await host.waitForSelector('.sheet');
    await shot(host, '11-menu-dark');
    await click(host, 'theme'); // auto -> light
    await host.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    const bg = await host.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const rgb = bg.match(/\d+/g).map(Number);
    assert.ok(rgb[0] > 200, `forced light theme overrides the dark system theme (got ${bg})`);
    await click(host, 'theme'); await click(host, 'theme'); // back to auto
  });

  // ===== 5. offline Pass & Play via the service worker =====
  await check('service worker: Pass & Play works fully OFFLINE after a reload', async () => {
    const page = await context.newPage(); watch(page, 'offline');
    await page.goto(url);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.evaluate(async () => { const keys = await caches.keys(); return keys; });
    await page.waitForFunction(async () => (await caches.keys()).length > 0 && (await (await caches.open((await caches.keys())[0])).keys()).length >= 14, null, { timeout: 15000 });
    await page.reload(); // now controlled by the service worker
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
    const before = cdnHits.length;
    await context.setOffline(true);
    await page.reload();
    await waitText(page, 'Color Rush');
    await click(page, 'nav', '[data-to="setup-local"]');
    await page.click('[data-act="count"][data-n="3"]');
    await page.fill('[data-field="n0"]', 'Ann'); await page.fill('[data-field="n1"]', 'Bob'); await page.fill('[data-field="n2"]', 'Cy');
    await click(page, 'start-local');
    await waitText(page, 'Pass the phone to');
    await shot(page, '12-handoff-offline');
    const r2 = makeRng(5);
    let moves = 0;
    for (let i = 0; i < 400 && !(await snapshot(page)).over && moves < 40; i++) {
      const s = await snapshot(page);
      const ready = s.controls.find((c) => c.act === 'ready' && !c.disabled);
      if (ready) { await page.click(sel(ready)); continue; }
      const mv = decide(s.controls, r2);
      if (mv) { await page.click(sel(mv)); moves++; }
    }
    assert.ok(moves >= 20, `played ${moves} moves offline`);
    assert.equal(cdnHits.length, before, 'no network request was made for local play');
    await shot(page, '13-local-game-offline');
    await context.setOffline(false);
    await page.close();
  });

  await check('no console errors, warnings or failed requests in any tab', async () => {
    assert.deepEqual(problems, []);
  });
} finally {
  await browser.close();
  server.close();
}

const failed = results.filter(([, ok]) => !ok);
console.log(`\n${results.length - failed.length}/${results.length} browser checks passed`);
process.exit(failed.length ? 1 : 0);
