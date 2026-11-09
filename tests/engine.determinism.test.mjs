// Determinism: same seed => same game; a saved state can be resumed; the engine is pure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as E from '../src/engine.js';
import { configFor, runBotGame, checkInvariants, GAMES } from './helpers.mjs';

test('same config + seed gives the identical state; another seed differs', () => {
  const cfg = configFor(5);
  const a = E.createGame(cfg, 12345);
  const b = E.createGame(cfg, 12345);
  const c = E.createGame(cfg, 12346);
  assert.deepEqual(a, b);
  assert.notEqual(JSON.stringify(a.drawPile), JSON.stringify(c.drawPile));
  assert.equal(a.seed, 12345);
  assert.ok(Number.isInteger(a.rngState) && a.rngState >= 0 && a.rngState <= 0xFFFFFFFF);
});

test('the RNG is the documented mulberry32 and its state can be resumed', () => {
  const r1 = E.makeRng(99);
  const first = [r1.next(), r1.next(), r1.next()];
  const resumed = E.makeRng(r1.state());
  const r2 = E.makeRng(99);
  assert.deepEqual(first, [r2.next(), r2.next(), r2.next()]);
  assert.equal(resumed.next(), r2.next());
  assert.ok(first.every((x) => x >= 0 && x < 1));
});

test('replaying the recorded actions reproduces the final state exactly', () => {
  for (let i = 0; i < 20; i++) {
    const cfg = configFor(i);
    const { state, actions } = runBotGame(cfg, 1000 + i);
    let s = E.createGame(cfg, 1000 + i);
    for (const act of actions) {
      const r = E.applyAction(s, act);
      assert.equal(r.ok, true);
      s = r.state;
    }
    assert.equal(JSON.stringify(s), JSON.stringify(state), `game ${i}`);
  }
});

test('a game saved as JSON mid-way (localStorage) resumes to the same result', () => {
  for (let i = 0; i < 20; i++) {
    const cfg = configFor(i);
    const { state: reference, actions } = runBotGame(cfg, 2000 + i);
    const cut = Math.floor(actions.length / 2);
    let s = E.createGame(cfg, 2000 + i);
    for (const act of actions.slice(0, cut)) s = E.applyAction(s, act).state;
    s = JSON.parse(JSON.stringify(s)); // "reload the page"
    for (const act of actions.slice(cut)) {
      const r = E.applyAction(s, act);
      assert.equal(r.ok, true);
      s = r.state;
    }
    assert.equal(JSON.stringify(s), JSON.stringify(reference), `game ${i}`);
  }
});

test('whole games between bots finish and keep every invariant (house-rule sweep)', () => {
  const stats = { games: 0, finished: 0, maxPenalty: 0, multiDrops: 0, reshuffles: 0, bounces: 0, maxMoves: 0 };
  for (let i = 0; i < GAMES; i++) {
    const cfg = configFor(i);
    const { state, finished, actions } = runBotGame(cfg, 5000 + i, {
      onStep(s, act, idx, before) {
        checkInvariants(s);
        stats.maxPenalty = Math.max(stats.maxPenalty, s.penalty.amount);
        if (s.lastMove.type === 'PLAY' && s.lastMove.cards.length > 1) stats.multiDrops++;
        if (s.drawPile.length > before.drawPile.length) stats.reshuffles++;
        if (cfg.playerNames.length === 2 && cfg.rules.twoPlayerBounce && s.lastMove.type === 'PLAY' &&
            (s.lastMove.cards.at(-1).kind === 'skip' || s.lastMove.cards.at(-1).kind === 'reverse') &&
            s.current === s.lastMove.by) stats.bounces++;
      },
    });
    stats.games++;
    stats.maxMoves = Math.max(stats.maxMoves, actions.length);
    if (finished) { stats.finished++; assert.ok(state.winner >= 0 && state.players[state.winner].hand.length === 0); }
  }
  console.log('   sweep stats:', JSON.stringify(stats));
  assert.equal(stats.finished, stats.games, 'every game must reach a winner within the move cap');
  assert.ok(stats.maxPenalty >= 8, 'stacking was exercised');
  assert.ok(stats.multiDrops > 0, 'multi-drop was exercised');
  assert.ok(stats.reshuffles > 0, 'reshuffle was exercised');
  assert.ok(stats.bounces > 0, 'bounce was exercised');
});

test('the engine source is pure: no DOM, network, clock, timers or global randomness', () => {
  const src = fs.readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const forbidden = [
    'Math.random', 'Date.now', 'new Date', 'performance.now', 'setTimeout', 'setInterval',
    'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'fetch(', 'XMLHttpRequest',
    'WebSocket', 'require(', 'process.', 'crypto',
  ];
  for (const token of forbidden) assert.equal(src.includes(token), false, `engine.js must not use ${token}`);
});
