// Hostile input: a guest (or a corrupted save) must never crash the host or corrupt the state.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import { checkInvariants } from './helpers.mjs';

const fresh = () => E.createGame({ playerNames: ['A', 'B', 'C'], gameId: 'game-1', rules: { multiDrop: true } }, 31337);

test('malformed actions are rejected and never touch the state', () => {
  const s = fresh();
  const own = s.players[0].hand[0].id;
  const garbage = [
    undefined, null, 0, 1, 'PLAY', true, [], {}, () => 1,
    { type: 'PLAY' },
    { type: 'PLAY', playerId: '0', cardIds: [own] },
    { type: 'PLAY', playerId: 0 },
    { type: 'PLAY', playerId: 0, cardIds: 'abc' },
    { type: 'PLAY', playerId: 0, cardIds: [] },
    { type: 'PLAY', playerId: 0, cardIds: Array(5000).fill(own) },
    { type: 'PLAY', playerId: 0, cardIds: [NaN] },
    { type: 'PLAY', playerId: 0, cardIds: [1.5] },
    { type: 'PLAY', playerId: 0, cardIds: [-1] },
    { type: 'PLAY', playerId: 0, cardIds: [null] },
    { type: 'PLAY', playerId: 0, cardIds: [{}] },
    { type: 'PLAY', playerId: 0, cardIds: [String(own)] },
    { type: 'PLAY', playerId: 0, cardIds: [999999] },
    { type: 'PLAY', playerId: 0, cardIds: [s.players[1].hand[0].id] },
    { type: 'play', playerId: 0, cardIds: [own] },
    { type: '__proto__', playerId: 0 },
    { type: 'DRAW' },
    { type: 'DRAW', playerId: 1 },
    { type: 'DRAW', playerId: -1 },
    { type: 'DRAW', playerId: 0.5 },
    { type: 'DRAW', playerId: 99 },
    { type: 'PASS', playerId: 0 },
    { type: 'UNDO', playerId: 0 },
  ];
  const before = JSON.stringify(s);
  for (const g of garbage) {
    const r = E.applyAction(s, g);
    assert.equal(r.ok, false, `accepted: ${JSON.stringify(g)}`);
    assert.equal(typeof r.error, 'string');
    assert.equal(r.state, undefined);
  }
  assert.equal(JSON.stringify(s), before);
});

test('malformed states are rejected instead of throwing', () => {
  const act = { type: 'DRAW', playerId: 0 };
  const s = fresh();
  for (const bad of [undefined, null, 0, 'x', [], {}, { players: [] }, { players: [], drawPile: [] }, E.redactForPeer(s, 0)]) {
    const r = E.applyAction(bad, act);
    assert.equal(r.ok, false);
  }
});

test('JSON with a __proto__ key cannot pollute prototypes', () => {
  const s = fresh();
  const evil = JSON.parse('{"__proto__":{"polluted":true},"type":"DRAW","playerId":0}');
  E.applyAction(s, evil);
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.prototype.polluted, undefined);
});

test('3000 random actions: no exception, rejected actions leave no trace, accepted ones keep invariants', () => {
  const rng = E.makeRng(2024);
  const pick = (arr) => arr[Math.floor(rng.next() * arr.length)];
  let s = fresh();
  let accepted = 0;
  for (let i = 0; i < 3000; i++) {
    if (s.phase === E.PHASE.GAME_OVER) { s = fresh(); }
    const seat = rng.next() < 0.7 ? s.current : Math.floor(rng.next() * 6) - 1;
    const hand = s.players[s.current].hand;
    const ids = Array.from({ length: Math.floor(rng.next() * 4) }, () =>
      (rng.next() < 0.6 && hand.length ? pick(hand).id : Math.floor(rng.next() * 130) - 10));
    const act = { type: pick(['PLAY', 'PLAY', 'DRAW', 'PASS', 'NOPE']), playerId: seat, cardIds: ids, chosenColor: pick(['red', 'blue', 'x', undefined, 5]) };
    const before = JSON.stringify(s);
    let r;
    assert.doesNotThrow(() => { r = E.applyAction(s, act); });
    assert.equal(JSON.stringify(s), before, 'input state mutated');
    if (r.ok) { accepted++; checkInvariants(r.state); s = r.state; }
    else assert.equal(typeof r.error, 'string');
  }
  assert.ok(accepted > 300, `only ${accepted} random actions were accepted; the fuzz is too weak`);
});
