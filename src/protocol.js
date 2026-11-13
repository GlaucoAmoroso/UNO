// =============================================================================
// protocol.js - message formats, validation and small shared helpers.
//
// EVERY message that arrives from the network goes through one of the parse*
// functions below. They rebuild a clean object from whitelisted fields, so
// nothing the peer sends (extra fields, HTML, huge values) reaches the game
// logic or the DOM unchecked.
//
// guest -> host : hello{name,token} action{action} undo rematch emoji{e}
// host -> guest : welcome{seat,gameId} lobby{...} state{...} error{error,fatal?} emoji{e,seat}
//
// Additions to the base protocol (needed for reconnection and multi-guest):
//   hello.token     random id kept by the guest, so the host can give it back its seat
//   lobby           roster/rules shown before the game starts
//   state.away      seats currently disconnected
//   error.fatal     the guest must leave and must NOT reconnect
//   emoji.seat      who sent it
// =============================================================================
import {
  COLORS, KIND, PHASE, MAX_PLAYERS, NAME_MAX_LEN, DECK_SIZE, sanitizeName, sanitizeRules,
} from './engine.js';

export const ROOM_PREFIX = 'uno-';
// No 0/O/1/I: they are easy to confuse when read aloud or typed.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LEN = 5;
export const EMOJIS = ['👍', '😂', '😮', '😡', '🎉', '🤔', '😭', '🔥'];
export const EMOJI_MIN_INTERVAL_MS = 1000;
export const MAX_GUEST_MSG_CHARS = 4096;
export const MAX_HOST_MSG_CHARS = 200000;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;
const GAME_ID_RE = /^[A-Za-z0-9_-]{4,40}$/;
const CODE_RE = /^[A-HJ-NP-Z2-9]{5}$/;

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = Number.isInteger;
const sizeOf = (x) => { try { return JSON.stringify(x).length; } catch { return Infinity; } };

// ---------- Room codes ----------

/** Forgiving input: "ab c-d2 " -> "ABCD2". Case and separators never matter. */
export const normalizeCode = (input) => String(input === undefined || input === null ? '' : input)
  .toUpperCase().replace(/[^A-Z0-9]/g, '');
export const isValidCode = (code) => CODE_RE.test(code);
export const roomId = (code) => ROOM_PREFIX + code;

export function generateCode(random32) {
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[random32() % CODE_ALPHABET.length];
  return out;
}

// ---------- Escaping (names and any text from a peer are ALWAYS escaped) ----------

export function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ---------- guest -> host ----------

export function parseGuestMessage(raw) {
  const bad = (error) => ({ ok: false, error });
  if (!isObj(raw)) return bad('Malformed message.');
  if (sizeOf(raw) > MAX_GUEST_MSG_CHARS) return bad('Message too large.');
  switch (raw.t) {
    case 'hello': {
      if (typeof raw.token !== 'string' || !TOKEN_RE.test(raw.token)) return bad('Invalid token.');
      return { ok: true, msg: { t: 'hello', name: sanitizeName(raw.name, 'Guest'), token: raw.token } };
    }
    case 'action': {
      const a = raw.action;
      if (!isObj(a) || (a.type !== 'PLAY' && a.type !== 'DRAW' && a.type !== 'PASS')) return bad('Malformed action.');
      const clean = { type: a.type };
      if (a.type === 'PLAY') {
        if (!Array.isArray(a.cardIds) || a.cardIds.length < 1 || a.cardIds.length > DECK_SIZE ||
            !a.cardIds.every(isInt)) return bad('Malformed action.');
        clean.cardIds = a.cardIds.slice();
        if (a.chosenColor !== undefined) {
          if (!COLORS.includes(a.chosenColor)) return bad('Malformed action.');
          clean.chosenColor = a.chosenColor;
        }
      }
      return { ok: true, msg: { t: 'action', action: clean } };
    }
    case 'undo':
    case 'rematch':
      return { ok: true, msg: { t: raw.t } };
    case 'emoji':
      if (!EMOJIS.includes(raw.e)) return bad('Unknown emoji.');
      return { ok: true, msg: { t: 'emoji', e: raw.e } };
    default:
      return bad('Unknown message type.');
  }
}

// ---------- host -> guest ----------

const KINDS = new Set(Object.values(KIND));
const PHASES = new Set(Object.values(PHASE));

function cleanCard(c) {
  if (!isObj(c) || !isInt(c.id) || c.id < 0 || c.id > 1000000) return null;
  if (typeof c.kind !== 'string' || !KINDS.has(c.kind)) return null;
  const wild = c.kind === KIND.WILD || c.kind === KIND.WILD4;
  if (wild) {
    if (c.color !== null) return null;
  } else if (!COLORS.includes(c.color)) return null;
  if (c.kind === KIND.NUMBER) {
    if (!isInt(c.value) || c.value < 0 || c.value > 9) return null;
  } else if (c.value !== null) return null;
  return { id: c.id, color: c.color, kind: c.kind, value: c.value };
}

function cleanCards(list, max) {
  if (!Array.isArray(list) || list.length > max) return null;
  const out = [];
  for (const c of list) { const k = cleanCard(c); if (!k) return null; out.push(k); }
  return out;
}

/** Rebuilds a redacted view from untrusted data. Returns {ok:true, view} or {ok:false}. */
export function validateView(v) {
  const bad = { ok: false };
  if (!isObj(v) || v.redacted !== true) return bad;
  if (typeof v.gameId !== 'string' || !GAME_ID_RE.test(v.gameId)) return bad;
  if (!Array.isArray(v.players) || v.players.length < 2 || v.players.length > MAX_PLAYERS) return bad;
  const n = v.players.length;
  const viewerSeat = v.viewerSeat === null ? null : v.viewerSeat;
  if (viewerSeat !== null && !(isInt(viewerSeat) && viewerSeat >= 0 && viewerSeat < n)) return bad;

  const players = [];
  for (let i = 0; i < n; i++) {
    const p = v.players[i];
    if (!isObj(p) || p.id !== i || typeof p.name !== 'string' || p.name.length > NAME_MAX_LEN * 4) return bad;
    if (!isInt(p.handCount) || p.handCount < 0 || p.handCount > DECK_SIZE) return bad;
    const clean = { id: i, name: sanitizeName(p.name, `Player ${i + 1}`), handCount: p.handCount };
    if (i === viewerSeat) {
      const hand = cleanCards(p.hand, DECK_SIZE);
      if (!hand || hand.length !== p.handCount) return bad;
      clean.hand = hand;
    }
    players.push(clean);
  }
  const discardPile = cleanCards(v.discardPile, 1);
  if (!discardPile || discardPile.length !== 1) return bad;
  if (!isInt(v.drawCount) || v.drawCount < 0 || v.drawCount > DECK_SIZE) return bad;
  if (!isInt(v.discardCount) || v.discardCount < 1 || v.discardCount > DECK_SIZE) return bad;
  if (!isInt(v.current) || v.current < 0 || v.current >= n) return bad;
  if (v.direction !== 1 && v.direction !== -1) return bad;
  if (!COLORS.includes(v.activeColor)) return bad;
  if (typeof v.phase !== 'string' || !PHASES.has(v.phase)) return bad;
  if (!isObj(v.penalty) || !isInt(v.penalty.amount) || v.penalty.amount < 0 || v.penalty.amount > 1000) return bad;
  if (v.penalty.source !== null && v.penalty.source !== KIND.DRAW2 && v.penalty.source !== KIND.WILD4) return bad;
  if (v.drewCard !== null && !isInt(v.drewCard)) return bad;
  if (v.winner !== null && !(isInt(v.winner) && v.winner >= 0 && v.winner < n)) return bad;
  if (!isInt(v.moveCount) || v.moveCount < 0) return bad;

  let lastMove = null;
  if (v.lastMove !== null) {
    const m = v.lastMove;
    if (!isObj(m) || !['PLAY', 'DRAW', 'PASS'].includes(m.type) || !isInt(m.by) || m.by < 0 || m.by >= n) return bad;
    lastMove = { seq: isInt(m.seq) ? m.seq : 0, type: m.type, by: m.by };
    if (m.type === 'PLAY') {
      const cards = cleanCards(m.cards, DECK_SIZE);
      if (!cards || cards.length === 0 || !COLORS.includes(m.color)) return bad;
      lastMove.cards = cards;
      lastMove.color = m.color;
      lastMove.penalty = isInt(m.penalty) ? m.penalty : 0;
      lastMove.won = m.won === true;
    } else if (m.type === 'DRAW') {
      lastMove.count = isInt(m.count) && m.count >= 0 ? m.count : 0;
      lastMove.forced = m.forced === true;
    }
  }
  return {
    ok: true,
    view: {
      redacted: true, v: isInt(v.v) ? v.v : 1, gameId: v.gameId, viewerSeat,
      rules: sanitizeRules(v.rules), players, drawCount: v.drawCount, discardPile,
      discardCount: v.discardCount, current: v.current, direction: v.direction,
      activeColor: v.activeColor, phase: v.phase,
      penalty: { amount: v.penalty.amount, source: v.penalty.source },
      drewCard: v.drewCard, winner: v.winner, moveCount: v.moveCount, lastMove,
    },
  };
}

export function parseHostMessage(raw) {
  const bad = (error) => ({ ok: false, error });
  if (!isObj(raw)) return bad('Malformed message.');
  if (sizeOf(raw) > MAX_HOST_MSG_CHARS) return bad('Message too large.');
  const seatOk = (s) => isInt(s) && s >= 0 && s < MAX_PLAYERS;
  switch (raw.t) {
    case 'welcome': {
      if (!seatOk(raw.seat)) return bad('Bad seat.');
      if (raw.gameId !== null && !(typeof raw.gameId === 'string' && GAME_ID_RE.test(raw.gameId))) return bad('Bad game id.');
      return { ok: true, msg: { t: 'welcome', seat: raw.seat, gameId: raw.gameId } };
    }
    case 'lobby': {
      if (!seatOk(raw.seat) || typeof raw.code !== 'string' || !CODE_RE.test(raw.code)) return bad('Bad lobby.');
      if (!Array.isArray(raw.players) || raw.players.length < 1 || raw.players.length > MAX_PLAYERS) return bad('Bad lobby.');
      const players = [];
      for (const p of raw.players) {
        if (!isObj(p) || typeof p.name !== 'string') return bad('Bad lobby.');
        players.push({ name: sanitizeName(p.name, 'Player'), connected: p.connected === true });
      }
      return { ok: true, msg: { t: 'lobby', seat: raw.seat, code: raw.code, players, rules: sanitizeRules(raw.rules) } };
    }
    case 'state': {
      const v = validateView(raw.state);
      if (!v.ok) return bad('Bad state.');
      if (raw.undoBy !== null && !seatOk(raw.undoBy)) return bad('Bad state.');
      if (!isInt(raw.undoSeq) || raw.undoSeq < 0) return bad('Bad state.');
      const away = Array.isArray(raw.away) ? raw.away.filter(seatOk).slice(0, MAX_PLAYERS) : [];
      return { ok: true, msg: { t: 'state', gameId: v.view.gameId, state: v.view, undoBy: raw.undoBy, undoSeq: raw.undoSeq, away } };
    }
    case 'error': {
      if (typeof raw.error !== 'string') return bad('Bad error.');
      return { ok: true, msg: { t: 'error', error: raw.error.slice(0, 200), fatal: raw.fatal === true } };
    }
    case 'emoji': {
      if (!EMOJIS.includes(raw.e) || !seatOk(raw.seat)) return bad('Bad emoji.');
      return { ok: true, msg: { t: 'emoji', e: raw.e, seat: raw.seat } };
    }
    default:
      return bad('Unknown message type.');
  }
}
