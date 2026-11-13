# Color Rush

A fast UNO-style card game for phones, with four optional house rules.
Plain HTML + JavaScript (ES modules), no build step, no backend, installable as a PWA.

* **Pass & Play** (2–6 players on one phone) works fully **offline**.
* **Online** (2–6 phones) uses direct WebRTC connections through PeerJS 1.5.4. It is loaded from a CDN
  **only** when you open the online mode. No server of your own, nothing to pay for.

## Put it on GitHub Pages (about 2 minutes)

1. Create a repository and upload **the contents of this folder** (so `index.html` is at the root).
2. Repository **Settings → Pages → Build and deployment → Deploy from a branch → `main` / `(root)` → Save**.
3. After a minute the game is at `https://<your-user>.github.io/<repository>/`. Open it on your phones.
   (HTTPS is required for the service worker and for WebRTC; GitHub Pages provides it.)
4. On a phone: browser menu → **Add to Home Screen** to install it.

When you update the files, **change `CACHE_VERSION` in `sw.js`**, otherwise phones keep the old cached copy.

## How to play online

1. Host: **Host an online game** → enter a name → **Create room** → share the 5-character code (Copy / Share).
2. Host picks the house rules in the lobby. Guest: **Join an online game** → code + name.
   The code is forgiving: lowercase, spaces and dashes are fine.
3. The host presses **Start** once somebody has joined.

If a phone loses connection, the game pauses and shows who is missing; everybody reconnects by itself.
The host can **Pause and exit** (the game stays saved) and later **Reopen room** with the same code.
The broker may keep the old room busy for up to a minute; the app retries for about 80 seconds.

## House rules (toggle before the game starts)

| Rule | What it does |
|---|---|
| Multi-Drop | Play several cards with the same number/symbol at once (e.g. Blue 5 + Red 5). The first card must be legal; the last one sets the color. |
| Stacking +2 | A +2 can be answered with another +2; the penalty adds up (2 → 4 → 6 …) until someone draws. |
| Brutal +4 | A +4 can go on a +4 and on a +2. A +2 can **never** go on a +4. |
| 2-player Skip bounce | With two players, Skip and Reverse give the player who dropped it another turn. |

Not included: the official "challenge a Wild Draw Four" rule, the "UNO!" call, and scoring by cards left.
A winning +2/+4 ends the game immediately (the penalty is not applied).

## Honest limits

* **WebRTC may not connect on some networks** (strict corporate Wi-Fi, some mobile carriers) because
  there is no relay server of our own. Try Wi-Fi on both phones if it fails. This cannot be guaranteed.
* The free PeerJS broker is a shared community service: it can be slow or down, and it is not meant for
  heavy use.
* The host phone is the "server": if its page is closed or the phone sleeps, the game pauses. The app asks
  the browser to keep the screen on (Wake Lock) where supported. Vibration does not work on iOS Safari.
* The PeerJS script is pinned to version 1.5.4 but has no integrity hash (SRI).

## Project layout

```
index.html, css/app.css, manifest.webmanifest, sw.js, icons/
src/engine.js     pure game rules: seeded RNG, state machine, penalty accumulator, redactForPeer
src/protocol.js   message validation (whitelists), room codes, HTML escaping
src/transport.js  PeerJS adapters (host room / guest link), heartbeat, reconnection
src/store.js      local | host | guest modes, commit(), saving, statistics, undo, emoji
src/ui.js         render(model) -> HTML, act(store, name, data)
src/app.js        the only file that touches the DOM and browser APIs
tests/            node:test suites, a fake PeerJS (mock-peer.js), a real-browser test
tools/            icon generator, tiny static server
```

## Tests

```
npm test               # 80+ tests: rules, determinism, hidden-info, hostile input, transport, two phones end to end
npm run test:browser   # real Chromium, two tabs, fake PeerJS on BroadcastChannel, light + dark, offline
npm run serve          # http://localhost:8080/ to try it locally
```

The real PeerJS broker and real WebRTC are **not** exercised by the tests (they need the internet);
the tests use a faithful fake. Please do one real game on two phones after deploying.
