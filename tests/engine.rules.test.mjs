// Rules tests: deck, setup, turn flow, and the four house rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';
import { card, mkState, play, playOk, applyOk, checkInvariants } from './helpers.mjs';

const redTop = () => card('red', 'number', 5);
const DRAW = (playerId) => ({ type: 'DRAW', playerId });
const PASS = (playerId) => ({ type: 'PASS', playerId });

// ---------- Deck & setup ----------

test('deck has 108 cards with the standard distribution', () => {
  const d = E.createDeck();
  const count = (f) => d.filter(f).length;
  assert.equal(d.length, 108);
  assert.equal(count((c) => c.kind === 'wild'), 4);
  assert.equal(count((c) => c.kind === 'wild4'), 4);
  assert.equal(count((c) => c.kind === 'number' && c.value === 0), 4);
  for (let v = 1; v <= 9; v++) assert.equal(count((c) => c.kind === 'number' && c.value === v), 8);
  for (const k of ['skip', 'reverse', 'draw2']) assert.equal(count((c) => c.kind === k), 8);
  assert.equal(new Set(d.map((c) => c.id)).size, 108);
});

test('createGame deals 7 cards each and starts on a number card', () => {
  const s = E.createGame({ playerNames: ['A', 'B', 'C'], gameId: 'game-1' }, 42);
  for (const p of s.players) assert.equal(p.hand.length, 7);
  assert.equal(s.discardPile.length, 1);
  assert.equal(s.discardPile[0].kind, 'number');
  assert.equal(s.activeColor, s.discardPile[0].color);
  assert.equal(s.phase, 'PLAY');
  assert.equal(s.current, 0);
  assert.equal(s.lastMove, null);
  checkInvariants(s);
});

test('createGame honours firstPlayer', () => {
  const s = E.createGame({ playerNames: ['A', 'B'], gameId: 'game-1', firstPlayer: 1 }, 7);
  assert.equal(s.current, 1);
});

test('createGame rejects invalid config and seeds', () => {
  const base = { playerNames: ['A', 'B'], gameId: 'game-1' };
  assert.throws(() => E.createGame(null, 1));
  assert.throws(() => E.createGame({ ...base, playerNames: ['A'] }, 1));
  assert.throws(() => E.createGame({ ...base, playerNames: Array(11).fill('x') }, 1));
  assert.throws(() => E.createGame({ ...base, playerNames: 'AB' }, 1));
  assert.throws(() => E.createGame({ ...base, gameId: 'bad id!' }, 1));
  assert.throws(() => E.createGame({ ...base, gameId: undefined }, 1));
  assert.throws(() => E.createGame({ ...base, firstPlayer: 5 }, 1));
  for (const bad of [-1, 1.5, NaN, '5', 2 ** 32, undefined, null]) {
    assert.throws(() => E.createGame(base, bad), `seed ${String(bad)}`);
  }
});

test('house rules are sanitized to strict booleans', () => {
  const s = E.createGame({
    playerNames: ['A', 'B'], gameId: 'game-1',
    rules: { multiDrop: 'yes', stackDraw2: true, brutalDraw4: 1, evil: true },
  }, 1);
  assert.deepEqual(s.rules, { multiDrop: false, stackDraw2: true, brutalDraw4: false, twoPlayerBounce: false });
});

test('player names are cleaned and clamped', () => {
  const s = E.createGame({
    playerNames: ['  Mario\u0000\n  Rossi  ', '', 'x'.repeat(100), 42], gameId: 'game-1',
  }, 1);
  assert.equal(s.players[0].name, 'Mario Rossi');
  assert.equal(s.players[1].name, 'Player 2');
  assert.equal(s.players[2].name.length, E.NAME_MAX_LEN);
  assert.equal(s.players[3].name, 'Player 4');
});

// ---------- Turn flow ----------

test('DRAW: a playable drawn card enters DREW; PASS ends the turn', () => {
  let s = mkState({}, [[], []], redTop());
  const drawn = card('red', 'number', 9);
  s.drawPile.push(drawn); // pop() takes the last element
  s = applyOk(s, DRAW(0));
  assert.equal(s.phase, 'DREW');
  assert.equal(s.drewCard, drawn.id);
  assert.equal(s.current, 0);
  assert.equal(E.applyAction(s, DRAW(0)).ok, false, 'no second draw');
  const filler = s.players[0].hand.find((c) => c.id !== drawn.id);
  assert.equal(play(s, 0, [filler]).ok, false, 'only the drawn card may be played');
  s = applyOk(s, PASS(0));
  assert.equal(s.current, 1);
  assert.equal(s.phase, 'PLAY');
  assert.equal(s.drewCard, null);
});

test('DRAW: an unplayable drawn card passes the turn automatically', () => {
  let s = mkState({}, [[], []], redTop());
  s.drawPile.push(card('blue', 'number', 9));
  s = applyOk(s, DRAW(0));
  assert.equal(s.current, 1);
  assert.equal(s.phase, 'PLAY');
  assert.equal(s.players[0].hand.length, 3);
});

test('PASS is only legal after drawing', () => {
  const s = mkState({}, [[], []], redTop());
  assert.equal(E.applyAction(s, PASS(0)).ok, false);
});

test('DRAW with both piles empty passes the turn and does not mark a hand card as drawn', () => {
  let s = mkState({}, [[card('red', 'number', 1)], []], redTop());
  s.drawPile = [];
  const handBefore = JSON.stringify(s.players[0].hand);
  s = applyOk(s, DRAW(0));
  assert.equal(s.current, 1);
  assert.equal(s.phase, 'PLAY');
  assert.equal(s.drewCard, null);
  assert.equal(JSON.stringify(s.players[0].hand), handBefore);
  assert.equal(s.lastMove.count, 0);
});

test('reshuffle: the discard pile (except the top) refills the draw pile deterministically', () => {
  const s = mkState({}, [[], []], redTop());
  const buried = [card('green', 'number', 7), card('blue', 'skip'), card('red', 'draw2')];
  s.drawPile = [];
  s.discardPile = [...buried, s.discardPile[0]];
  const topId = s.discardPile[3].id;
  const r1 = applyOk(s, DRAW(0));
  assert.equal(r1.discardPile.length, 1);
  assert.equal(r1.discardPile[0].id, topId);
  assert.equal(r1.drawPile.length, 2);
  assert.equal(r1.players[0].hand.length, s.players[0].hand.length + 1);
  assert.notEqual(r1.rngState, s.rngState, 'rng state advanced');
  assert.equal(JSON.stringify(applyOk(s, DRAW(0))), JSON.stringify(r1), 'same input, same output');
});

test('the winning play ends the game', () => {
  const last = card('red', 'number', 9);
  let s = mkState({}, [[], []], redTop());
  s.players[0].hand = [last];
  s = playOk(s, 0, [last]);
  assert.equal(s.phase, 'GAME_OVER');
  assert.equal(s.winner, 0);
  assert.equal(s.lastMove.won, true);
  assert.equal(E.applyAction(s, DRAW(1)).ok, false);
});

test('wild cards need a color; the last card of a play sets it', () => {
  const w = card(null, 'wild');
  const s = mkState({}, [[w], []], redTop());
  assert.equal(play(s, 0, [w]).ok, false);
  assert.equal(play(s, 0, [w], 'purple').ok, false);
  assert.equal(playOk(s, 0, [w], 'yellow').activeColor, 'yellow');
});

test('wrong seat and bad shapes are rejected without a state', () => {
  const s = mkState({}, [[], []], redTop());
  const r = E.applyAction(s, DRAW(1));
  assert.equal(r.ok, false);
  assert.equal(r.state, undefined);
  assert.equal(typeof r.error, 'string');
});

// ---------- lastMove ----------

test('every valid action updates lastMove and moveCount; invalid ones do not', () => {
  const a = card('red', 'number', 7);
  let s = mkState({}, [[a], []], redTop());
  s = playOk(s, 0, [a]);
  assert.equal(s.moveCount, 1);
  assert.equal(s.lastMove.seq, 1);
  assert.equal(s.lastMove.type, 'PLAY');
  assert.equal(s.lastMove.by, 0);
  assert.equal(s.lastMove.cards[0].id, a.id);
  const bad = E.applyAction(s, DRAW(0)); // not P0's turn any more
  assert.equal(bad.ok, false);
  s.drawPile.push(card('blue', 'number', 9));
  s = applyOk(s, DRAW(1));
  assert.equal(s.moveCount, 2);
  assert.equal(s.lastMove.type, 'DRAW');
  assert.equal(s.lastMove.count, 1);
  assert.equal('cards' in s.lastMove, false, 'a draw never reveals card identity');
});

test('applyAction never mutates its input', () => {
  const a = card('red', 'number', 7);
  const s = mkState({}, [[a], []], redTop());
  const before = JSON.stringify(s);
  playOk(s, 0, [a]);
  E.applyAction(s, DRAW(1));
  assert.equal(JSON.stringify(s), before);
});

// ---------- House rule 2/3: the penalty accumulator ----------

test('Stacking +2: 2 -> 4 -> 6, then the victim draws everything', () => {
  const [a, b, c] = [card('red', 'draw2'), card('blue', 'draw2'), card('yellow', 'draw2')];
  let s = mkState({ stackDraw2: true }, [[a], [b], [c]], redTop());
  s = playOk(s, 0, [a]);
  assert.equal(s.penalty.amount, 2);
  assert.equal(s.phase, 'PENALTY');
  s = playOk(s, 1, [b]);
  assert.equal(s.penalty.amount, 4);
  s = playOk(s, 2, [c]);
  assert.equal(s.penalty.amount, 6);
  assert.equal(s.current, 0);
  const before = s.players[0].hand.length;
  s = applyOk(s, DRAW(0));
  assert.equal(s.players[0].hand.length, before + 6);
  assert.deepEqual(s.penalty, { amount: 0, source: null });
  assert.equal(s.current, 1);
  assert.equal(s.phase, 'PLAY');
  assert.equal(s.lastMove.count, 6);
  assert.equal(s.lastMove.forced, true);
});

test('+2 stacking OFF: a +2 cannot answer a +2', () => {
  const [a, b] = [card('red', 'draw2'), card('blue', 'draw2')];
  let s = mkState({}, [[a], [b], []], redTop());
  s = playOk(s, 0, [a]);
  assert.equal(play(s, 1, [b]).ok, false);
});

test('a normal playable card cannot answer a pending penalty', () => {
  const a = card('red', 'draw2');
  const seven = card('red', 'number', 7);
  let s = mkState({ stackDraw2: true }, [[a], [seven], []], redTop());
  s = playOk(s, 0, [a]);
  assert.equal(play(s, 1, [seven]).ok, false);
});

test('Brutal +4: +4 on +2 and +4 on +4 are allowed and accumulate', () => {
  const a = card('red', 'draw2');
  const w1 = card(null, 'wild4');
  const w2 = card(null, 'wild4');
  let s = mkState({ stackDraw2: true, brutalDraw4: true }, [[a], [w1], [w2]], redTop());
  s = playOk(s, 0, [a]);
  s = playOk(s, 1, [w1], 'blue');
  assert.equal(s.penalty.amount, 6);
  assert.equal(s.penalty.source, 'wild4');
  s = playOk(s, 2, [w2], 'green');
  assert.equal(s.penalty.amount, 10);
  assert.equal(s.activeColor, 'green');
});

test('a +2 can NEVER be played on a +4', () => {
  const w = card(null, 'wild4');
  const x = card('red', 'draw2');
  let s = mkState({ stackDraw2: true, brutalDraw4: true }, [[w], [x], []], redTop());
  s = playOk(s, 0, [w], 'red');
  assert.equal(play(s, 1, [x]).ok, false);
});

test('+4 on +4 is rejected when Brutal is off', () => {
  const [w, w2] = [card(null, 'wild4'), card(null, 'wild4')];
  let s = mkState({ stackDraw2: true }, [[w], [w2], []], redTop());
  s = playOk(s, 0, [w], 'red');
  assert.equal(play(s, 1, [w2], 'red').ok, false);
});

test('+4 on +2 is rejected when Brutal is off', () => {
  const [a, w] = [card('red', 'draw2'), card(null, 'wild4')];
  let s = mkState({ stackDraw2: true }, [[a], [w], []], redTop());
  s = playOk(s, 0, [a]);
  assert.equal(play(s, 1, [w], 'red').ok, false);
});

test('Brutal ON but stackDraw2 OFF: +4 on +2 works, +2 on +2 does not', () => {
  const [a, b, w] = [card('red', 'draw2'), card('blue', 'draw2'), card(null, 'wild4')];
  let s = mkState({ brutalDraw4: true }, [[a], [b, w], []], redTop());
  s = playOk(s, 0, [a]);
  assert.equal(play(s, 1, [b]).ok, false);
  assert.equal(playOk(s, 1, [w], 'green').penalty.amount, 6);
});

// ---------- House rule 1: Multi-Drop ----------

test('Multi-Drop: Blue 5 + Red 5 on Blue 3; the last card sets the color', () => {
  const t = card('blue', 'number', 3);
  const [b5, r5, r6] = [card('blue', 'number', 5), card('red', 'number', 5), card('red', 'number', 6)];
  const s = mkState({ multiDrop: true }, [[b5, r5, r6], []], t);
  assert.equal(play(s, 0, [b5, r6]).ok, false, 'different values');
  const after = playOk(s, 0, [b5, r5]);
  assert.equal(after.activeColor, 'red');
  assert.equal(after.discardPile[after.discardPile.length - 1].id, r5.id);
  assert.equal(after.lastMove.cards.length, 2);
  assert.equal(play(s, 0, [r5, b5]).ok, false, 'the leading card must be legal');
});

test('Multi-Drop OFF rejects multiples', () => {
  const [a, b] = [card('red', 'number', 7), card('blue', 'number', 7)];
  const s = mkState({}, [[a, b], []], redTop());
  assert.equal(play(s, 0, [a, b]).ok, false);
});

test('Multi-Drop of +2s adds 2 per card; of +4s adds 4 per card', () => {
  const [a, b] = [card('red', 'draw2'), card('blue', 'draw2')];
  const s = mkState({ multiDrop: true }, [[a, b], [], []], redTop());
  assert.equal(playOk(s, 0, [a, b]).penalty.amount, 4);
  const [w1, w2] = [card(null, 'wild4'), card(null, 'wild4')];
  const s2 = mkState({ multiDrop: true }, [[w1, w2], [], []], redTop());
  assert.equal(playOk(s2, 0, [w1, w2], 'red').penalty.amount, 8);
});

test('Multi-Drop: duplicates and foreign cards are rejected', () => {
  const a = card('red', 'number', 7);
  const s = mkState({ multiDrop: true }, [[a], [card('red', 'number', 7)]], redTop());
  assert.equal(E.applyAction(s, { type: 'PLAY', playerId: 0, cardIds: [a.id, a.id] }).ok, false);
  assert.equal(E.applyAction(s, { type: 'PLAY', playerId: 0, cardIds: [a.id, s.players[1].hand[0].id] }).ok, false);
});

// ---------- House rule 4: 2-player Skip Bounce (+ direction rules) ----------

test('2-player bounce: Skip and Reverse return the turn to the dropper', () => {
  for (const kind of ['skip', 'reverse']) {
    const a = card('red', kind);
    const s = mkState({ twoPlayerBounce: true }, [[a], []], redTop());
    assert.equal(playOk(s, 0, [a]).current, 0, kind);
  }
});

test('2-player without bounce: Skip is a plain pass', () => {
  const a = card('red', 'skip');
  const s = mkState({}, [[a], []], redTop());
  assert.equal(playOk(s, 0, [a]).current, 1);
});

test('2-player bounce + Multi-Drop: two Skips still return the turn to the dropper', () => {
  const [a, b] = [card('red', 'skip'), card('blue', 'skip')];
  const s = mkState({ twoPlayerBounce: true, multiDrop: true }, [[a, b], []], redTop());
  assert.equal(playOk(s, 0, [a, b]).current, 0);
});

test('3 players: Reverse flips direction, Skip jumps one player, two Reverses cancel', () => {
  const r = card('red', 'reverse');
  const rs = playOk(mkState({}, [[r], [], []], redTop()), 0, [r]);
  assert.equal(rs.direction, -1);
  assert.equal(rs.current, 2);
  const k = card('red', 'skip');
  assert.equal(playOk(mkState({}, [[k], [], []], redTop()), 0, [k]).current, 2);
  const [r1, r2] = [card('red', 'reverse'), card('blue', 'reverse')];
  const two = playOk(mkState({ multiDrop: true }, [[r1, r2], [], []], redTop()), 0, [r1, r2]);
  assert.equal(two.direction, 1);
  assert.equal(two.current, 1);
});
