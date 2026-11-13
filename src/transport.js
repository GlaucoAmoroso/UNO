// =============================================================================
// transport.js - PeerJS (WebRTC) adapters behind a tiny interface.
//
// The store only knows this "Link" interface:
//   { send(msg)->bool, onMessage(fn), onStatus(fn('open'|'closed', info)), isOpen(), close() }
// plus an optional nudge() (retry now) used when the page becomes visible.
//
// PeerJS and the timers are INJECTED (parameters), so tests use a fake PeerJS
// and a fake clock. Nothing here touches the DOM, except loadPeerJS().
//
// Where PeerJS breaks, and what this file does about it:
//  * The free broker keeps an id busy for ~60 s after an unclean close. The host
//    retries 'unavailable-id' every 2 s for ~80 s, then reports a clear error.
//  * Networks drop silently (a WebRTC channel can look open for 30+ s while dead).
//    Every link sends a heartbeat and declares itself closed if it hears nothing.
//  * After a drop PeerJS emits 'error'(network) then 'disconnected'. The host calls
//    peer.reconnect() with backoff; the guest retries every 2.5 s until it is back.
//  * Connecting to a room that does not exist is NOT an exception: status 'closed'.
//  * A guest that leaves on purpose never reconnects.
// =============================================================================
import { roomId } from './protocol.js';

export const PEERJS_URL = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

export const realTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (id) => clearInterval(id),
  now: () => Date.now(),
};

// ICE servers. Passing a config REPLACES PeerJS's built-in list, so the PeerJS defaults
// (Google STUN + the PeerJS TURN relays) are repeated here, plus a free public TURN as a
// second chance for mobile carriers / strict Wi-Fi. Free public relays can be slow or down.
export const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turns:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' },
];
export const PEER_OPTIONS = { debug: 0, config: { iceServers: ICE_SERVERS, iceCandidatePoolSize: 4 } };

export const DEFAULTS = {
  heartbeatMs: 4000,
  heartbeatTimeoutMs: 12000,
  guestRetryMs: 2500,
  guestConnectTimeoutMs: 30000,
  hostBusyRetryMs: 2000,
  hostBusyMaxMs: 80000,
  hostBackoff: [1000, 2000, 4000, 8000, 10000],
  hostReadyWatchdogMs: 15000,
};

/** Loads PeerJS from the CDN (fixed version) only when online mode is opened. */
export function loadPeerJS({ doc = document, win = window, url = PEERJS_URL, timeoutMs = 15000 } = {}) {
  if (win.Peer) return Promise.resolve(win.Peer);
  return new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    let done = false;
    const finish = (fn, arg) => { if (done) return; done = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => finish(reject, new Error('Timed out loading the online module.')), timeoutMs);
    script.src = url;
    script.async = true;
    script.onload = () => (win.Peer ? finish(resolve, win.Peer) : finish(reject, new Error('Online module did not initialise.')));
    script.onerror = () => finish(reject, new Error('Could not load the online module.'));
    doc.head.appendChild(script);
  });
}

// ---------- One data connection -> Link ----------

/** Wraps a PeerJS DataConnection. Adds a heartbeat so dead links are noticed. */
export function createLink(conn, o) {
  const { timers, heartbeatMs, heartbeatTimeoutMs } = o;
  const msgFns = [];
  const statusFns = [];
  let open = false;
  let closed = false;
  let hb = null;
  let lastRx = timers.now();

  const emit = (status, info) => { for (const f of statusFns.slice()) f(status, info); };
  const stopHb = () => { if (hb !== null) { timers.clearInterval(hb); hb = null; } };
  const die = (reason) => {
    if (closed) return;
    closed = true; open = false; stopHb();
    try { conn.close(); } catch { /* already closed */ }
    emit('closed', { reason });
  };
  const startHb = () => {
    stopHb();
    lastRx = timers.now();
    hb = timers.setInterval(() => {
      if (closed) return;
      if (timers.now() - lastRx > heartbeatTimeoutMs) { die('timeout'); return; }
      try { conn.send({ __hb: 1 }); } catch { /* the timeout will catch a dead link */ }
    }, heartbeatMs);
  };

  conn.on('open', () => { if (closed) return; open = true; startHb(); emit('open'); });
  conn.on('data', (d) => {
    if (closed) return;
    lastRx = timers.now();
    if (d && typeof d === 'object' && d.__hb === 1) return; // heartbeat: never reaches the store
    for (const f of msgFns.slice()) f(d);
  });
  conn.on('close', () => die('closed'));
  conn.on('error', () => die('error'));
  if (conn.open) { open = true; startHb(); }

  return {
    peerId: conn.peer,
    send(msg) {
      if (!open || closed) return false;
      try { conn.send(msg); return true; } catch { return false; }
    },
    onMessage(fn) { msgFns.push(fn); },
    onStatus(fn) { statusFns.push(fn); },
    isOpen() { return open && !closed; },
    /** Closing on purpose: no status event is emitted for it. */
    close() {
      if (closed) return;
      closed = true; open = false; stopHb();
      try { conn.close(); } catch { /* already closed */ }
    },
    nudge() {},
  };
}

// ---------- Guest side ----------

/**
 * Connects to a room. Returns a Link that reconnects by itself.
 * Status events: 'open' | 'closed'. A 'closed' with info.final === true is permanent
 * (room not found, initial timeout); otherwise the link is retrying every 2.5 s.
 */
export function connectToRoom({ Peer, code, timers = realTimers, ...opts }) {
  const o = { ...DEFAULTS, ...opts, timers };
  const msgFns = [];
  const statusFns = [];
  let peer = null;
  let inner = null;
  let left = false;
  let finished = false;
  let everOpen = false;
  let lastEmitted = null;
  let retryTimer = null;
  let connectTimer = null;

  const emit = (status, info) => {
    if (status === lastEmitted && !(info && info.final)) return;
    lastEmitted = status;
    for (const f of statusFns.slice()) f(status, info);
  };
  const clearRetry = () => { if (retryTimer !== null) { timers.clearTimeout(retryTimer); retryTimer = null; } };
  const clearConnect = () => { if (connectTimer !== null) { timers.clearTimeout(connectTimer); connectTimer = null; } };
  const destroyPeer = () => {
    const p = peer; peer = null; inner = null;
    if (p) { try { p.destroy(); } catch { /* ignore */ } }
  };
  const alive = () => inner !== null && inner.isOpen();
  const notifyDown = () => { if (everOpen && !alive()) emit('closed', { reason: 'lost' }); };
  const finish = (reason) => {
    if (finished) return;
    finished = true; clearRetry(); clearConnect(); destroyPeer();
    emit('closed', { reason, final: true });
  };
  const scheduleRetry = () => {
    if (left || finished || retryTimer !== null) return;
    retryTimer = timers.setTimeout(() => { retryTimer = null; attempt(); }, o.guestRetryMs);
  };

  function createPeer() {
    if (left || finished) return;
    const p = new Peer(undefined, PEER_OPTIONS);
    peer = p;
    p.on('open', () => { if (peer === p) attempt(); });
    p.on('error', (err) => { if (peer === p) onPeerError(err); });
    p.on('disconnected', () => {
      if (peer !== p || left || finished) return;
      if (alive()) return; // signalling is gone but the data channel still works
      notifyDown(); scheduleRetry();
    });
    p.on('close', () => {
      if (peer !== p) return;
      peer = null; inner = null;
      notifyDown(); scheduleRetry();
    });
  }

  function onPeerError(err) {
    const type = err && err.type;
    if (type === 'peer-unavailable') {
      if (!everOpen) { finish('not-found'); return; } // the room does not exist
      notifyDown(); scheduleRetry(); return;          // host is only temporarily away
    }
    if (alive()) return;                              // an unrelated error on a healthy link
    notifyDown(); scheduleRetry();
  }

  function attempt() {
    if (left || finished) return;
    clearRetry();
    if (alive()) return;
    if (!peer) { createPeer(); return; }
    if (peer.destroyed) { peer = null; createPeer(); return; }
    if (peer.disconnected) {
      try { peer.reconnect(); } catch { destroyPeer(); scheduleRetry(); }
      return; // 'open' fires again and calls attempt()
    }
    if (!peer.open) return; // still starting; 'open' will call attempt()
    let conn;
    try { conn = peer.connect(roomId(code), { reliable: true, serialization: 'json' }); } catch { scheduleRetry(); return; }
    if (!conn) { scheduleRetry(); return; } // PeerJS returns undefined when it is not connected to the broker
    const link = createLink(conn, o);
    inner = link;
    link.onMessage((m) => { if (inner === link) for (const f of msgFns.slice()) f(m); });
    link.onStatus((s) => {
      if (inner !== link) return; // stale connection
      if (s === 'open') { everOpen = true; clearConnect(); emit('open'); return; }
      inner = null; notifyDown(); scheduleRetry();
    });
  }

  connectTimer = timers.setTimeout(() => { connectTimer = null; if (!everOpen) finish('timeout'); }, o.guestConnectTimeoutMs);
  createPeer();

  return {
    send(msg) { return inner ? inner.send(msg) : false; },
    onMessage(fn) { msgFns.push(fn); },
    onStatus(fn) { statusFns.push(fn); },
    isOpen() { return alive(); },
    /** Leaving on purpose: stop everything, never reconnect. */
    close() {
      if (left) return;
      left = true; clearRetry(); clearConnect();
      if (inner) inner.close();
      destroyPeer();
    },
    /** Page became visible again: retry right now instead of waiting for the timer. */
    nudge() { if (!left && !finished && !alive()) attempt(); },
  };
}

// ---------- Host side ----------

/**
 * Registers the room id "uno-<CODE>" and hands out one Link per incoming connection.
 * room.onStatus gets { state: 'opening'|'ready'|'busy'|'reconnecting'|'failed'|'closed', message }.
 */
export function openRoom({ Peer, code, timers = realTimers, ...opts }) {
  const o = { ...DEFAULTS, ...opts, timers };
  const connFns = [];
  const statusFns = [];
  let peer = null;
  let closed = false;
  let ready = false;
  let busyStart = null;
  let backoffIdx = 0;
  let retryTimer = null;
  let reconnectTimer = null;
  let watchdog = null;
  let last = { state: 'opening', message: 'Opening the room…' };

  const emit = (state, message) => { last = { state, message: message || '' }; for (const f of statusFns.slice()) f(last); };
  const clear = (t) => { if (t !== null) timers.clearTimeout(t); return null; };
  const dropPeer = () => {
    watchdog = clear(watchdog);
    const p = peer; peer = null;
    if (p) { try { p.destroy(); } catch { /* ignore */ } }
  };
  const fail = (message) => { dropPeer(); closed = true; retryTimer = clear(retryTimer); reconnectTimer = clear(reconnectTimer); emit('failed', message); };
  const armWatchdog = () => {
    watchdog = clear(watchdog);
    watchdog = timers.setTimeout(() => { watchdog = null; if (!closed && !ready) { dropPeer(); create(); } }, o.hostReadyWatchdogMs);
  };

  function scheduleReconnect() {
    if (closed || reconnectTimer !== null) return;
    const d = o.hostBackoff[Math.min(backoffIdx++, o.hostBackoff.length - 1)];
    reconnectTimer = timers.setTimeout(() => {
      reconnectTimer = null;
      if (closed || ready) return;
      const p = peer;
      if (!p || p.destroyed) { peer = null; create(); return; }
      if (p.disconnected) {
        try { p.reconnect(); } catch { dropPeer(); create(); return; }
      }
      armWatchdog();
    }, d);
  }

  function onError(p, err) {
    const type = err && err.type;
    if (type === 'unavailable-id') {
      const t = timers.now();
      if (busyStart === null) busyStart = t;
      if (t - busyStart >= o.hostBusyMaxMs) {
        fail('The previous session still holds this room. Wait a minute and try again.');
        return;
      }
      emit('busy', 'The previous session is still holding the room, retrying…');
      dropPeer();
      retryTimer = timers.setTimeout(() => { retryTimer = null; create(); }, o.hostBusyRetryMs);
      return;
    }
    if (type === 'invalid-id' || type === 'invalid-key' || type === 'browser-incompatible' || type === 'ssl-unavailable') {
      fail(`Cannot open the room (${type}).`);
      return;
    }
    // network, socket-error, socket-closed, server-error, ...
    if (p.destroyed) { peer = null; ready = false; emit('reconnecting', 'Connection to the room server lost. Reconnecting…'); scheduleReconnect(); }
    else if (p.disconnected) { ready = false; emit('reconnecting', 'Connection to the room server lost. Reconnecting…'); scheduleReconnect(); }
    // otherwise: a non-fatal error on one data connection; nothing to do
  }

  function create() {
    if (closed) return;
    const p = new Peer(roomId(code), PEER_OPTIONS);
    peer = p;
    p.on('open', () => {
      if (peer !== p || closed) return;
      ready = true; busyStart = null; backoffIdx = 0;
      watchdog = clear(watchdog); reconnectTimer = clear(reconnectTimer);
      emit('ready', '');
    });
    p.on('connection', (conn) => {
      if (peer !== p || closed) return;
      const link = createLink(conn, o);
      for (const f of connFns.slice()) f(link);
    });
    p.on('disconnected', () => {
      if (peer !== p || closed) return;
      ready = false;
      emit('reconnecting', 'Connection to the room server lost. Reconnecting…');
      scheduleReconnect();
    });
    p.on('error', (err) => { if (peer === p && !closed) onError(p, err); });
    p.on('close', () => {
      if (peer !== p || closed) return;
      peer = null; ready = false;
      emit('reconnecting', 'Connection to the room server lost. Reconnecting…');
      scheduleReconnect();
    });
    armWatchdog();
  }

  create();

  return {
    code,
    onConnection(fn) { connFns.push(fn); },
    onStatus(fn) { statusFns.push(fn); },
    status() { return last; },
    isReady() { return ready && !closed; },
    /** Page became visible again: do not wait for the backoff timer. */
    nudge() {
      if (closed || ready) return;
      reconnectTimer = clear(reconnectTimer);
      backoffIdx = 0;
      const p = peer;
      if (!p || p.destroyed) { peer = null; create(); return; }
      if (p.disconnected) { try { p.reconnect(); } catch { dropPeer(); create(); } }
    },
    close() {
      if (closed) return;
      closed = true; ready = false;
      retryTimer = clear(retryTimer); reconnectTimer = clear(reconnectTimer);
      dropPeer();
      emit('closed', '');
    },
  };
}
