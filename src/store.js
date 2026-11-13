// =============================================================================
// store.js - the app's single source of truth. Modes: 'local' | 'host' | 'guest'.
//
//  local : pass & play on one phone. The store holds the FULL game state.
//  host  : AUTHORITATIVE. Runs the engine, saves after every move, and sends each
//          guest only redactForPeer(state, seat). Hidden values never leave this phone.
//  guest : runs NO rules. It only sends actions; the host forces the seat of the
//          sender and answers illegal moves with {t:'error'}.
//
// commit(state) is the ONE place where a new game state is accepted: it saves
// (host/local), records statistics (idempotent by gameId) and notifies the UI.
//
// Everything outside is injected (storage, timers, random, PeerJS loader,
// vibration) so the whole store runs in Node tests with a fake PeerJS.
// =============================================================================
import * as E from './engine.js';
import * as P from './protocol.js';
import { openRoom, connectToRoom, realTimers } from './transport.js';

export const KEYS = {
  stats: 'uno.stats.v1',
  settings: 'uno.settings.v1',
  hostSave: 'uno.host.v1',
  guestSession: 'uno.guest.v1',
  localSave: 'uno.local.v1',
};
export const MAX_ONLINE_PLAYERS = 6;
export const MAX_LOCAL_PLAYERS = 6;
export const TOAST_MS = 3500;
export const EMOJI_SHOW_MS = 3000;
const MAX_STATS_GAMES = 200;

/** localStorage-like wrapper that never throws (private mode, quota, null storage). */
function makeStorage(raw) {
  const mem = new Map();
  return {
    get(key) {
      try {
        const s = raw ? raw.getItem(key) : (mem.has(key) ? mem.get(key) : null);
        return s ? JSON.parse(s) : null;
      } catch { return null; }
    },
    set(key, value) {
      try {
        const s = JSON.stringify(value);
        if (raw) raw.setItem(key, s); else mem.set(key, s);
      } catch { /* ignore: the game still works without saving */ }
    },
    del(key) { try { if (raw) raw.removeItem(key); else mem.delete(key); } catch { /* ignore */ } },
  };
}

/** Is this a plausible saved full game state? (a corrupted save must not crash the app) */
function looksLikeGame(g) {
  if (!g || typeof g !== 'object' || g.v !== E.ENGINE_VERSION || g.redacted) return false;
  if (typeof g.gameId !== 'string' || !Array.isArray(g.players) || g.players.length < 2) return false;
  if (!Array.isArray(g.drawPile) || !Array.isArray(g.discardPile) || g.discardPile.length < 1) return false;
  if (!Number.isInteger(g.current) || g.current < 0 || g.current >= g.players.length) return false;
  if (!g.players.every((p) => p && Array.isArray(p.hand) && typeof p.name === 'string')) return false;
  const total = g.drawPile.length + g.discardPile.length + g.players.reduce((n, p) => n + p.hand.length, 0);
  return total === E.DECK_SIZE && Number.isInteger(g.rngState);
}

export function createStore(deps) {
  const {
    timers = realTimers, random32, loadPeer, vibrate = () => {}, transportOptions = {},
  } = deps;
  const db = makeStorage(deps.storage || null);
  const now = () => timers.now();

  // ----- state -----
  let mode = null;            // 'local' | 'host' | 'guest' | null
  let screen = 'home';        // home | setup-local | setup-host | setup-join | lobby | joining | game
  let game = null;            // host/local: FULL state. guest: redacted view.
  let seat = null;            // my seat: host 0, guest assigned by host, local null
  let notice = null;          // message shown on the home/lobby screens
  let session = 0;            // bumps on every teardown; cancels stale async work
  let draftRules = E.sanitizeRules({});
  let localSetup = { count: 2 };
  let localConfig = null;     // names + rules of the current local game (for rematch)
  let roomCode = null;
  let room = null;            // host: the room adapter
  let hostStatus = { state: 'idle', message: '' };
  let seats = [];             // host: [{seat,name,token,link}] (seat 0 is the host itself)
  let linkSeat = new Map();   // host: link -> seat
  let snapshot = null;        // host: { state, by } = state before the last PLAY (for undo)
  let undoSeq = 0;
  let undoBy = null;
  let seenUndoSeq = null;     // guest: last undoSeq already announced
  let rematchVotes = new Set();
  let rematchSent = false;
  let guestLink = null;
  let guestToken = null;
  let guestName = '';
  let guestConn = 'idle';     // idle | connecting | open | lost
  let awaySeatsGuest = [];    // guest: seats the host reports as disconnected
  let lobby = null;           // guest: { players, rules }
  let toastSeq = 0;
  const ui = { selection: [], pickColor: null, menu: false, viewer: null, toast: null, emoji: null };
  const settings = { vibrate: true, theme: 'auto', name: '', ...(db.get(KEYS.settings) || {}) };
  let stats = db.get(KEYS.stats);
  if (!stats || !Array.isArray(stats.games)) stats = { v: 1, games: [] };
  const lastEmojiAt = new Map();
  const subs = new Set();

  const notify = () => { for (const f of [...subs]) f(); };
  const saveSettings = () => db.set(KEYS.settings, settings);
  const newToken = () => Array.from({ length: 4 }, () => random32().toString(36).padStart(6, '0')).join('');
  const newGameId = () => `g${random32().toString(36)}${random32().toString(36)}`;

  function toast(text) {
    const id = ++toastSeq;
    ui.toast = { id, text };
    timers.setTimeout(() => { if (ui.toast && ui.toast.id === id) { ui.toast = null; notify(); } }, TOAST_MS);
    notify();
  }
  function showEmoji(who, e) {
    const mine = { seat: who, e, id: ++toastSeq };
    ui.emoji = mine;
    timers.setTimeout(() => { if (ui.emoji === mine) { ui.emoji = null; notify(); } }, EMOJI_SHOW_MS);
    notify();
  }

  // ----- derived data -----
  const linkOpen = (s) => s.link !== null && s.link !== undefined && s.link.isOpen();
  const connected = (s) => s.seat === 0 || linkOpen(s);
  const hostAway = () => seats.filter((s) => !connected(s)).map((s) => s.seat);

  function currentView() {
    if (!game) return null;
    if (mode === 'guest') return game;
    if (mode === 'host') return E.redactForPeer(game, 0);
    if (mode === 'local') return E.redactForPeer(game, ui.viewer); // viewer null = hands hidden
    return null;
  }
  const nameOf = (s) => (game && game.players[s] ? game.players[s].name : `Player ${s + 1}`);

  function connectionBanner() {
    if (mode === 'guest' && screen !== 'joining') {
      if (guestConn !== 'open') return 'Connection lost. Reconnecting…';
      const gone = awaySeatsGuest.filter((s) => s !== seat);
      if (game && gone.length) return `${gone.map(nameOf).join(', ')} disconnected. Waiting for them to rejoin…`;
    }
    if (mode === 'host' && game) {
      if (hostStatus.state === 'busy' || hostStatus.state === 'reconnecting' || hostStatus.state === 'opening') {
        return hostStatus.message || 'Reconnecting…';
      }
      const gone = hostAway();
      if (gone.length) return `${gone.map(nameOf).join(', ')} disconnected. Waiting for them to rejoin…`;
    }
    return null;
  }
  const isBlocked = () => connectionBanner() !== null;

  function summarize() {
    const wins = {};
    for (const g of stats.games) wins[g.winner] = (wins[g.winner] || 0) + 1;
    return { played: stats.games.length, top: Object.entries(wins).sort((a, b) => b[1] - a[1]).slice(0, 5) };
  }

  function getModel() {
    const view = currentView();
    const mySeat = mode === 'host' ? 0 : mode === 'guest' ? seat : mode === 'local' ? ui.viewer : null;
    const banner = connectionBanner();
    const over = !!view && view.phase === E.PHASE.GAME_OVER;
    const myTurn = !!view && !over && mySeat !== null && view.current === mySeat && banner === null;
    let canUndo = false;
    if (view && !over && banner === null) {
      if (mode === 'host') canUndo = !!snapshot && snapshot.by === 0 && game.moveCount === snapshot.state.moveCount + 1;
      else if (mode === 'guest') canUndo = !!view.lastMove && view.lastMove.type === 'PLAY' && view.lastMove.by === seat && !view.lastMove.won;
    }
    const lobbyPlayers = mode === 'host'
      ? seats.map((s) => ({ seat: s.seat, name: s.name, connected: connected(s) }))
      : (lobby ? lobby.players.map((p, i) => ({ seat: i, name: p.name, connected: p.connected })) : []);
    return {
      screen, mode, view, mySeat, myTurn, over,
      blocked: banner !== null, banner, notice, roomCode,
      rules: view ? view.rules : (mode === 'guest' && lobby ? lobby.rules : draftRules),
      lobbyPlayers,
      canStart: mode === 'host' && !game && seats.length >= 2 && seats.every(connected),
      isHost: mode === 'host',
      hostStatus,
      playable: view && myTurn ? E.getPlayableCardIds(view, mySeat) : [],
      partners: view && myTurn && ui.selection.length ? E.getMultiDropPartners(view, mySeat, ui.selection[0]) : [],
      selection: ui.selection.slice(),
      pickColor: ui.pickColor,
      menu: ui.menu,
      toast: ui.toast ? ui.toast.text : null,
      emoji: ui.emoji ? { seat: ui.emoji.seat, e: ui.emoji.e } : null,
      handoff: mode === 'local' && game && ui.viewer === null && game.phase !== E.PHASE.GAME_OVER
        ? { seat: game.current, name: game.players[game.current].name } : null,
      canUndo,
      canRematch: over && (mode === 'host' ? hostAway().length === 0 : true),
      rematchVotes: [...rematchVotes].map((s) => nameOf(s)),
      rematchSent,
      localSetup: { ...localSetup },
      settings: { ...settings },
      stats: summarize(),
      saves: {
        local: !!(db.get(KEYS.localSave) && looksLikeGame(db.get(KEYS.localSave).game)),
        host: (() => { const s = db.get(KEYS.hostSave); return s && looksLikeGame(s.game) && s.game.phase !== E.PHASE.GAME_OVER ? { code: s.code } : null; })(),
        guest: (() => { const s = db.get(KEYS.guestSession); return s && P.isValidCode(s.code) ? { code: s.code, name: s.name } : null; })(),
      },
      emojis: P.EMOJIS,
    };
  }

  // ----- the ONE place where a new state is accepted -----
  function recordStats(state) {
    if (state.phase !== E.PHASE.GAME_OVER || state.winner === null) return;
    if (stats.games.some((g) => g.id === state.gameId)) return; // idempotent
    stats.games.push({
      id: state.gameId, winner: state.players[state.winner].name,
      players: state.players.map((p) => p.name), at: now(),
    });
    if (stats.games.length > MAX_STATS_GAMES) stats.games.splice(0, stats.games.length - MAX_STATS_GAMES);
    db.set(KEYS.stats, stats);
  }
  function persist() {
    if (!game) return;
    if (mode === 'host') {
      db.set(KEYS.hostSave, {
        v: 1, code: roomCode, rules: draftRules, undoSeq, ts: now(),
        seats: seats.map((s) => ({ seat: s.seat, name: s.name, token: s.token })), game,
      });
    } else if (mode === 'local') {
      db.set(KEYS.localSave, { v: 1, game, config: localConfig, ts: now() });
    }
  }
  function commit(state) {
    const prevCurrent = game ? game.current : null;
    const prevId = game ? game.gameId : null;
    game = state;
    ui.selection = [];
    ui.pickColor = null;
    if (prevId !== state.gameId) rematchSent = false;
    persist();
    recordStats(state);
    if (mode === 'local' && (state.phase === E.PHASE.GAME_OVER || state.current !== ui.viewer)) ui.viewer = null; // hand-off
    screen = 'game';
    const me = mode === 'host' ? 0 : mode === 'guest' ? seat : null;
    if (me !== null && settings.vibrate && state.phase !== E.PHASE.GAME_OVER && state.current === me && prevCurrent !== me) vibrate(150);
    notify();
  }

  // ----- teardown / navigation -----
  function teardown() {
    session++;
    if (room) { room.close(); room = null; }
    if (guestLink) { guestLink.close(); guestLink = null; }
    for (const s of seats) if (s.link) s.link.close();
    seats = []; linkSeat = new Map();
    game = null; mode = null; seat = null; lobby = null; awaySeatsGuest = [];
    snapshot = null; undoBy = null; seenUndoSeq = null; rematchVotes = new Set(); rematchSent = false;
    guestConn = 'idle'; roomCode = null; hostStatus = { state: 'idle', message: '' };
    ui.selection = []; ui.pickColor = null; ui.menu = false; ui.viewer = null; ui.emoji = null;
  }
  function goHome(text) { teardown(); screen = 'home'; notice = text || null; notify(); }
  function go(target) { if (mode) return; screen = target; notice = null; notify(); }

  // ===== local (pass & play) =====
  function startLocal({ names, rules } = {}) {
    teardown();
    const count = Math.max(E.MIN_PLAYERS, Math.min(MAX_LOCAL_PLAYERS, (names || []).length || localSetup.count));
    const list = Array.from({ length: count }, (_, i) => E.sanitizeName((names || [])[i], `Player ${i + 1}`));
    localConfig = { names: list, rules: E.sanitizeRules(rules || draftRules), first: 0 };
    mode = 'local';
    commit(E.createGame({ playerNames: list, rules: localConfig.rules, gameId: newGameId(), firstPlayer: 0 }, random32()));
  }
  function resumeLocal() {
    const save = db.get(KEYS.localSave);
    if (!save || !looksLikeGame(save.game)) { notice = 'No saved local game.'; notify(); return; }
    teardown();
    mode = 'local';
    localConfig = save.config && Array.isArray(save.config.names)
      ? { names: save.config.names, rules: E.sanitizeRules(save.config.rules), first: save.config.first | 0 }
      : { names: save.game.players.map((p) => p.name), rules: save.game.rules, first: 0 };
    commit(save.game);
  }
  function localReady() { if (mode === 'local' && game && ui.viewer === null) { ui.viewer = game.current; notify(); } }

  // ===== host =====
  async function hostCreate({ name } = {}) {
    const nm = E.sanitizeName(name, 'Host');
    settings.name = nm; saveSettings();
    teardown();
    const my = session;
    mode = 'host'; seat = 0; screen = 'lobby'; notice = null;
    seats = [{ seat: 0, name: nm, token: null, link: null }];
    roomCode = P.generateCode(random32);
    hostStatus = { state: 'opening', message: 'Opening the room…' };
    notify();
    await openHostRoom(my);
  }
  async function hostReopen() {
    const save = db.get(KEYS.hostSave);
    if (!save || !looksLikeGame(save.game) || !P.isValidCode(save.code) || !Array.isArray(save.seats) ||
        save.seats.length !== save.game.players.length) {
      notice = 'No saved room to reopen.'; notify(); return;
    }
    teardown();
    const my = session;
    mode = 'host'; seat = 0; notice = null; roomCode = save.code;
    draftRules = E.sanitizeRules(save.rules);
    seats = save.seats.map((s) => ({ seat: s.seat, name: s.name, token: s.token || null, link: null }));
    undoSeq = save.undoSeq | 0;
    hostStatus = { state: 'opening', message: 'Reopening the room…' };
    commit(save.game); // also sets screen = 'game'
    await openHostRoom(my);
  }
  async function openHostRoom(my) {
    let Peer;
    try { Peer = await loadPeer(); } catch { if (my === session) goHome('Could not load the online module. Check your connection.'); return; }
    if (my !== session) return;
    room = openRoom({ Peer, code: roomCode, timers, ...transportOptions });
    room.onStatus((st) => {
      if (my !== session) return;
      hostStatus = st;
      if (st.state === 'failed') goHome(st.message); else notify();
    });
    room.onConnection((link) => { if (my === session) onConnection(link); });
  }

  const lobbyMessage = (s) => ({
    t: 'lobby', code: roomCode, seat: s.seat,
    players: seats.map((x) => ({ name: x.name, connected: connected(x) })), rules: draftRules,
  });
  const stateMessage = (seatId) => ({
    t: 'state', gameId: game.gameId, state: E.redactForPeer(game, seatId), undoBy, undoSeq, away: hostAway(),
  });
  function broadcastLobby() { for (const s of seats) if (s.seat !== 0 && linkOpen(s)) s.link.send(lobbyMessage(s)); }
  function broadcastState() { if (game) for (const s of seats) if (s.seat !== 0 && linkOpen(s)) s.link.send(stateMessage(s.seat)); }
  const uniqueName = (raw) => {
    const taken = new Set(seats.map((s) => s.name.toLowerCase()));
    let n = raw; let i = 2;
    while (taken.has(n.toLowerCase())) { n = `${Array.from(raw).slice(0, E.NAME_MAX_LEN - 3).join('')} ${i++}`; }
    return n;
  };

  function onConnection(link) {
    link.onMessage((raw) => onGuestMessage(link, raw));
    link.onStatus((s) => { if (s === 'closed') onLinkClosed(link); });
  }

  function handleHello(link, msg) {
    let entry = seats.find((s) => s.token === msg.token);
    if (entry) {
      // The most recent connection wins; the old one is closed and its events are ignored.
      if (entry.link && entry.link !== link) { linkSeat.delete(entry.link); entry.link.close(); }
      entry.link = link;
      linkSeat.set(link, entry.seat);
    } else {
      if (game) { link.send({ t: 'error', error: 'This game has already started.', fatal: true }); return; }
      if (seats.length >= MAX_ONLINE_PLAYERS) { link.send({ t: 'error', error: 'The room is full.', fatal: true }); return; }
      entry = { seat: seats.length, name: uniqueName(msg.name), token: msg.token, link };
      seats.push(entry);
      linkSeat.set(link, entry.seat);
    }
    link.send({ t: 'welcome', seat: entry.seat, gameId: game ? game.gameId : null });
    if (game) { link.send(stateMessage(entry.seat)); broadcastState(); } else broadcastLobby();
    notify();
  }

  function onGuestMessage(link, raw) {
    const parsed = P.parseGuestMessage(raw);
    if (!parsed.ok) { link.send({ t: 'error', error: parsed.error }); return; }
    const msg = parsed.msg;
    if (msg.t === 'hello') { handleHello(link, msg); return; }
    const s = linkSeat.get(link);
    if (s === undefined) { link.send({ t: 'error', error: 'Say hello first.' }); return; }
    const reply = (error) => link.send({ t: 'error', error });
    switch (msg.t) {
      case 'action': {
        if (!game) { reply('The game has not started.'); break; }
        if (hostAway().length) { reply('The game is paused until everyone is back.'); break; }
        const r = applyFrom(s, msg.action); // the seat is forced here: a guest cannot move for others
        if (!r.ok) reply(r.error);
        break;
      }
      case 'undo': { const r = doUndo(s); if (!r.ok) reply(r.error); break; }
      case 'rematch':
        if (game && game.phase === E.PHASE.GAME_OVER) { rematchVotes.add(s); notify(); }
        break;
      case 'emoji': hostEmoji(s, msg.e); break;
      default: break;
    }
  }

  function onLinkClosed(link) {
    const s = linkSeat.get(link);
    linkSeat.delete(link);
    if (s === undefined) return; // replaced or never said hello
    const entry = seats[s];
    if (!entry || entry.link !== link) return; // stale close of an old connection
    entry.link = null;
    if (!game) { // lobby: just drop the seat and renumber
      seats.splice(s, 1);
      seats.forEach((x, i) => { x.seat = i; if (x.link) linkSeat.set(x.link, i); });
      for (const x of seats) if (x.seat !== 0 && linkOpen(x)) x.link.send({ t: 'welcome', seat: x.seat, gameId: null });
      broadcastLobby();
    } else {
      broadcastState(); // everyone learns who is away
    }
    notify();
  }

  function startHostGame(firstPlayer) {
    const g = E.createGame({
      playerNames: seats.map((s) => s.name), rules: draftRules, gameId: newGameId(), firstPlayer,
    }, random32());
    snapshot = null; undoBy = null; rematchVotes = new Set();
    commit(g);
    broadcastState();
  }
  function hostStart() {
    if (mode !== 'host' || game || !(seats.length >= 2 && seats.every(connected))) return;
    startHostGame(0);
  }

  function applyFrom(seatId, action) {
    const prev = game;
    const r = E.applyAction(game, { ...action, playerId: seatId });
    if (!r.ok) return { ok: false, error: r.error };
    snapshot = mode === 'host' && action.type === 'PLAY' && r.state.phase !== E.PHASE.GAME_OVER
      ? { state: prev, by: seatId } : null; // undo only covers the last PLAY, never past a game boundary
    commit(r.state);
    if (mode === 'host') broadcastState();
    return { ok: true };
  }

  function doUndo(by) {
    if (!snapshot || snapshot.by !== by || !game || game.phase === E.PHASE.GAME_OVER ||
        game.moveCount !== snapshot.state.moveCount + 1) return { ok: false, error: 'Nothing to undo.' };
    const restored = snapshot.state;
    snapshot = null; undoSeq += 1; undoBy = by;
    commit(restored);
    broadcastState();
    toast(`${nameOf(by)} undid their last move.`);
    return { ok: true };
  }

  function hostEmoji(from, e) {
    const t = now();
    const prev = lastEmojiAt.get(from);
    if (prev !== undefined && t - prev < P.EMOJI_MIN_INTERVAL_MS) return; // 1 per second per player
    lastEmojiAt.set(from, t);
    for (const s of seats) if (s.seat !== from && s.seat !== 0 && linkOpen(s)) s.link.send({ t: 'emoji', e, seat: from });
    showEmoji(from, e);
  }

  function hostRematch() {
    if (mode !== 'host' || !game || game.phase !== E.PHASE.GAME_OVER || hostAway().length) return;
    startHostGame((game.current + 1) % game.players.length);
  }
  function hostPause() { // "Pause and exit": closes the room, keeps the saved game
    if (mode !== 'host') return;
    if (game && game.phase !== E.PHASE.GAME_OVER) persist(); else db.del(KEYS.hostSave);
    goHome();
  }
  function hostEndAll() { // "End game for everyone": deletes the save
    if (mode !== 'host') return;
    for (const s of seats) if (s.seat !== 0 && linkOpen(s)) s.link.send({ t: 'error', error: 'The host ended the game.', fatal: true });
    db.del(KEYS.hostSave);
    const my = session;
    // Give the farewell message a moment to leave before the connections are torn down.
    timers.setTimeout(() => { if (my === session) goHome(); }, 300);
  }

  // ===== guest =====
  async function guestJoin({ code, name } = {}) {
    const c = P.normalizeCode(code);
    if (!P.isValidCode(c)) { notice = 'Invalid room code. It has 5 letters or digits.'; notify(); return false; }
    const nm = E.sanitizeName(name, 'Guest');
    settings.name = nm; saveSettings();
    teardown();
    const my = session;
    mode = 'guest'; screen = 'joining'; roomCode = c; guestName = nm; guestConn = 'connecting'; notice = null;
    notify();
    let Peer;
    try { Peer = await loadPeer(); } catch { if (my === session) goHome('Could not load the online module. Check your connection.'); return false; }
    if (my !== session) return false;
    const saved = db.get(KEYS.guestSession);
    guestToken = saved && saved.code === c && typeof saved.token === 'string' ? saved.token : newToken();
    const link = connectToRoom({ Peer, code: c, timers, ...transportOptions });
    guestLink = link;
    link.onStatus((s, info) => { if (my === session && link === guestLink) onGuestStatus(s, info); });
    link.onMessage((m) => { if (my === session && link === guestLink) onHostMessage(m); });
    return true;
  }
  function onGuestStatus(s, info) {
    if (s === 'open') {
      guestConn = 'open';
      guestLink.send({ t: 'hello', name: guestName, token: guestToken });
    } else if (info && info.final) {
      goHome(info.reason === 'not-found'
        ? 'Room not found. Check the code, and make sure the host has opened the room.'
        : 'Could not connect. Your network may block direct connections (WebRTC without a relay server).');
      return;
    } else {
      guestConn = 'lost';
    }
    notify();
  }
  function onHostMessage(raw) {
    const parsed = P.parseHostMessage(raw);
    if (!parsed.ok) return; // ignore anything that is not a valid host message
    const msg = parsed.msg;
    switch (msg.t) {
      case 'welcome':
        seat = msg.seat;
        db.set(KEYS.guestSession, { code: roomCode, name: guestName, token: guestToken, ts: now() });
        break;
      case 'lobby':
        seat = msg.seat; lobby = { players: msg.players, rules: msg.rules };
        if (!game) screen = 'lobby';
        notify();
        break;
      case 'state': {
        if (msg.state.viewerSeat === null) break;
        seat = msg.state.viewerSeat;
        awaySeatsGuest = msg.away;
        if (seenUndoSeq !== null && msg.undoSeq > seenUndoSeq && msg.undoBy !== null) {
          toast(`${msg.state.players[msg.undoBy].name} undid their last move.`);
        }
        seenUndoSeq = msg.undoSeq;
        commit(msg.state);
        break;
      }
      case 'error':
        if (msg.fatal) {
          const why = msg.error;
          if (guestLink) guestLink.close();
          db.del(KEYS.guestSession);
          goHome(why);
        } else toast(msg.error);
        break;
      case 'emoji': showEmoji(msg.seat, msg.e); break;
      default: break;
    }
  }
  function guestLeave() { // on purpose: forget the session and never reconnect
    db.del(KEYS.guestSession);
    goHome();
  }

  // ===== in-game actions (all modes) =====
  function dispatch(action) {
    if (!game || game.phase === E.PHASE.GAME_OVER) return false;
    const banner = connectionBanner();
    if (banner) { toast(banner); return false; }
    if (mode === 'guest') {
      if (!guestLink || !guestLink.isOpen()) { toast('Connection lost. Reconnecting…'); return false; }
      return guestLink.send({ t: 'action', action });
    }
    if (mode === 'local' && ui.viewer !== game.current) return false;
    const r = applyFrom(mode === 'host' ? 0 : game.current, action);
    if (!r.ok) toast(r.error);
    return r.ok;
  }
  const myHand = () => {
    const v = currentView();
    const s = mode === 'host' ? 0 : mode === 'guest' ? seat : ui.viewer;
    return v && s !== null && v.players[s] && v.players[s].hand ? v.players[s].hand : [];
  };
  const isWildCard = (c) => c && (c.kind === 'wild' || c.kind === 'wild4');

  function attemptPlay(ids) {
    const last = myHand().find((c) => c.id === ids[ids.length - 1]);
    if (isWildCard(last)) { ui.pickColor = { ids: ids.slice() }; notify(); return; }
    ui.selection = [];
    dispatch({ type: 'PLAY', cardIds: ids });
  }
  function selectCard(id) {
    const view = currentView();
    const me = mode === 'host' ? 0 : mode === 'guest' ? seat : ui.viewer;
    if (!view || me === null || view.current !== me || view.phase === E.PHASE.GAME_OVER) return;
    if (isBlocked()) { toast(connectionBanner()); return; }
    const hand = myHand();
    const card = hand.find((c) => c.id === id);
    if (!card) return;
    if (ui.selection.includes(id)) {
      ui.selection = id === ui.selection[0] ? [] : ui.selection.filter((x) => x !== id);
      notify(); return;
    }
    if (ui.selection.length === 0) {
      if (!E.getPlayableCardIds(view, me).includes(id)) { toast("You can't play that card now."); return; }
      if (E.getMultiDropPartners(view, me, id).length === 0) { attemptPlay([id]); return; }
      ui.selection = [id]; notify(); return;
    }
    const lead = hand.find((c) => c.id === ui.selection[0]);
    if (lead && E.valueKey(lead) === E.valueKey(card)) { ui.selection = [...ui.selection, id]; notify(); } else toast('Multi-Drop needs cards of the same value.');
  }
  function playSelected() { if (ui.selection.length) attemptPlay(ui.selection); }
  function clearSelection() { ui.selection = []; ui.pickColor = null; notify(); }
  function chooseColor(color) {
    if (!ui.pickColor || !E.COLORS.includes(color)) return;
    const ids = ui.pickColor.ids;
    ui.pickColor = null; ui.selection = [];
    dispatch({ type: 'PLAY', cardIds: ids, chosenColor: color });
    notify();
  }
  const draw = () => dispatch({ type: 'DRAW' });
  const pass = () => dispatch({ type: 'PASS' });

  function requestUndo() {
    if (mode === 'host') { const r = doUndo(0); if (!r.ok) toast(r.error); return; }
    if (mode === 'guest' && guestLink && guestLink.isOpen()) guestLink.send({ t: 'undo' });
  }
  function requestRematch() {
    if (!game || game.phase !== E.PHASE.GAME_OVER) return;
    if (mode === 'host') hostRematch();
    else if (mode === 'guest') {
      if (guestLink && guestLink.isOpen()) { guestLink.send({ t: 'rematch' }); rematchSent = true; notify(); }
    } else if (mode === 'local' && localConfig) {
      localConfig.first = (localConfig.first + 1) % localConfig.names.length;
      commit(E.createGame({
        playerNames: localConfig.names, rules: localConfig.rules, gameId: newGameId(), firstPlayer: localConfig.first,
      }, random32()));
    }
  }
  let myLastEmojiAt = -Infinity;
  function sendEmoji(e) {
    if (!P.EMOJIS.includes(e) || (mode !== 'host' && mode !== 'guest')) return;
    const t = now();
    if (t - myLastEmojiAt < P.EMOJI_MIN_INTERVAL_MS) return; // rate limit: 1 per second
    myLastEmojiAt = t;
    if (mode === 'guest') { if (guestLink && guestLink.isOpen()) { guestLink.send({ t: 'emoji', e }); showEmoji(seat, e); } return; }
    for (const s of seats) if (s.seat !== 0 && linkOpen(s)) s.link.send({ t: 'emoji', e, seat: 0 });
    showEmoji(0, e);
  }

  // ===== misc UI actions =====
  function toggleRule(key) {
    if (!E.RULE_KEYS.includes(key) || game || (mode !== null && mode !== 'host')) return;
    draftRules = { ...draftRules, [key]: !draftRules[key] };
    if (mode === 'host') broadcastLobby();
    notify();
  }
  function setLocalCount(n) { localSetup = { count: Math.max(2, Math.min(MAX_LOCAL_PLAYERS, n | 0)) }; notify(); }
  function toggleMenu(open) { ui.menu = open === undefined ? !ui.menu : !!open; notify(); }
  function setSetting(key, value) {
    if (key === 'vibrate') settings.vibrate = !!value;
    else if (key === 'theme' && ['auto', 'light', 'dark'].includes(value)) settings.theme = value;
    else return;
    saveSettings(); notify();
  }
  /** The page became visible again: retry connections right now. */
  function nudge() { if (room) room.nudge(); if (guestLink) guestLink.nudge(); }
  /** Leaves the current game/room from the menu, whatever the mode. */
  function quit() {
    if (mode === 'guest') guestLeave();
    else if (mode === 'host') hostPause();
    else goHome();
  }

  return {
    getModel, subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    commit, go, goHome,
    startLocal, resumeLocal, localReady, setLocalCount,
    hostCreate, hostReopen, hostStart, hostPause, hostEndAll,
    guestJoin, guestLeave,
    selectCard, playSelected, clearSelection, chooseColor, draw, pass,
    requestUndo, requestRematch, sendEmoji, toggleRule, toggleMenu, setSetting, nudge, quit, toast,
    // read-only access for tests
    _debug: { get game() { return game; }, get seats() { return seats; }, get stats() { return stats; }, get guestLink() { return guestLink; }, get room() { return room; } },
  };
}
