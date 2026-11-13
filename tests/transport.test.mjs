// Adapter tests: real transport.js on the fake PeerJS and the fake clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openRoom, connectToRoom } from '../src/transport.js';
import { makeEnv, settle } from './mock-peer.js';

const CODE = 'ABCDE';

/** Opens a room and records its links, statuses and messages. */
function startHost(env, extra = {}) {
  const host = { links: [], statuses: [], got: [] };
  host.room = openRoom({ Peer: env.Peer, code: CODE, timers: env.timers, ...extra });
  host.room.onStatus((s) => host.statuses.push(s.state));
  host.room.onConnection((link) => {
    host.links.push(link);
    link.onMessage((m) => host.got.push(m));
    link.onStatus((s, info) => host.statuses.push(`link:${s}${info && info.reason ? ':' + info.reason : ''}`));
  });
  return host;
}
function startGuest(env, extra = {}) {
  const guest = { statuses: [], got: [] };
  guest.link = connectToRoom({ Peer: env.Peer, code: CODE, timers: env.timers, ...extra });
  guest.link.onStatus((s, info) => guest.statuses.push(info && info.reason ? `${s}:${info.reason}` : s));
  guest.link.onMessage((m) => guest.got.push(m));
  return guest;
}

test('messages flow in both directions and are copied (JSON serialization)', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);
  assert.ok(host.room.isReady());
  assert.ok(guest.link.isOpen());
  assert.equal(host.links.length, 1);

  const payload = { t: 'hello', n: [1, 2, 3] };
  assert.equal(guest.link.send(payload), true);
  payload.n.push(99); // mutation after sending must not leak
  await settle();
  assert.deepEqual(host.got, [{ t: 'hello', n: [1, 2, 3] }]);

  assert.equal(host.links[0].send({ t: 'welcome', seat: 1 }), true);
  await settle();
  assert.deepEqual(guest.got, [{ t: 'welcome', seat: 1 }]);
});

test('heartbeats keep an idle link alive and never reach the application', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);
  await env.clock.tick(120000); // two idle minutes
  assert.ok(guest.link.isOpen());
  assert.ok(host.links[0].isOpen());
  assert.deepEqual(host.got, []);
  assert.deepEqual(guest.got, []);
  assert.equal(host.links.length, 1, 'no reconnects happened');
});

test('a room that does not exist gives status closed (final), not an exception', async () => {
  const env = makeEnv();
  const guest = startGuest(env);
  await env.clock.tick(1000);
  assert.deepEqual(guest.statuses, ['closed:not-found']);
  assert.equal(guest.link.isOpen(), false);
  assert.equal(guest.link.send({ t: 'x' }), false);
  const peersBefore = env.net.peers.size;
  await env.clock.tick(60000); // and it never retries on its own
  assert.deepEqual(guest.statuses, ['closed:not-found']);
  assert.equal(env.net.peers.size, peersBefore);
});

test('initial connection times out after 30 s when the broker is unreachable', async () => {
  const env = makeEnv();
  env.net.down = true;
  const guest = startGuest(env);
  await env.clock.tick(29000);
  assert.deepEqual(guest.statuses, []);
  await env.clock.tick(2000);
  assert.deepEqual(guest.statuses, ['closed:timeout']);
});

test('host: a busy id is retried every 2 s and succeeds when the broker lets go', async () => {
  const env = makeEnv();
  env.net.held.set('uno-' + CODE, env.clock.now() + 60000);
  const host = startHost(env);
  await env.clock.tick(1000);
  assert.equal(host.room.status().state, 'busy');
  assert.match(host.room.status().message, /previous session is still holding the room/i);
  await env.clock.tick(30000);
  assert.equal(host.room.status().state, 'busy');
  await env.clock.tick(32000);
  assert.equal(host.room.status().state, 'ready');
  assert.ok(host.room.isReady());
});

test('host: a busy id gives a clear error after ~80 s', async () => {
  const env = makeEnv();
  env.net.held.set('uno-' + CODE, env.clock.now() + 10 * 60000);
  const host = startHost(env);
  await env.clock.tick(70000);
  assert.equal(host.room.status().state, 'busy');
  await env.clock.tick(30000);
  assert.equal(host.room.status().state, 'failed');
  assert.match(host.room.status().message, /still holds this room/i);
  assert.equal(host.room.isReady(), false);
});

test('host reopens the same code after an unclean kill and the guest rejoins by itself', async () => {
  const env = makeEnv();
  const host1 = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);
  assert.ok(guest.link.isOpen());

  const hostPeer = [...env.net.peers].find((p) => p.id === 'uno-' + CODE);
  env.net.killUnclean(hostPeer, 60000); // the host app was killed
  host1.room.close();
  await env.clock.tick(1000);
  assert.equal(guest.link.isOpen(), false);

  const host2 = startHost(env); // reopened with the same code
  await env.clock.tick(1000);
  assert.equal(host2.room.status().state, 'busy');
  await env.clock.tick(70000);
  assert.equal(host2.room.status().state, 'ready');
  await env.clock.tick(5000);
  assert.ok(guest.link.isOpen(), 'guest came back on its own');
  assert.equal(host2.links.length, 1);
});

test('three network drops in a row: both sides reconnect and messages flow again', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);

  for (let i = 1; i <= 3; i++) {
    env.net.dropAll();
    await settle();
    assert.equal(guest.link.isOpen(), false, `drop ${i}: guest sees the loss`);
    assert.equal(host.links[host.links.length - 1].isOpen(), false, `drop ${i}: host sees the loss`);
    await env.clock.tick(15000);
    assert.ok(host.room.isReady(), `drop ${i}: host ready again`);
    assert.ok(guest.link.isOpen(), `drop ${i}: guest reconnected`);
    const link = host.links[host.links.length - 1];
    assert.equal(guest.link.send({ t: 'ping', i }), true);
    await settle();
    assert.deepEqual(host.got[host.got.length - 1], { t: 'ping', i });
    assert.equal(link.send({ t: 'pong', i }), true);
    await settle();
    assert.deepEqual(guest.got[guest.got.length - 1], { t: 'pong', i });
  }
  assert.equal(host.links.length, 4, 'one link per (re)connection');
  assert.ok(guest.statuses.filter((s) => s === 'closed:lost').length >= 3);
});

test('a long outage (broker down for 40 s) is survived', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);
  env.net.dropAll({ stayDown: true });
  await env.clock.tick(40000);
  assert.equal(guest.link.isOpen(), false);
  assert.notEqual(host.room.status().state, 'ready');
  env.net.restore();
  await env.clock.tick(30000);
  assert.ok(host.room.isReady());
  assert.ok(guest.link.isOpen());
});

test('a silently dead link (black hole) is detected by the heartbeat, then recovers', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);
  env.net.blackhole = true;
  await env.clock.tick(10000);
  assert.ok(guest.link.isOpen(), 'not yet: the timeout is 12 s');
  await env.clock.tick(6000);
  assert.equal(guest.link.isOpen(), false);
  assert.equal(host.links[0].isOpen(), false);
  assert.ok(host.statuses.includes('link:closed:timeout'));
  env.net.blackhole = false;
  await env.clock.tick(10000);
  assert.ok(guest.link.isOpen());
});

test('the most recent connection wins: links are independent and a stale close is harmless', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const g1 = startGuest(env);
  await env.clock.tick(1000);
  const g2 = startGuest(env); // same person reconnecting from a fresh page
  await env.clock.tick(1000);
  assert.equal(host.links.length, 2);
  host.links[0].close(); // what the store does when a newer link takes the seat
  await env.clock.tick(1000);
  assert.equal(host.links[1].isOpen(), true);
  assert.equal(g2.link.isOpen(), true);
  assert.equal(host.statuses.filter((s) => s.startsWith('link:closed')).length, 0, 'closing on purpose emits no status');
  assert.ok(g1.link); // g1 is retained only to show it existed
});

test('a guest that leaves on purpose never reconnects', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);
  guest.link.close();
  await env.clock.tick(1000);
  assert.ok(host.statuses.includes('link:closed:closed'), 'host notices the departure');
  const peers = env.net.peers.size;
  guest.link.nudge(); // e.g. the page becomes visible again: must NOT bring the link back to life
  await env.clock.tick(5000);
  assert.equal(host.links.length, 1, 'nudge after leaving did not reconnect');
  assert.equal(env.net.peers.size, peers);
  await env.clock.tick(120000);
  assert.equal(host.links.length, 1, 'no zombie reconnection');
  assert.equal(env.net.peers.size, peers);
  assert.equal(guest.link.isOpen(), false);
  assert.equal(guest.link.send({ t: 'x' }), false);
});

test('nudge() retries immediately instead of waiting for the timer', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);
  env.net.dropAll();
  await env.clock.tick(1200); // host is back, guest still waiting for its 2.5 s timer
  assert.ok(host.room.isReady());
  assert.equal(guest.link.isOpen(), false);
  guest.link.nudge();
  await env.clock.tick(100);
  assert.ok(guest.link.isOpen());
});

test('closing the room closes its links and reports status closed', async () => {
  const env = makeEnv();
  const host = startHost(env);
  const guest = startGuest(env);
  await env.clock.tick(1000);
  host.room.close();
  await env.clock.tick(1000);
  assert.equal(host.room.status().state, 'closed');
  assert.equal(guest.link.isOpen(), false);
  assert.equal(host.room.isReady(), false);
});
