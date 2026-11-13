// Redaction: hidden information must never be present in what a peer receives.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import { configFor, runBotGame } from './helpers.mjs';

const cardIdsIn = (node, out = []) => {
  if (Array.isArray(node)) node.forEach((n) => cardIdsIn(n, out));
  else if (node && typeof node === 'object') {
    if ('kind' in node && 'id' in node) out.push(node.id);
    Object.values(node).forEach((v) => cardIdsIn(v, out));
  }
  return out;
};
const keysIn = (node, out = new Set()) => {
  if (Array.isArray(node)) node.forEach((n) => keysIn(n, out));
  else if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) { out.add(k); keysIn(v, out); }
  }
  return out;
};

/** Collects mid-game states from bot games (every 4th move). */
function sampleStates(gameCount) {
  const samples = [];
  for (let i = 0; i < gameCount; i++) {
    runBotGame(configFor(i), 7000 + i, {
      onStep(s, act, idx) { if (idx % 4 === 0) samples.push(s); },
    });
  }
  return samples;
}

test('a fresh view holds exactly the viewer\'s 7 cards and the top card', () => {
  const s = E.createGame({ playerNames: ['A', 'B', 'C'], gameId: 'game-1' }, 77);
  for (let seat = 0; seat < 3; seat++) {
    const view = E.redactForPeer(s, seat);
    const ids = cardIdsIn(view);
    assert.equal(ids.length, 8);
    assert.deepEqual(new Set(ids), new Set([...s.players[seat].hand.map((c) => c.id), s.discardPile[0].id]));
    assert.equal(view.redacted, true);
    assert.equal(view.drawCount, s.drawPile.length);
  }
});

test('no hidden value ever appears in any view of any mid-game state', () => {
  const samples = sampleStates(60);
  assert.ok(samples.length > 300, 'enough samples');
  for (const s of samples) {
    const seats = [...s.players.map((p) => p.id), null]; // every player + a spectator
    for (const seat of seats) {
      const view = E.redactForPeer(s, seat);
      const forbidden = new Set([
        ...s.drawPile.map((c) => c.id),
        ...s.players.flatMap((p) => (p.id === seat ? [] : p.hand.map((c) => c.id))),
      ]);
      for (const id of cardIdsIn(view)) assert.equal(forbidden.has(id), false, `card ${id} leaked to seat ${seat}`);

      const keys = keysIn(view);
      for (const k of ['seed', 'rngState', 'drawPile']) assert.equal(keys.has(k), false, `${k} leaked`);

      view.players.forEach((p, i) => {
        assert.equal(p.handCount, s.players[i].hand.length);
        assert.equal('hand' in p, p.id === seat, 'only the viewer sees a hand');
      });
      assert.equal(view.discardPile.length, 1);
      assert.equal(view.discardCount, s.discardPile.length);
      if (seat !== s.current) assert.equal(view.drewCard, null, 'drawn card id hidden from others');
      else assert.equal(view.drewCard, s.drewCard);
      assert.deepEqual(JSON.parse(JSON.stringify(view)), view, 'view is plain JSON');
      assert.equal(JSON.stringify(view).includes(`"seed"`), false);
    }
  }
});

test('lastMove never carries card identities for a draw', () => {
  for (const s of sampleStates(20)) {
    if (s.lastMove && s.lastMove.type === 'DRAW') {
      assert.deepEqual(Object.keys(E.redactForPeer(s, 0).lastMove).sort(), ['by', 'count', 'forced', 'seq', 'type']);
    }
  }
});

test('highlight hints computed on a view match the host\'s own computation', () => {
  for (const s of sampleStates(30)) {
    const seat = s.current;
    const view = E.redactForPeer(s, seat);
    const playable = E.getPlayableCardIds(s, seat);
    assert.deepEqual(E.getPlayableCardIds(view, seat), playable);
    for (const id of playable) {
      assert.deepEqual(E.getMultiDropPartners(view, seat, id), E.getMultiDropPartners(s, seat, id));
    }
    const other = (seat + 1) % s.players.length;
    assert.deepEqual(E.getPlayableCardIds(view, other), [], 'not their turn / no hand visible');
  }
});

test('a view is a deep copy and cannot be used to act', () => {
  const s = E.createGame({ playerNames: ['A', 'B'], gameId: 'game-1' }, 5);
  const before = JSON.stringify(s);
  const view = E.redactForPeer(s, 0);
  view.players[0].hand[0].color = 'tampered';
  view.rules.multiDrop = true;
  assert.equal(JSON.stringify(s), before);
  const r = E.applyAction(view, { type: 'DRAW', playerId: 0 });
  assert.equal(r.ok, false);
});

test('redactForPeer refuses bad input', () => {
  const s = E.createGame({ playerNames: ['A', 'B'], gameId: 'game-1' }, 5);
  assert.throws(() => E.redactForPeer(null, 0));
  assert.throws(() => E.redactForPeer(s, 2));
  assert.throws(() => E.redactForPeer(s, -1));
  assert.throws(() => E.redactForPeer(s, '0'));
  assert.throws(() => E.redactForPeer(E.redactForPeer(s, 0), 0), 'cannot redact a view again');
});
