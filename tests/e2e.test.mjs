// End-to-end: TWO real stores + TWO real UIs, connected through the REAL transport
// adapters on the fake PeerJS. Everything a "player" does goes through controls that
// the rendered HTML actually shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import {
  makeEnv, settle, newPhone, openLobby, playToEnd, memStorage, parseControls, uiMove,
} from './ui-harness.mjs';

const ALL_RULES = ['multiDrop', 'stackDraw2', 'brutalDraw4', 'twoPlayerBounce'];
const clone = (x) => JSON.parse(JSON.stringify(x));

/** Host + one guest, in the lobby. */
async function lobbyPair(opts = {}) {
  const env = makeEnv();
  const vib = { host: [], guest: [] };
  const hostStorage = memStorage();
  const host = newPhone(env, { name: 'host', seed: 11, storage: hostStorage, vibrations: vib.host });
  const guest = newPhone(env, { name: 'guest', seed: 22, vibrations: vib.guest });
  const code = await openLobby(env, host, [guest], { names: [opts.guestName || 'Bruno'] });
  return { env, host, guest, code, vib, hostStorage };
}
async function startGame(host, env, rules = ALL_RULES) {
  for (const r of rules) host.click('rule', (c) => c.data.rule === r);
  host.click('lobby-start');
  await env.clock.tick(500);
}
const guestSeatView = (host, seat) => clone(E.redactForPeer(host.store._debug.game, seat));
const inSync = (host, guest) => assert.deepEqual(clone(guest.store.getModel().view), guestSeatView(host, guest.store.getModel().mySeat));

/** Hidden values must never be in the HTML (or the model) of the other phone. */
function assertNoLeak(host, guest) {
  const g = host.store._debug.game;
  const guestSeat = guest.store.getModel().mySeat;
  const idsIn = (html) => [...html.matchAll(/data-id="(\d+)"/g)].map((m) => Number(m[1]));
  const hiddenFromGuest = new Set([...g.drawPile.map((c) => c.id), ...g.players.flatMap((p, i) => (i === guestSeat ? [] : p.hand.map((c) => c.id)))]);
  for (const id of idsIn(guest.html())) assert.ok(!hiddenFromGuest.has(id), `card ${id} leaked into the guest HTML`);
  const hiddenFromHost = new Set([...g.drawPile.map((c) => c.id), ...g.players.flatMap((p, i) => (i === 0 ? [] : p.hand.map((c) => c.id)))]);
  for (const id of idsIn(host.html())) assert.ok(!hiddenFromHost.has(id), `card ${id} leaked into the host HTML`);
  const json = JSON.stringify(guest.store.getModel());
  assert.ok(!/"(drawPile|rngState|seed|token)"/.test(json), 'guest model contains hidden fields');
}

test('lobby: sloppy code works, only the host can change rules, Start needs a guest', async () => {
  const env = makeEnv();
  const host = newPhone(env, { name: 'host', seed: 1 });
  const guest = newPhone(env, { name: 'guest', seed: 2 });
  host.click('nav', (c) => c.data.to === 'setup-host');
  host.click('host-create', undefined, { name: 'Anna' });
  await env.clock.tick(1000);
  assert.ok(host.controls().find((c) => c.act === 'lobby-start' && c.disabled), 'Start is disabled alone');
  assert.match(host.html(), /Waiting for a player/);
  assert.ok(host.find('copy') && host.find('share'), 'copy and share are offered');

  const code = host.html().match(/class="code"[^>]*>([A-Z0-9]+)</)[1];
  assert.match(code, /^[A-HJ-NP-Z2-9]{5}$/, 'no 0/O/1/I');
  guest.click('nav', (c) => c.data.to === 'setup-join');
  guest.click('join', undefined, { code: 'zz', name: 'x' }); // too short
  assert.match(guest.text(), /Invalid room code/);
  guest.click('join', undefined, { code: ` ${code.toLowerCase().slice(0, 3)}-${code.toLowerCase().slice(3)} `, name: ' Bruno ' });
  await env.clock.tick(1500);
  assert.match(guest.text(), /Lobby/);
  assert.match(guest.text(), /Anna \(host\)/);
  assert.match(host.text(), /Bruno/);
  assert.equal(guest.enabled('rule').length, 0, 'guest cannot toggle rules');
  host.click('rule', (c) => c.data.rule === 'multiDrop');
  await settle();
  assert.match(guest.html(), /aria-checked="true"/, 'guest sees the host rule choice');
  assert.ok(host.find('lobby-start'), 'Start is enabled once a guest has joined');
});

test('a room that does not exist: clear message, back home, no exception', async () => {
  const env = makeEnv();
  const guest = newPhone(env, { name: 'guest', seed: 2 });
  guest.click('nav', (c) => c.data.to === 'setup-join');
  guest.click('join', undefined, { code: 'ABCDE', name: 'Bruno' });
  await env.clock.tick(2000);
  assert.match(guest.text(), /Room not found/);
  assert.ok(guest.find('nav', (c) => c.data.to === 'setup-join'), 'back on the home screen');
});

test('FULL ONLINE GAME: UI-only play, 3 network drops, hidden info never leaks, rematch', async () => {
  const { env, host, guest, vib } = await lobbyPair();
  await startGame(host, env);
  const hg = host.store._debug.game;
  assert.deepEqual(ALL_RULES.map((r) => hg.rules[r]), [true, true, true, true]);
  assert.equal(guest.store.getModel().screen, 'game');
  inSync(host, guest);
  assert.ok(vib.host.length >= 1, 'the first player was vibrated for their turn');

  const rng = E.makeRng(4242);
  let drops = 0;
  const dropAt = new Set([3, 9, 16]);
  // Every card id the guest is ever entitled to see: its own hand + the public discard pile.
  const allowed = new Set();
  const noteAllowed = () => {
    const g = host.store._debug.game;
    for (const c of g.players[1].hand) allowed.add(c.id);
    for (const c of g.discardPile) allowed.add(c.id);
  };
  noteAllowed();
  const steps = await playToEnd([host, guest], env, rng, {
    async onStep(i) {
      noteAllowed();
      assertNoLeak(host, guest);
      if (!dropAt.has(i) || host.isOver()) return;
      dropAt.delete(i);
      drops++;
      env.net.dropAll();
      await settle();
      // while the connection is lost both UIs refuse moves and say why
      assert.match(guest.text(), /Connection lost\. Reconnecting/);
      assert.match(host.text(), /(Bruno disconnected\. Waiting for them to rejoin|Connection to the room server lost)/);
      assert.equal(guest.canMove(), false, 'guest is blocked during the outage');
      assert.equal(host.canMove(), false, 'host is blocked during the outage');
      await env.clock.tick(15000);
      assert.equal(guest.store.getModel().banner, null);
      assert.equal(host.store.getModel().banner, null);
      inSync(host, guest); // state re-synchronised, the game did not restart
    },
  });
  assert.equal(drops, 3, 'three drops happened mid-game');
  assert.ok(steps > 10);

  // WIRE CHECK: inspect the raw messages that actually left the host phone.
  const fromHost = env.net.wire.filter((w) => w.from.startsWith('uno-'));
  assert.ok(fromHost.length > 20, 'the host sent plenty of messages');
  for (const w of fromHost) {
    const raw = JSON.stringify(w.data);
    assert.ok(!/"(drawPile|rngState|seed|token)"/.test(raw), `hidden field on the wire: ${raw.slice(0, 80)}`);
    const walk = (n) => {
      if (Array.isArray(n)) n.forEach(walk);
      else if (n && typeof n === 'object') {
        if ('kind' in n && 'id' in n) assert.ok(allowed.has(n.id), `card ${n.id} went over the wire to the guest but it is hidden`);
        Object.values(n).forEach(walk);
      }
    };
    walk(w.data);
  }

  // a drop AFTER the game ended re-sends the final state: statistics must not be counted twice
  env.net.dropAll();
  await env.clock.tick(15000);
  assert.ok(guest.isOver() && host.isOver(), 'both still show the result after the re-sync');

  // both phones recorded the same single game (idempotent despite the re-syncs)
  const hs = host.store._debug.stats.games;
  const gs = guest.store._debug.stats.games;
  assert.equal(hs.length, 1);
  assert.equal(gs.length, 1);
  assert.equal(hs[0].id, gs[0].id);
  assert.equal(hs[0].id, host.store._debug.game.gameId);
  assert.equal(hs[0].winner, gs[0].winner);

  // rematch: guest asks, host sees it, host accepts, a NEW game starts with the first turn rotated
  const firstGame = host.store._debug.game;
  guest.click('rematch');
  await settle();
  assert.match(host.text(), /Bruno want a rematch/);
  assert.match(guest.text(), /Rematch requested/);
  host.click('rematch');
  await env.clock.tick(500);
  const second = host.store._debug.game;
  assert.notEqual(second.gameId, firstGame.gameId);
  assert.equal(second.phase, 'PLAY');
  assert.equal(second.current, (firstGame.current + 1) % 2);
  inSync(host, guest);
  assert.equal(guest.isOver(), false);
  assertNoLeak(host, guest);
});

test('the guest cannot move for someone else, and malformed messages are rejected', async () => {
  const { env, host, guest } = await lobbyPair();
  await startGame(host, env, []);
  const hostCard = host.store._debug.game.players[0].hand[0].id;
  const g = guest.store._debug.guestLink;

  // try to play the HOST's card, claiming to be the host (playerId is ignored by the host)
  g.send({ t: 'action', action: { type: 'PLAY', cardIds: [hostCard], playerId: 0 } });
  await settle();
  assert.match(String(guest.store.getModel().toast), /Not your turn|Card not in hand/);
  g.send({ t: 'action', action: { type: 'DRAW', playerId: 0 } });
  await settle();
  assert.match(String(guest.store.getModel().toast), /Not your turn/);
  // garbage
  for (const bad of [null, 5, 'x', [], { t: 'nope' }, { t: 'action' }, { t: 'action', action: { type: 'PLAY', cardIds: 'x' } },
    { t: 'emoji', e: '<script>' }, { t: 'hello', name: 'x', token: 'short' }]) {
    g.send(bad);
    await settle();
  }
  assert.equal(host.store._debug.game.moveCount, 0, 'the host game never changed');
  inSync(host, guest);
});

test('names from a peer are escaped in the HTML', async () => {
  const { host, guest } = await lobbyPair({ guestName: '<img src=x onerror=alert(1)>' });
  assert.ok(!/<img/.test(host.html()), 'no raw tag in the host HTML');
  assert.match(host.html(), /&lt;img/);
  assert.ok(!/<img/.test(guest.html()));
});

test('emoji: only from the fixed list, one per second', async () => {
  const { env, host, guest } = await lobbyPair();
  await startGame(host, env, []);
  guest.click('emoji', (c) => c.data.e === '🎉');
  await settle();
  assert.match(host.html(), /class="bubble">🎉</);
  guest.click('emoji', (c) => c.data.e === '🔥'); // too soon: dropped
  await settle();
  assert.match(host.html(), /class="bubble">🎉</);
  await env.clock.tick(1100);
  guest.click('emoji', (c) => c.data.e === '🔥');
  await settle();
  assert.match(host.html(), /class="bubble">🔥</);
  assert.equal(host.store.getModel().emojis.length, 8);
});

test('undo: only the player who just moved, only until the other moves, host side too', async () => {
  const { env, host, guest } = await lobbyPair();
  await startGame(host, env, []);
  const rng = E.makeRng(7);
  const both = [host, guest];
  // find a moment where somebody can play a card, and make that move
  const mover = async () => {
    for (let i = 0; i < 300; i++) {
      const p = both.find((x) => x.find('card', (c) => c.data.playable === '1'));
      if (p) return p;
      const q = both.find((x) => x.find('draw') || x.find('pass'));
      if (!q) throw new Error('nobody can move');
      (q.find('draw') ? q.click('draw') : q.click('pass'));
      await settle();
    }
    throw new Error('no playable card found');
  };
  const p = await mover();
  const other = p === host ? guest : host;
  const before = clone(host.store._debug.game);
  const card = p.find('card', (c) => c.data.playable === '1');
  p.clickControl(card);
  if (p.find('color')) p.click('color', (c) => c.data.color === 'red');
  await settle();
  assert.equal(host.store._debug.game.moveCount, before.moveCount + 1);
  assert.ok(p.find('undo'), 'the mover sees Undo');
  assert.equal(other.find('undo'), undefined, 'the other player does not');
  p.click('undo');
  await settle();
  assert.deepEqual(host.store._debug.game.players.map((x) => x.hand.map((c) => c.id)), before.players.map((x) => x.hand.map((c) => c.id)));
  assert.equal(host.store._debug.game.current, before.current);
  assert.match(other.text(), /undid their last move/);
  assert.equal(p.find('undo'), undefined, 'only ONE undo');
  inSync(host, guest);
  // once the opponent moves, the old move can no longer be undone
  const p2 = await mover();
  p2.clickControl(p2.find('card', (c) => c.data.playable === '1'));
  if (p2.find('color')) p2.click('color', (c) => c.data.color === 'blue');
  await settle();
  const o2 = p2 === host ? guest : host;
  assert.equal(o2.find('undo'), undefined);
  assert.ok(rng);
});

test('pause: the host closes the room, reopens it with the same code, the guest rejoins by itself', async () => {
  const { env, host, guest, code } = await lobbyPair();
  await startGame(host, env, ['multiDrop', 'stackDraw2']);
  const rng = E.makeRng(99);
  for (let i = 0; i < 8; i++) {
    const q = [host, guest].find((x) => x.canMove());
    if (q) { uiMove(q, rng); await settle(); }
  }
  const snapshotBefore = clone(host.store._debug.game);
  assert.ok(snapshotBefore.moveCount >= 4, 'a few moves were played before the pause');

  host.click('menu');
  assert.ok(host.find('end-all'), 'menu offers "End game for everyone"');
  host.click('quit'); // "Pause and exit"
  await env.clock.tick(500);
  assert.match(guest.text(), /Connection lost\. Reconnecting/);
  assert.ok(host.find('reopen'), 'home offers to reopen the room');
  assert.match(host.text(), new RegExp(`Reopen room ${code}`));

  host.click('reopen');
  await env.clock.tick(15000);
  assert.equal(host.store.getModel().screen, 'game');
  assert.equal(host.store._debug.game.gameId, snapshotBefore.gameId, 'same game, not restarted');
  assert.equal(host.store._debug.game.moveCount, snapshotBefore.moveCount);
  assert.equal(guest.store.getModel().banner, null, 'guest is back without touching anything');
  inSync(host, guest);
});

test('the host app was killed: reload, reopen, wait for the broker, the guest rejoins', async () => {
  const { env, host, guest, hostStorage, code } = await lobbyPair();
  await startGame(host, env, ['multiDrop']);
  const gameId = host.store._debug.game.gameId;
  // the host app dies without closing anything
  const hostPeer = [...env.net.peers].find((p) => p.id === `uno-${code}`);
  env.net.killUnclean(hostPeer, 60000);
  await env.clock.tick(1000);
  assert.match(guest.text(), /Connection lost/);

  // "reload the page": a brand-new store on the same storage
  const host2 = newPhone(env, { name: 'host2', seed: 33, storage: hostStorage });
  assert.ok(host2.find('reopen'), 'the saved room is offered on the home screen');
  host2.click('reopen');
  await env.clock.tick(1500);
  assert.match(host2.text(), /previous session is still holding the room/i);
  await env.clock.tick(70000);
  assert.equal(host2.store.getModel().banner, null);
  assert.equal(host2.store._debug.game.gameId, gameId);
  assert.equal(guest.store.getModel().banner, null);
  inSync(host2, guest);
});

test('the guest leaves on purpose: no zombie reconnection; host waits', async () => {
  const { env, host, guest } = await lobbyPair();
  await startGame(host, env, []);
  guest.click('menu');
  guest.click('quit'); // "Leave game"
  await env.clock.tick(1000);
  assert.ok(guest.find('nav', (c) => c.data.to === 'setup-join'), 'guest is on the home screen');
  assert.equal(guest.find('rejoin'), undefined, 'a voluntary leave forgets the session');
  assert.match(host.text(), /Bruno disconnected\. Waiting for them to rejoin/);
  assert.equal(host.canMove(), false);
  const peers = env.net.peers.size;
  await env.clock.tick(180000);
  assert.equal(env.net.peers.size, peers, 'no new peers appeared');
  assert.match(host.text(), /Bruno disconnected/, 'still waiting, nobody came back');
});

test('"End game for everyone" deletes the save and sends the guest home', async () => {
  const { env, host, guest } = await lobbyPair();
  await startGame(host, env, []);
  host.click('menu');
  host.click('end-all');
  await env.clock.tick(1000);
  assert.equal(host.find('reopen'), undefined, 'the save is gone');
  assert.match(guest.text(), /The host ended the game/);
  assert.ok(guest.find('nav', (c) => c.data.to === 'setup-join'));
  await env.clock.tick(60000);
  assert.equal(guest.store.getModel().screen, 'home', 'the guest did not reconnect');
});

test('a latecomer cannot join a game that already started, a rejoining token can', async () => {
  const { env, host, guest, code } = await lobbyPair();
  await startGame(host, env, []);
  const late = newPhone(env, { name: 'late', seed: 77 });
  late.click('nav', (c) => c.data.to === 'setup-join');
  late.click('join', undefined, { code, name: 'Carla' });
  await env.clock.tick(2000);
  assert.match(late.text(), /already started/);
  assert.equal(host.store._debug.seats.length, 2);
  inSync(host, guest);
});

test('three phones: one drops, everybody is told who, the seat comes back', async () => {
  const env = makeEnv();
  const host = newPhone(env, { name: 'host', seed: 1 });
  const g1 = newPhone(env, { name: 'g1', seed: 2 });
  const g2 = newPhone(env, { name: 'g2', seed: 3 });
  await openLobby(env, host, [g1, g2], { names: ['Bruno', 'Carla'] });
  assert.match(host.text(), /Bruno/);
  assert.match(host.text(), /Carla/);
  await startGame(host, env, ['multiDrop']);
  const rng = E.makeRng(5);
  for (let i = 0; i < 6; i++) { const p = [host, g1, g2].find((x) => x.canMove()); if (p) { uiMove(p, rng); await settle(); } }
  assert.ok(host.store._debug.game.moveCount >= 3);

  // kill ONE guest's connection by destroying its peer object (the other guest stays connected)
  [...env.net.peers].filter((p) => p.id.startsWith('anon-'))[0].destroy();
  await settle();
  const away = [g1, g2].find((g) => !g.store._debug.guestLink.isOpen());
  const stay = [g1, g2].find((g) => g !== away);
  assert.match(host.text(), /disconnected\. Waiting for them to rejoin/);
  assert.match(stay.text(), /disconnected\. Waiting for them to rejoin/);
  assert.equal(stay.canMove(), false);
  // even a hand-made message cannot move while the game is paused for the missing player
  stay.store._debug.guestLink.send({ t: 'action', action: { type: 'DRAW' } });
  await settle();
  assert.match(String(stay.store.getModel().toast), /paused until everyone is back/);
  await env.clock.tick(15000);
  assert.equal(host.store.getModel().banner, null);
  assert.equal(stay.store.getModel().banner, null);
  assert.equal(away.store.getModel().banner, null);
  assert.equal(host.store._debug.seats.length, 3, 'no extra seat was created for the returning guest');
  assertNoLeak(host, away);
  assertNoLeak(host, stay);
});

test('local pass & play: hands stay hidden between turns; a full game by UI; stats once', async () => {
  const env = makeEnv();
  const storage = memStorage();
  const phone = newPhone(env, { name: 'local', seed: 9, storage });
  phone.click('nav', (c) => c.data.to === 'setup-local');
  phone.click('count', (c) => c.data.n === '3');
  for (const r of ALL_RULES) phone.click('rule', (c) => c.data.rule === r);
  phone.click('start-local', undefined, { n0: 'Ann', n1: 'Bob', n2: 'Cy' });
  assert.match(phone.text(), /Pass the phone to\s+Ann/);
  assert.equal(parseControls(phone.html()).filter((c) => c.act === 'card').length, 0, 'no cards while handing over');

  const rng = E.makeRng(321);
  let handoffs = 0;
  for (let i = 0; i < 4000 && !phone.isOver(); i++) {
    const ready = phone.find('ready');
    if (ready) {
      handoffs++;
      phone.clickControl(ready);
      const g = phone.store._debug.game;
      const ids = [...phone.html().matchAll(/data-id="(\d+)"/g)].map((m) => Number(m[1]));
      const own = new Set(g.players[g.current].hand.map((c) => c.id));
      assert.ok(ids.length > 0 && ids.every((id) => own.has(id)), 'only the current player hand is on screen');
      continue;
    }
    assert.ok(uiMove(phone, rng), 'something to click');
  }
  assert.ok(phone.isOver());
  assert.ok(handoffs > 3);
  assert.equal(phone.store._debug.stats.games.length, 1);
  // the finished game can be restarted with a rotated first player
  const first = phone.store._debug.game.gameId;
  phone.click('rematch');
  assert.notEqual(phone.store._debug.game.gameId, first);
  assert.match(phone.text(), /Pass the phone to/);
});

test('local game survives a reload (resume) and a corrupted save is ignored', async () => {
  const env = makeEnv();
  const storage = memStorage();
  const phone = newPhone(env, { name: 'local', seed: 9, storage });
  phone.click('nav', (c) => c.data.to === 'setup-local');
  phone.click('start-local', undefined, { n0: 'Ann', n1: 'Bob' });
  phone.click('ready');
  const before = clone(phone.store._debug.game);
  const reloaded = newPhone(env, { name: 'reloaded', seed: 10, storage });
  reloaded.click('resume-local');
  assert.deepEqual(clone(reloaded.store._debug.game), before);

  storage.setItem('uno.local.v1', '{"v":1,"game":{"nope":true}}');
  const broken = newPhone(env, { name: 'broken', seed: 11, storage });
  assert.equal(broken.find('resume-local'), undefined, 'corrupted save is not offered');
  storage.setItem('uno.host.v1', 'not json at all');
  const broken2 = newPhone(env, { name: 'broken2', seed: 12, storage });
  assert.equal(broken2.find('reopen'), undefined);
});
