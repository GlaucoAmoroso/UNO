// =============================================================================
// engine.js - PURE UNO game engine.
//
// Rules of this file (enforced by tests/engine.determinism.test.mjs):
//   * No DOM, no network, no timers, no clock, no global randomness.
//   * All randomness comes from a seeded RNG (mulberry32). The RNG state is
//     stored INSIDE the game state, so a game can be saved, restored and
//     replayed bit-for-bit.
//   * The state is plain JSON (it survives JSON.parse(JSON.stringify(s))).
//   * applyAction never mutates its input and never throws on bad input.
//
// Public surface:
//   createGame(config, seed)          -> state            (throws on bad config)
//   applyAction(state, action)        -> {ok:true,state} | {ok:false,error}
//   redactForPeer(state, seat)        -> view with ALL hidden info removed
//   getPlayableCardIds / getMultiDropPartners : UI hints (work on views too)
// =============================================================================

export const ENGINE_VERSION = 1;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 10;
export const NAME_MAX_LEN = 16;
export const HAND_SIZE = 7;
export const DECK_SIZE = 108;

export const COLORS = ['red', 'yellow', 'green', 'blue'];
export const KIND = {
  NUMBER: 'number', SKIP: 'skip', REVERSE: 'reverse',
  DRAW2: 'draw2', WILD: 'wild', WILD4: 'wild4',
};
export const PHASE = {
  PLAY: 'PLAY',         // normal turn, no pending penalty
  PENALTY: 'PENALTY',   // a draw penalty is pending for the current player
  DREW: 'DREW',         // current player drew one card and may play it or pass
  GAME_OVER: 'GAME_OVER',
};
export const ACTION = { PLAY: 'PLAY', DRAW: 'DRAW', PASS: 'PASS' };

export const RULE_KEYS = ['multiDrop', 'stackDraw2', 'brutalDraw4', 'twoPlayerBounce'];
export const DEFAULT_RULES = Object.freeze({
  multiDrop: false,       // house rule 1: drop several cards of the same face value
  stackDraw2: false,      // house rule 2: +2 can be answered with +2
  brutalDraw4: false,     // house rule 3: +4 can be answered with +4, and +4 on +2
  twoPlayerBounce: false, // house rule 4: Skip/Reverse give the dropper another turn (2 players)
});

// ---------- Small helpers ----------

const clone = (x) => JSON.parse(JSON.stringify(x));
const isWild = (c) => c.kind === KIND.WILD || c.kind === KIND.WILD4;
const GAME_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;

/** "Face value" key: every Blue/Red 5 shares 'n5'; every Skip shares 'skip'; etc. */
export const valueKey = (c) => (c.kind === KIND.NUMBER ? `n${c.value}` : c.kind);

/** Strips control characters, collapses spaces, clamps length. Never returns ''. */
export function sanitizeName(raw, fallback) {
  const s = typeof raw === 'string'
    ? raw.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, '').replace(/\s+/g, ' ').trim()
    : '';
  const clamped = Array.from(s).slice(0, NAME_MAX_LEN).join('');
  return clamped || fallback;
}

/** Keeps only the known house rules, each as a strict boolean. */
export function sanitizeRules(raw) {
  const out = { ...DEFAULT_RULES };
  if (raw && typeof raw === 'object') {
    for (const k of RULE_KEYS) out[k] = raw[k] === true;
  }
  return out;
}

// ---------- Seeded RNG (mulberry32) ----------

/**
 * Seeded RNG. next() returns a float in [0,1). state() returns the current
 * uint32 so it can be stored in the game state and resumed later.
 */
export function makeRng(seed) {
  let a = seed >>> 0;
  return {
    next() {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    state() { return a >>> 0; },
  };
}

/** Fisher-Yates using the given seeded rng. Returns a new array. */
export function shuffle(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Deck ----------

/** Builds the standard 108-card deck (4 * 25 colored + 8 wilds). */
export function createDeck() {
  const deck = [];
  let id = 0;
  const add = (color, kind, value = null) => deck.push({ id: id++, color, kind, value });
  for (const color of COLORS) {
    add(color, KIND.NUMBER, 0); // one zero per color
    for (let v = 1; v <= 9; v++) { add(color, KIND.NUMBER, v); add(color, KIND.NUMBER, v); }
    for (const kind of [KIND.SKIP, KIND.REVERSE, KIND.DRAW2]) { add(color, kind); add(color, kind); }
  }
  for (let i = 0; i < 4; i++) { add(null, KIND.WILD); add(null, KIND.WILD4); }
  return deck;
}

// ---------- Setup ----------

/**
 * config: { playerNames: string[2..10], gameId: string, rules?: object, firstPlayer?: int }
 * seed:   uint32. The host must draw it from a secure source; it is NEVER sent to guests.
 * gameId: must be independent from the seed (otherwise it could leak it).
 */
export function createGame(config, seed) {
  if (!config || typeof config !== 'object') throw new Error('createGame: config is required.');
  const { playerNames, gameId } = config;
  if (!Array.isArray(playerNames) || playerNames.length < MIN_PLAYERS || playerNames.length > MAX_PLAYERS) {
    throw new Error(`createGame: playerNames must have ${MIN_PLAYERS}-${MAX_PLAYERS} entries.`);
  }
  if (typeof gameId !== 'string' || !GAME_ID_RE.test(gameId)) {
    throw new Error('createGame: gameId must match [A-Za-z0-9_-]{4,40}.');
  }
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xFFFFFFFF) {
    throw new Error('createGame: seed must be an integer in [0, 2^32).');
  }
  const firstPlayer = config.firstPlayer === undefined ? 0 : config.firstPlayer;
  if (!Number.isInteger(firstPlayer) || firstPlayer < 0 || firstPlayer >= playerNames.length) {
    throw new Error('createGame: firstPlayer is out of range.');
  }

  const rng = makeRng(seed);
  const drawPile = shuffle(createDeck(), rng);
  const players = playerNames.map((name, id) => ({
    id, name: sanitizeName(name, `Player ${id + 1}`), hand: [],
  }));
  for (let n = 0; n < HAND_SIZE; n++) for (const p of players) p.hand.push(drawPile.pop());

  // The starting card must be a plain number card; others go to the bottom of the pile.
  let top = drawPile.pop();
  while (top.kind !== KIND.NUMBER) { drawPile.unshift(top); top = drawPile.pop(); }

  return {
    v: ENGINE_VERSION,
    gameId,
    seed,                       // HOST ONLY - removed by redactForPeer
    rngState: rng.state(),      // HOST ONLY - removed by redactForPeer
    rules: sanitizeRules(config.rules),
    players,
    drawPile,                   // HOST ONLY
    discardPile: [top],
    current: firstPlayer,
    direction: 1,
    activeColor: top.color,
    phase: PHASE.PLAY,
    penalty: { amount: 0, source: null }, // THE DRAW PENALTY ACCUMULATOR
    drewCard: null,
    winner: null,
    moveCount: 0,
    lastMove: null,
  };
}

// ---------- Penalty accumulator ----------

/**
 * Can `card` answer the pending penalty?
 *   pending +2 : +2 (needs stackDraw2)  or  +4 (needs brutalDraw4)
 *   pending +4 : +4 (needs brutalDraw4) only. A +2 can NEVER be played on a +4.
 */
export function canRespondToPenalty(card, penalty, rules) {
  if (penalty.source === KIND.DRAW2) {
    return (card.kind === KIND.DRAW2 && rules.stackDraw2) ||
           (card.kind === KIND.WILD4 && rules.brutalDraw4);
  }
  if (penalty.source === KIND.WILD4) {
    return card.kind === KIND.WILD4 && rules.brutalDraw4;
  }
  return false;
}

/** Normal (no penalty) legality: wild, same color, or same number/symbol. */
export function isPlayableOnTop(card, state) {
  if (isWild(card)) return true;
  const top = state.discardPile[state.discardPile.length - 1];
  if (card.color === state.activeColor) return true;
  return top.kind === card.kind && (card.kind !== KIND.NUMBER || top.value === card.value);
}

// ---------- Validation (incl. Multi-Drop) ----------

/**
 * cardIds are in PLAY ORDER: the FIRST card must be legal (normal rules or a
 * valid penalty answer), the others only need the same face value. The LAST
 * card becomes the new top card and decides the active color.
 */
export function validatePlay(state, playerId, cardIds, chosenColor) {
  const fail = (error) => ({ ok: false, error });
  if (state.phase === PHASE.GAME_OVER) return fail('Game is over.');
  if (playerId !== state.current) return fail('Not your turn.');
  if (!Array.isArray(cardIds) || cardIds.length === 0) return fail('Select at least one card.');
  if (new Set(cardIds).size !== cardIds.length) return fail('Duplicate card selected.');

  const hand = state.players[playerId].hand;
  const cards = cardIds.map((id) => hand.find((c) => c.id === id));
  if (cards.some((c) => !c)) return fail('Card not in hand.');

  if (cards.length > 1) {
    if (!state.rules.multiDrop) return fail('Multi-Drop is disabled.');
    const key = valueKey(cards[0]);
    if (!cards.every((c) => valueKey(c) === key)) return fail('Cards must share the same value.');
  }

  if (state.phase === PHASE.DREW) {
    if (cards.length !== 1 || cards[0].id !== state.drewCard) return fail('You may only play the card you drew.');
  }

  const lead = cards[0];
  if (state.penalty.amount > 0) {
    if (!canRespondToPenalty(lead, state.penalty, state.rules)) return fail('You must stack a valid card or draw the penalty.');
  } else if (!isPlayableOnTop(lead, state)) {
    return fail('First card does not match color or value.');
  }

  const last = cards[cards.length - 1];
  if (isWild(last) && !COLORS.includes(chosenColor)) return fail('Choose a color for the wild card.');
  return { ok: true, cards };
}

/** UI hint: which cards can start a play right now? Works on full states and on views. */
export function getPlayableCardIds(state, playerId) {
  if (!state || playerId !== state.current || state.phase === PHASE.GAME_OVER) return [];
  const p = state.players[playerId];
  if (!p || !Array.isArray(p.hand)) return [];
  let hand = p.hand;
  if (state.phase === PHASE.DREW) hand = hand.filter((c) => c.id === state.drewCard);
  return hand
    .filter((c) => (state.penalty.amount > 0
      ? canRespondToPenalty(c, state.penalty, state.rules)
      : isPlayableOnTop(c, state)))
    .map((c) => c.id);
}

/** UI hint: other cards in hand that may be dropped together with `cardId`. */
export function getMultiDropPartners(state, playerId, cardId) {
  if (!state || !state.rules.multiDrop || state.phase === PHASE.DREW) return [];
  const p = state.players[playerId];
  if (!p || !Array.isArray(p.hand)) return [];
  const base = p.hand.find((c) => c.id === cardId);
  if (!base) return [];
  return p.hand.filter((c) => c.id !== cardId && valueKey(c) === valueKey(base)).map((c) => c.id);
}

// ---------- Action parsing (untrusted input) ----------

const ACTION_TYPES = new Set(Object.values(ACTION));

/** Validates the SHAPE of an action and returns a clean copy. Never throws. */
function parseAction(a) {
  const bad = (error) => ({ ok: false, error });
  if (!a || typeof a !== 'object' || Array.isArray(a)) return bad('Malformed action.');
  if (typeof a.type !== 'string' || !ACTION_TYPES.has(a.type)) return bad('Unknown action type.');
  if (!Number.isInteger(a.playerId)) return bad('Malformed action: playerId.');
  const clean = { type: a.type, playerId: a.playerId };
  if (a.type === ACTION.PLAY) {
    if (!Array.isArray(a.cardIds) || a.cardIds.length < 1 || a.cardIds.length > DECK_SIZE ||
        !a.cardIds.every((n) => Number.isInteger(n))) {
      return bad('Malformed action: cardIds.');
    }
    clean.cardIds = a.cardIds.slice();
    clean.chosenColor = typeof a.chosenColor === 'string' ? a.chosenColor : undefined;
  }
  return { ok: true, action: clean };
}

// ---------- Reducer ----------

const stepFrom = (state, steps) => {
  const n = state.players.length;
  return (((state.current + state.direction * steps) % n) + n) % n;
};

/** Draws up to `count` cards (reshuffling the discard pile when needed). Returns how many were drawn. */
function drawCards(state, rng, playerId, count) {
  const hand = state.players[playerId].hand;
  let drawn = 0;
  for (let i = 0; i < count; i++) {
    if (state.drawPile.length === 0) {
      if (state.discardPile.length <= 1) break; // nothing left anywhere
      const top = state.discardPile.pop();
      state.drawPile = shuffle(state.discardPile, rng);
      state.discardPile = [top];
    }
    hand.push(state.drawPile.pop());
    drawn++;
  }
  return drawn;
}

/**
 * Pure transition.
 * action: {type:'PLAY', playerId, cardIds, chosenColor} | {type:'DRAW', playerId} | {type:'PASS', playerId}
 * Returns {ok:true, state} (a NEW state, with state.lastMove updated) or {ok:false, error}.
 */
export function applyAction(prev, action) {
  const fail = (error) => ({ ok: false, error });

  if (!prev || typeof prev !== 'object' || prev.redacted === true ||
      !Array.isArray(prev.players) || !Array.isArray(prev.drawPile)) {
    return fail('Invalid game state.');
  }
  if (prev.phase === PHASE.GAME_OVER) return fail('Game is over.');
  const parsed = parseAction(action);
  if (!parsed.ok) return fail(parsed.error);
  const act = parsed.action;
  if (act.playerId !== prev.current) return fail('Not your turn.');

  const state = clone(prev);
  const rng = makeRng(state.rngState);
  const seat = act.playerId;

  // Every successful action ends here: bump the counter, record lastMove, save the RNG.
  const finish = (lastMove) => {
    state.moveCount += 1;
    state.lastMove = { seq: state.moveCount, ...lastMove };
    state.rngState = rng.state();
    return { ok: true, state };
  };

  switch (act.type) {
    case ACTION.PLAY: {
      const v = validatePlay(state, seat, act.cardIds, act.chosenColor);
      if (!v.ok) return fail(v.error);
      const { cards } = v;
      const played = new Set(act.cardIds);
      state.players[seat].hand = state.players[seat].hand.filter((c) => !played.has(c.id));
      state.discardPile.push(...cards);
      state.drewCard = null;

      const last = cards[cards.length - 1];
      state.activeColor = isWild(last) ? act.chosenColor : last.color;
      const n = cards.length;
      const playedCopy = clone(cards);

      if (state.players[seat].hand.length === 0) {
        state.phase = PHASE.GAME_OVER;
        state.winner = seat;
        return finish({ type: ACTION.PLAY, by: seat, cards: playedCopy, color: state.activeColor, penalty: state.penalty.amount, won: true });
      }

      const twoPlayers = state.players.length === 2;
      let steps = 1;
      switch (last.kind) {
        case KIND.SKIP:
          // 2 players: with Bounce the opponent is always skipped, so the dropper goes again
          // (steps = 2 wraps back to them whatever n is). Without Bounce it is a plain pass.
          // 3+ players: n skips jump over n players.
          steps = twoPlayers ? (state.rules.twoPlayerBounce ? 2 : 1) : n + 1;
          break;
        case KIND.REVERSE:
          if (twoPlayers) steps = state.rules.twoPlayerBounce ? 2 : 1; // Reverse acts like Skip
          else if (n % 2 === 1) state.direction *= -1;                  // odd count flips direction
          break;
        case KIND.DRAW2:
          state.penalty = { amount: state.penalty.amount + 2 * n, source: KIND.DRAW2 };
          break;
        case KIND.WILD4:
          state.penalty = { amount: state.penalty.amount + 4 * n, source: KIND.WILD4 };
          break;
        default: break;
      }
      state.current = stepFrom(state, steps);
      state.phase = state.penalty.amount > 0 ? PHASE.PENALTY : PHASE.PLAY;
      return finish({ type: ACTION.PLAY, by: seat, cards: playedCopy, color: state.activeColor, penalty: state.penalty.amount, won: false });
    }

    case ACTION.DRAW: {
      if (state.penalty.amount > 0) { // take the whole accumulated penalty and lose the turn
        const drawn = drawCards(state, rng, seat, state.penalty.amount);
        state.penalty = { amount: 0, source: null };
        state.current = stepFrom(state, 1);
        state.phase = PHASE.PLAY;
        return finish({ type: ACTION.DRAW, by: seat, count: drawn, forced: true });
      }
      if (state.phase === PHASE.DREW) return fail('Already drew this turn. Play the card or pass.');
      const drawn = drawCards(state, rng, seat, 1);
      if (drawn === 0) { // both piles are empty: nothing to draw, the turn passes
        state.current = stepFrom(state, 1);
        return finish({ type: ACTION.DRAW, by: seat, count: 0, forced: false });
      }
      const hand = state.players[seat].hand;
      const card = hand[hand.length - 1];
      if (isPlayableOnTop(card, state)) {
        state.drewCard = card.id;
        state.phase = PHASE.DREW;
      } else {
        state.current = stepFrom(state, 1); // auto-pass
      }
      return finish({ type: ACTION.DRAW, by: seat, count: 1, forced: false });
    }

    case ACTION.PASS: {
      if (state.phase !== PHASE.DREW) return fail('You can only pass after drawing.');
      state.drewCard = null;
      state.current = stepFrom(state, 1);
      state.phase = PHASE.PLAY;
      return finish({ type: ACTION.PASS, by: seat });
    }

    default: return fail('Unknown action type.');
  }
}

// ---------- Redaction ----------

/**
 * The ONLY thing that may leave the host's phone. Builds the view of `seat`
 * (use null for a spectator). Removed: seed, rngState, the draw pile, the
 * discard pile except its top card, every other player's cards, and the id of
 * a drawn card for everyone except the player who drew it.
 *
 * The view keeps the same field names as the full state where possible, so
 * getPlayableCardIds / getMultiDropPartners work on it for UI highlighting.
 * applyAction refuses a view (redacted:true).
 */
export function redactForPeer(state, seat) {
  if (!state || typeof state !== 'object' || state.redacted === true || !Array.isArray(state.players)) {
    throw new Error('redactForPeer: expected a full game state.');
  }
  if (seat !== null && !(Number.isInteger(seat) && seat >= 0 && seat < state.players.length)) {
    throw new Error('redactForPeer: seat out of range.');
  }
  const top = state.discardPile[state.discardPile.length - 1];
  return clone({
    redacted: true,
    v: state.v,
    gameId: state.gameId,
    viewerSeat: seat,
    rules: state.rules,
    players: state.players.map((p) => (p.id === seat
      ? { id: p.id, name: p.name, handCount: p.hand.length, hand: p.hand }
      : { id: p.id, name: p.name, handCount: p.hand.length })),
    drawCount: state.drawPile.length,
    discardPile: [top],
    discardCount: state.discardPile.length,
    current: state.current,
    direction: state.direction,
    activeColor: state.activeColor,
    phase: state.phase,
    penalty: state.penalty,
    drewCard: seat !== null && seat === state.current ? state.drewCard : null,
    winner: state.winner,
    moveCount: state.moveCount,
    lastMove: state.lastMove,
  });
}
