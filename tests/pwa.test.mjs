// Static checks on the deliverable: every file the app needs is in the service worker's
// precache list, the manifest is sound, and the pinned PeerJS URL is the agreed one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const swSrc = read('sw.js');
const precache = [...swSrc.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter((p) => p && !swSrc.includes(`CACHE_VERSION = '${p}'`));

test('service worker precache lists every app module and asset, and they all exist', () => {
  const need = [
    'index.html', 'css/app.css', 'manifest.webmanifest',
    ...fs.readdirSync(path.join(root, 'src')).map((f) => `src/${f}`),
    'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  ];
  for (const f of need) assert.ok(precache.includes(f), `${f} is missing from the precache list`);
  for (const f of precache) assert.ok(fs.existsSync(path.join(root, f)), `${f} is precached but does not exist`);
});

test('the cache has an explicit version and never intercepts cross-origin requests', () => {
  assert.match(swSrc, /const CACHE_VERSION = 'colorrush-[\w-]+';/);
  assert.match(swSrc, /url\.origin !== self\.location\.origin\) return/);
});

test('manifest is valid for installation', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.start_url, './');
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(root, i.src)), `${i.src} exists`);
});

test('index.html uses only relative paths (works under a GitHub Pages sub-folder)', () => {
  const html = read('index.html');
  for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) assert.ok(!m[1].startsWith('/') && !/^https?:/.test(m[1]), `absolute URL: ${m[1]}`);
  for (const f of ['src/app.js', 'src/store.js', 'src/ui.js', 'src/transport.js']) {
    for (const m of read(f).matchAll(/from '(\.[^']+)'/g)) assert.ok(m[1].endsWith('.js'), `${f}: import ${m[1]} needs the .js extension`);
  }
});

test('PeerJS is pinned to 1.5.4 and loaded from one place only', () => {
  const t = read('src/transport.js');
  assert.match(t, /https:\/\/unpkg\.com\/peerjs@1\.5\.4\/dist\/peerjs\.min\.js/);
  for (const f of fs.readdirSync(path.join(root, 'src'))) {
    if (f !== 'transport.js') assert.ok(!/unpkg|cdn\./.test(read(`src/${f}`)), `${f} must not reference a CDN`);
  }
  assert.ok(!/peerjs/i.test(read('index.html')), 'index.html does not load PeerJS up front');
});
