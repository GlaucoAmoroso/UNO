// =============================================================================
// mock-peer.js - an in-memory fake of PeerJS 1.x, plus a fake clock.
//
// It reproduces the behaviours the adapters must survive:
//   * Peer events: open / connection / disconnected / error / close
//   * DataConnection events: open / data / close / error
//   * error types 'unavailable-id' (id busy) and 'peer-unavailable' (no such room)
//   * a network drop: 'error'(network) then 'disconnected', data connections die
//   * the broker keeping an id busy after an unclean close (killUnclean)
//   * a "black hole": the channel looks open but nothing arrives
// Everything is asynchronous (microtasks) like the real thing, and all time
// comes from FakeClock, so tests are fast and deterministic.
// =============================================================================

/** Lets every pending microtask/macrotask run. */
export const settle = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

export class FakeClock {
  constructor() { this.t = 1_000_000; this.list = []; this.seq = 0; }
  now() { return this.t; }
  _add(fn, ms, every) {
    const id = ++this.seq;
    this.list.push({ id, at: this.t + Math.max(0, Math.floor(ms)), fn, every });
    return id;
  }
  _remove(id) { this.list = this.list.filter((x) => x.id !== id); }
  /** The `timers` object the adapters expect. */
  timers() {
    return {
      setTimeout: (fn, ms) => this._add(fn, ms, null),
      clearTimeout: (id) => this._remove(id),
      setInterval: (fn, ms) => this._add(fn, ms, Math.max(1, Math.floor(ms))),
      clearInterval: (id) => this._remove(id),
      now: () => this.t,
    };
  }
  /** Advances time, running due timers in order and flushing async work between them. */
  async tick(ms) {
    const end = this.t + ms;
    await settle();
    for (let guard = 0; guard < 200000; guard++) {
      let due = null;
      for (const x of this.list) {
        if (x.at <= end && (!due || x.at < due.at || (x.at === due.at && x.id < due.id))) due = x;
      }
      if (!due) break;
      this.t = Math.max(this.t, due.at);
      if (due.every !== null) due.at += due.every; else this._remove(due.id);
      due.fn();
      await settle();
    }
    this.t = end;
    await settle();
  }
}

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return this; }
  _emit(ev, ...args) { for (const f of (this._h[ev] || []).slice()) f(...args); }
}

class MockConn extends Emitter {
  constructor(provider, remoteId) {
    super();
    this.provider = provider;
    this.net = provider.net;
    this.peer = remoteId;
    this.open = false;
    this._closed = false;
    this._remote = null;
  }
  _setOpen() { if (this._closed) return; this.open = true; this._emit('open'); }
  send(data) {
    if (!this.open) throw new Error('Connection is not open.');
    if (this.net.blackhole) return;
    const copy = JSON.parse(JSON.stringify(data)); // serialization: 'json'
    this.net.wire.push({ from: this.provider.id, to: this.peer, data: copy }); // everything that leaves a phone
    const r = this._remote;
    this.net.defer(() => { if (r && r.open) r._emit('data', copy); });
  }
  close() { this._shut(true); }
  _shut(propagate) {
    if (this._closed) return;
    this._closed = true;
    this.open = false;
    this.provider._conns.delete(this);
    this._emit('close');
    // In a black hole nothing reaches the other side, not even a close notification.
    if (propagate && this._remote && !this.net.blackhole) { const r = this._remote; this.net.defer(() => r._shut(false)); }
  }
}

class MockPeer extends Emitter {
  constructor(net, id) {
    super();
    this.net = net;
    this.id = id || `anon-${++net.seq}`;
    this.open = false;
    this.destroyed = false;
    this.disconnected = false;
    this._lastId = null;
    this._conns = new Set();
    net.peers.add(this);
    net.defer(() => this._start());
  }
  _start() {
    if (this.destroyed) return;
    const net = this.net;
    if (net.down) {
      this._emit('error', { type: this._lastId ? 'network' : 'server-error', message: 'Broker unreachable.' });
      if (this._lastId) this._toDisconnected(); else this.destroy();
      return;
    }
    if (net._idTaken(this.id, this)) {
      this._emit('error', { type: 'unavailable-id', message: `ID "${this.id}" is taken` });
      if (this._lastId) this._toDisconnected(); else this.destroy();
      return;
    }
    net.registry.set(this.id, this);
    this.open = true;
    this.disconnected = false;
    this._lastId = this.id;
    this._emit('open', this.id);
  }
  _toDisconnected() {
    if (this.net.registry.get(this.id) === this) this.net.registry.delete(this.id);
    this.open = false;
    this.disconnected = true;
    this._emit('disconnected', this.id);
  }
  reconnect() {
    if (this.destroyed) throw new Error('This peer cannot reconnect to the server. It has already been destroyed.');
    if (!this.disconnected) {
      if (!this.open) return; // "In a hurry? We're still trying to make the initial connection!"
      throw new Error(`Peer ${this.id} cannot reconnect because it is not disconnected from the server!`);
    }
    this.disconnected = false;
    this.net.defer(() => this._start());
  }
  connect(remoteId) {
    if (this.destroyed || this.disconnected || !this.open) {
      this._emit('error', { type: 'disconnected', message: 'Cannot connect: not connected to the server.' });
      return undefined; // like PeerJS
    }
    const conn = new MockConn(this, remoteId);
    this._conns.add(conn);
    this.net.defer(() => this.net._connect(this, conn, remoteId));
    return conn;
  }
  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.open = false;
    this.disconnected = true;
    for (const c of [...this._conns]) c._shut(true);
    if (this.net.registry.get(this.id) === this) this.net.registry.delete(this.id);
    this.net.peers.delete(this);
    this._emit('close');
  }
}

export class MockNetwork {
  constructor(clock) {
    this.clock = clock;
    this.registry = new Map(); // id -> peer registered on the broker
    this.held = new Map();     // id -> time until which the broker keeps the id busy
    this.peers = new Set();
    this.down = false;         // broker unreachable
    this.blackhole = false;    // data silently dropped, connections look open
    this.wire = [];            // log of every message sent, for "what really leaves the phone" checks
    this.seq = 0;
    const net = this;
    this.Peer = class extends MockPeer { constructor(id) { super(net, id); } };
  }
  defer(fn) { queueMicrotask(fn); }
  _idTaken(id, self) {
    const cur = this.registry.get(id);
    if (cur && cur !== self) return true;
    const until = this.held.get(id);
    if (until !== undefined) {
      if (until > this.clock.now()) return true;
      this.held.delete(id);
    }
    return false;
  }
  _connect(from, conn, remoteId) {
    const target = this.registry.get(remoteId);
    if (this.down || from.destroyed || !target || !target.open) {
      from._conns.delete(conn);
      from._emit('error', { type: 'peer-unavailable', message: `Could not connect to peer ${remoteId}` });
      return;
    }
    const remote = new MockConn(target, from.id);
    target._conns.add(remote);
    conn._remote = remote;
    remote._remote = conn;
    target._emit('connection', remote);
    this.defer(() => { conn._setOpen(); remote._setOpen(); });
  }
  /** Simulates a network drop on every phone: data links die, signalling is lost. */
  dropAll({ stayDown = false } = {}) {
    for (const peer of [...this.peers]) {
      if (peer.destroyed) continue;
      for (const c of [...peer._conns]) c._shut(true);
      if (peer.open) {
        peer._emit('error', { type: 'network', message: 'Lost connection to server.' });
        peer._toDisconnected();
      }
    }
    if (stayDown) this.down = true;
  }
  restore() { this.down = false; }
  /** The app was killed without closing: remote ends see a close, the broker keeps the id busy. */
  killUnclean(peer, holdMs = 60000) {
    peer._h = {};
    for (const c of peer._conns) c._h = {};
    for (const c of [...peer._conns]) c._shut(true);
    peer.destroyed = true;
    peer.open = false;
    peer.disconnected = true;
    if (this.registry.get(peer.id) === peer) this.registry.delete(peer.id);
    this.peers.delete(peer);
    this.held.set(peer.id, this.clock.now() + holdMs);
  }
}

/** Convenience: a fresh clock + network + timers. */
export function makeEnv() {
  const clock = new FakeClock();
  const net = new MockNetwork(clock);
  return { clock, net, timers: clock.timers(), Peer: net.Peer };
}
