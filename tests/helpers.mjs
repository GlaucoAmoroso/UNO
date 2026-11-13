// Shared test helpers: synthetic states, a seeded random bot, and invariants.
// All randomness here is seeded, so every failure is reproducible.
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';

// Synthetic cards get ids >= 1000 so they never collide with real deck ids (0..107).
let nextId = 1000;
export const card = (color, kind, value = null) => ({ id: nextId++, color, kind, value });

/**
 * Builds a real game, then overrides hands and the top card so a test controls
 * exactly what each player holds. Every hand also gets two green filler cards
 * that are never playable on a red/blue top (so hands never become empty by accident).
 */
export function mkState(rules, hands, top, extra = {}) {
  const names = hands.map((_, i) => `P${i}`);
  const s = E.createGame({ playerNames: names, rules, gameId: 'test-game' }, 1);
  s.players.forEach((p, i) => {
    p.hand = [...hands[i], card('green', 'number', 1), card('green', 'number', 2)];
  });
  s.discardPile = [top];
  s.activeColor = top.color;
  return Object.assign(s, extra);
}

export const play = (s, seat, cards, chosenColor) =>
  E.applyAction(s, { type: 'PLAY', playerId: seat, cardIds: cards.map((c) => c.id), chosenColor });

/** Plays and asserts success; returns the new state. */
export function playOk(s, seat, cards, chosenColor) {
  const r = play(s, seat, cards, chosenColor);
  assert.equal(r.ok, true, `expected success, got: ${r.error}`);
  return r.state;
}

/** Applies any action and asserts success; returns the new state. */
export function applyOk(s, action) {
  const r = E.applyAction(s, action);
  assert.equal(r.ok, true, `expected success, got: ${r.error}`);
  return r.state;
}

/** Structural invariants that must hold after EVERY valid action of a real game. */
export function checkInvariants(s) {
  const all = [...s.drawPile, ...s.discardPile, ...s.players.flatMap((p) => p.hand)];
  assert.equal(all.length, E.DECK_SIZE, 'card conservation');
  assert.equal(new Set(all.map((c) => c.id)).size, E.DECK_SIZE, 'card ids unique');
  assert.ok(s.discardPile.length >= 1, 'discard pile never empty');
  assert.ok(Number.isInteger(s.current) && s.current >= 0 && s.current < s.players.length);
  assert.ok(E.COLORS.includes(s.activeColor), 'active color is a real color');
  assert.ok(s.direction === 1 || s.direction === -1);
  if (s.phase !== E.PHASE.GAME_OVER) {
    if (s.penalty.amount > 0) {
      assert.equal(s.phase, E.PHASE.PENALTY);
      assert.ok(s.penalty.source === 'draw2' || s.penalty.source === 'wild4');
      assert.equal(s.penalty.amount % 2, 0);
    } else {
      assert.notEqual(s.phase, E.PHASE.PENALTY);
      assert.equal(s.penalty.source, null);
    }
    if (s.phase === E.PHASE.DREW) {
      assert.ok(s.players[s.current].hand.some((c) => c.id === s.drewCard), 'drewCard is in the current hand');
    } else {
      assert.equal(s.drewCard, null);
    }
  }
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s, 'state is JSON-serializable');
}

/** A bot that always makes a LEGAL move, using only the public UI hints. */
export function botMove(state, rng) {
  const seat = state.current;
  const playable = E.getPlayableCardIds(state, seat);
  if (playable.length === 0) return { type: 'DRAW', playerId: seat };
  if (state.phase === E.PHASE.DREW && rng.next() < 0.2) return { type: 'PASS', playerId: seat };
  const hand = state.players[seat].hand;
  const leadId = playable[Math.floor(rng.next() * playable.length)];
  const ids = [leadId];
  for (const pid of E.getMultiDropPartners(state, seat, leadId)) if (rng.next() < 0.5) ids.push(pid);
  const last = hand.find((c) => c.id === ids[ids.length - 1]);
  const wild = last.kind === 'wild' || last.kind === 'wild4';
  const chosenColor = wild ? E.COLORS[Math.floor(rng.next() * 4)] : undefined;
  return { type: 'PLAY', playerId: seat, cardIds: ids, chosenColor };
}

/** Config for game number i: 2..6 players, all 16 house-rule combinations in rotation. */
export function configFor(i) {
  return {
    playerNames: Array.from({ length: 2 + (i % 5) }, (_, k) => `P${k}`),
    gameId: `game-${i}`,
    rules: {
      multiDrop: !!(i & 1), stackDraw2: !!(i & 2), brutalDraw4: !!(i & 4), twoPlayerBounce: !!(i & 8),
    },
  };
}

/** Plays a whole game with the bot. Bounded by maxMoves. */
export function runBotGame(config, seed, { maxMoves = 4000, onStep } = {}) {
  let s = E.createGame(config, seed);
  const botRng = E.makeRng(seed ^ 0x9e3779b9);
  const actions = [];
  for (let i = 0; i < maxMoves && s.phase !== E.PHASE.GAME_OVER; i++) {
    const act = botMove(s, botRng);
    const r = E.applyAction(s, act);
    assert.equal(r.ok, true, `bot made an illegal move: ${r.error} ${JSON.stringify(act)}`);
    actions.push(act);
    const before = s;
    s = r.state;
    if (onStep) onStep(s, act, i, before);
  }
  return { state: s, actions, finished: s.phase === E.PHASE.GAME_OVER };
}

export const GAMES = Number(process.env.GAMES) || 300;
