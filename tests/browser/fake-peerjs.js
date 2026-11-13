// A fake PeerJS for the REAL-BROWSER test. It replaces the CDN script (page.route) and talks
// between tabs of the same browser through BroadcastChannel. It exposes window.Peer like the
// real library and implements the subset of the API the app uses.
// It is a test double: it proves the app's logic in a real browser, NOT that WebRTC works.
(() => {
  const bc = new BroadcastChannel('fake-peerjs-v1');
  const peers = new Map();
  const probes = new Map();
  const rid = () => Math.random().toString(36).slice(2, 10);
  class Emitter {
    constructor() { this._h = {}; }
    on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
    _emit(e, ...a) { (this._h[e] || []).slice().forEach((f) => f(...a)); }
  }
  class Conn extends Emitter {
    constructor(peer, remoteId, cid) { super(); this._peer = peer; this.peer = remoteId; this.cid = cid; this.open = false; this._closed = false; }
    send(data) {
      if (!this.open) throw new Error('Connection is not open.');
      bc.postMessage({ k: 'data', cid: this.cid, to: this.peer, data: JSON.parse(JSON.stringify(data)) });
    }
    close() { this._shut(true); }
    _shut(tell) {
      if (this._closed) return;
      this._closed = true; this.open = false;
      this._peer._conns.delete(this.cid);
      if (tell) bc.postMessage({ k: 'close', cid: this.cid, to: this.peer });
      this._emit('close');
    }
  }
  class Peer extends Emitter {
    constructor(id) {
      super();
      this.id = id || 'anon-' + rid();
      this.open = false; this.destroyed = false; this.disconnected = false;
      this._conns = new Map(); this._lastId = null;
      setTimeout(() => this._register(), 0);
    }
    _register() {
      if (this.destroyed) return;
      const nonce = rid();
      let taken = false;
      probes.set(nonce, () => { taken = true; });
      bc.postMessage({ k: 'probe', id: this.id, nonce });
      setTimeout(() => {
        probes.delete(nonce);
        if (this.destroyed) return;
        if (taken) {
          this._emit('error', { type: 'unavailable-id', message: `ID "${this.id}" is taken` });
          if (this._lastId) this._disc(); else this.destroy();
          return;
        }
        peers.set(this.id, this);
        this.open = true; this.disconnected = false; this._lastId = this.id;
        this._emit('open', this.id);
      }, 150);
    }
    _disc() {
      if (peers.get(this.id) === this) peers.delete(this.id);
      this.open = false; this.disconnected = true;
      this._emit('disconnected', this.id);
    }
    reconnect() {
      if (this.destroyed) throw new Error('This peer cannot reconnect: it has been destroyed.');
      if (!this.disconnected) return;
      this.disconnected = false;
      this._register();
    }
    connect(id) {
      if (this.destroyed || this.disconnected || !this.open) { this._emit('error', { type: 'disconnected' }); return undefined; }
      const cid = rid();
      const c = new Conn(this, id, cid);
      this._conns.set(cid, c);
      bc.postMessage({ k: 'connect', from: this.id, to: id, cid });
      setTimeout(() => {
        if (!c.open && !c._closed) { this._conns.delete(cid); this._emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer ' + id }); }
      }, 500);
      return c;
    }
    destroy() {
      if (this.destroyed) return;
      this.destroyed = true; this.open = false; this.disconnected = true;
      for (const c of [...this._conns.values()]) c._shut(true);
      if (peers.get(this.id) === this) peers.delete(this.id);
      this._emit('close');
    }
  }
  bc.onmessage = (ev) => {
    const m = ev.data;
    if (m.k === 'probe') { const p = peers.get(m.id); if (p && p.open) bc.postMessage({ k: 'owned', nonce: m.nonce }); }
    else if (m.k === 'owned') { const f = probes.get(m.nonce); if (f) f(); }
    else if (m.k === 'connect') {
      const t = peers.get(m.to);
      if (!t || !t.open) return;
      const c = new Conn(t, m.from, m.cid);
      t._conns.set(m.cid, c); c.open = true;
      bc.postMessage({ k: 'accept', cid: m.cid, to: m.from });
      t._emit('connection', c);
      setTimeout(() => c._emit('open'), 0);
    } else if (m.k === 'accept') {
      const p = peers.get(m.to); const c = p && p._conns.get(m.cid);
      if (c && !c.open) { c.open = true; c._emit('open'); }
    } else if (m.k === 'data') {
      const p = peers.get(m.to); const c = p && p._conns.get(m.cid);
      if (c && c.open) c._emit('data', m.data);
    } else if (m.k === 'close') {
      const p = peers.get(m.to); const c = p && p._conns.get(m.cid);
      if (c) c._shut(false);
    }
  };
  window.Peer = Peer;
  // Test hook: simulate a network drop on THIS tab (links die, signalling lost; reconnect() works).
  window.__fakePeerDrop = () => {
    for (const p of [...peers.values()]) {
      for (const c of [...p._conns.values()]) c._shut(true);
      p._emit('error', { type: 'network', message: 'Lost connection to server.' });
      p._disc();
    }
  };
})();
