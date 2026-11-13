// =============================================================================
// ui.js - the UI as pure functions.
//
//   render(model) -> HTML string          (no DOM access; every dynamic text is escaped)
//   act(store, name, data) -> void        (what a click does; data = data-* attributes
//                                          plus the values of the inputs named in data-fields)
//
// Controls are plain elements with data-act="...". app.js wires one click listener
// on the root; tests "click" by parsing the HTML and calling act(), so a Node test
// can only use controls the UI really shows (and not disabled ones).
//
// Hidden information: render() only ever receives model.view (already redacted),
// so other players' cards cannot appear in the HTML. Card ids are only printed
// for the viewer's own hand.
// =============================================================================
import { esc } from './protocol.js';

export const RULES_INFO = [
  { key: 'multiDrop', title: 'Multi-Drop', desc: 'Play several cards with the same number or symbol at once.' },
  { key: 'stackDraw2', title: 'Stacking +2', desc: 'Answer a +2 with another +2 and pass the penalty on.' },
  { key: 'brutalDraw4', title: 'Brutal +4', desc: 'A +4 can go on a +4 or on a +2. A +2 can never go on a +4.' },
  { key: 'twoPlayerBounce', title: '2-player Skip bounce', desc: 'With two players, Skip and Reverse give you another turn.' },
];
const COLOR_NAME = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' };
const SYMBOL = { skip: '⊘', reverse: '⇄', draw2: '+2', wild: '★', wild4: '+4' };
const KIND_NAME = { skip: 'Skip', reverse: 'Reverse', draw2: 'Draw Two', wild: 'Wild', wild4: 'Wild Draw Four' };

// ---------- cards ----------

const faceText = (c) => (c.kind === 'number' ? String(c.value) : SYMBOL[c.kind]);
const cardName = (c) => `${c.color ? COLOR_NAME[c.color] + ' ' : ''}${c.kind === 'number' ? c.value : KIND_NAME[c.kind]}`;
const colorClass = (c) => (c.color ? `c-${c.color}` : 'c-wild');

function cardFace(c) {
  const t = esc(faceText(c));
  return `<span class="corner">${t}</span><span class="face">${t}</span><span class="corner br">${t}</span>`;
}
function handCard(c, m) {
  const playable = m.playable.includes(c.id);
  const classes = ['card', colorClass(c)];
  if (playable) classes.push('playable');
  else if (m.myTurn) classes.push('dim');
  if (m.selection.includes(c.id)) classes.push('sel');
  else if (m.partners.includes(c.id)) classes.push('partner');
  return `<button type="button" class="${classes.join(' ')}" data-act="card" data-id="${c.id}" data-playable="${playable ? 1 : 0}"` +
    `${m.myTurn ? '' : ' disabled'} aria-label="${esc(cardName(c))}">${cardFace(c)}</button>`;
}
const staticCard = (c, extra = '') => `<div class="card big ${colorClass(c)} ${extra}" role="img" aria-label="${esc(cardName(c))}">${cardFace(c)}</div>`;

// ---------- small pieces ----------

const btn = (label, act, attrs = '', cls = 'btn') => `<button type="button" class="${cls}" data-act="${act}" ${attrs}>${label}</button>`;

function rulesToggles(m, editable) {
  return `<div class="rules">${RULES_INFO.map((r) => {
    const on = m.rules[r.key] === true;
    return `<button type="button" class="toggle${on ? ' on' : ''}" data-act="rule" data-rule="${r.key}" role="switch" aria-checked="${on}"` +
      `${editable ? '' : ' disabled'}><span class="t-title">${esc(r.title)}</span><span class="t-desc">${esc(r.desc)}</span>` +
      `<span class="t-state">${on ? 'ON' : 'OFF'}</span></button>`;
  }).join('')}</div>`;
}
const noticeHtml = (m) => (m.notice ? `<p class="notice" role="alert">${esc(m.notice)}</p>` : '');
const toastHtml = (m) => (m.toast ? `<div class="toast" role="status">${esc(m.toast)}</div>` : '');
const bannerHtml = (m) => (m.banner ? `<div class="banner" role="status">${esc(m.banner)}</div>` : '');
const header = (title, back) => `<header class="bar">${back ? btn('‹ Back', 'nav', 'data-to="home"', 'btn ghost') : '<span></span>'}<h2>${esc(title)}</h2><span></span></header>`;

// ---------- screens ----------

function home(m) {
  const s = m.saves;
  const resume = [
    s.local ? btn('Resume local game', 'resume-local', '', 'btn') : '',
    s.host ? btn(`Reopen room ${esc(s.host.code)}`, 'reopen', '', 'btn') : '',
    s.guest ? btn(`Rejoin room ${esc(s.guest.code)}`, 'rejoin', '', 'btn') : '',
  ].join('');
  const top = m.stats.top.length
    ? `<p class="muted small">Games played: ${m.stats.played} · ${m.stats.top.map(([n, w]) => `${esc(n)} ${w}`).join(' · ')}</p>`
    : '';
  return `<main class="screen home">
    <div class="logo" aria-hidden="true"><i class="c-red"></i><i class="c-yellow"></i><i class="c-green"></i><i class="c-blue"></i></div>
    <h1>Color Rush</h1>
    <p class="muted">A fast card game for 2–6 players, with your own house rules.</p>
    ${noticeHtml(m)}
    <div class="stack">
      ${btn('Pass &amp; Play on this phone', 'nav', 'data-to="setup-local"', 'btn primary')}
      ${btn('Host an online game', 'nav', 'data-to="setup-host"', 'btn')}
      ${btn('Join an online game', 'nav', 'data-to="setup-join"', 'btn')}
      ${resume}
    </div>
    ${top}
    <div class="row">${btn('Settings', 'menu', '', 'btn ghost')}</div>
    ${menuOverlay(m)}
  </main>`;
}

function setupLocal(m) {
  const n = m.localSetup.count;
  const counts = [2, 3, 4, 5, 6].map((k) => `<button type="button" class="chip${k === n ? ' on' : ''}" data-act="count" data-n="${k}">${k}</button>`).join('');
  const inputs = Array.from({ length: n }, (_, i) =>
    `<label class="field"><span>Player ${i + 1}</span><input data-field="n${i}" maxlength="16" autocomplete="off" placeholder="Player ${i + 1}"></label>`).join('');
  return `<main class="screen">${header('Pass & Play', true)}${noticeHtml(m)}
    <h3>Players</h3><div class="chips">${counts}</div>${inputs}
    <h3>House rules</h3>${rulesToggles(m, true)}
    ${btn('Start game', 'start-local', `data-fields="${Array.from({ length: n }, (_, i) => `n${i}`).join(',')}"`, 'btn primary wide')}
  </main>`;
}

function setupHost(m) {
  return `<main class="screen">${header('Host an online game', true)}${noticeHtml(m)}
    <label class="field"><span>Your name</span><input data-field="name" maxlength="16" autocomplete="nickname" value="${esc(m.settings.name)}" placeholder="Your name"></label>
    <p class="muted small">Both phones need internet. The connection is direct (WebRTC); on some mobile or company networks it may fail because there is no relay server.</p>
    ${btn('Create room', 'host-create', 'data-fields="name"', 'btn primary wide')}
  </main>`;
}

function setupJoin(m) {
  return `<main class="screen">${header('Join an online game', true)}${noticeHtml(m)}
    <label class="field"><span>Room code</span><input class="code-input" data-field="code" maxlength="12" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="ABCDE"></label>
    <label class="field"><span>Your name</span><input data-field="name" maxlength="16" autocomplete="nickname" value="${esc(m.settings.name)}" placeholder="Your name"></label>
    ${btn('Join', 'join', 'data-fields="code,name"', 'btn primary wide')}
  </main>`;
}

function joining(m) {
  return `<main class="screen center"><div class="spinner" aria-hidden="true"></div>
    <h2>Connecting to room ${esc(m.roomCode)}…</h2>
    <p class="muted">This can take a few seconds.</p>
    ${btn('Cancel', 'quit', '', 'btn')}</main>`;
}

function lobby(m) {
  const players = m.lobbyPlayers.map((p) =>
    `<li class="${p.connected ? '' : 'away'}"><span class="dot"></span>${esc(p.name)}${p.seat === 0 ? ' <small>(host)</small>' : ''}${p.connected ? '' : ' <small>reconnecting…</small>'}</li>`).join('');
  const status = m.isHost && m.hostStatus.state !== 'ready'
    ? `<div class="banner" role="status">${esc(m.hostStatus.message || 'Opening the room…')}</div>` : '';
  const hostBlock = m.isHost
    ? `<div class="code-box"><span class="muted small">Room code</span><div class="code" aria-label="Room code">${esc(m.roomCode)}</div>
         <div class="row">${btn('Copy', 'copy', `data-text="${esc(m.roomCode)}"`, 'btn')}${btn('Share', 'share', `data-text="${esc(m.roomCode)}"`, 'btn')}</div></div>`
    : `<p class="muted center-text">Room <strong>${esc(m.roomCode)}</strong></p>`;
  const action = m.isHost
    ? btn(m.canStart ? 'Start game' : 'Waiting for a player…', 'lobby-start', m.canStart ? '' : 'disabled', 'btn primary wide')
    : '<p class="muted center-text">Waiting for the host to start the game…</p>';
  return `<main class="screen">${header('Lobby', false)}${noticeHtml(m)}${status}${hostBlock}
    <h3>Players</h3><ul class="players">${players}</ul>
    <h3>House rules</h3>${rulesToggles(m, m.isHost)}
    ${action}
    ${btn(m.isHost ? 'Close room' : 'Leave', 'quit', '', 'btn ghost wide')}
    ${toastHtml(m)}</main>`;
}

function handoff(m) {
  return `<main class="screen center"><p class="muted">Pass the phone to</p>
    <div class="big-name">${esc(m.handoff.name)}</div>
    ${btn("I'm ready", 'ready', '', 'btn primary big')}
    ${btn('Menu', 'menu', '', 'btn ghost')}
    ${menuOverlay(m)}</main>`;
}

function lastMoveText(v, me) {
  const lm = v.lastMove;
  if (!lm) return 'Game started.';
  const who = lm.by === me ? 'You' : esc(v.players[lm.by].name);
  if (lm.type === 'PLAY') {
    const last = lm.cards[lm.cards.length - 1];
    return `${who} played ${esc(cardName(last))}${lm.cards.length > 1 ? ` ×${lm.cards.length}` : ''}`;
  }
  if (lm.type === 'DRAW') return `${who} drew ${lm.count} card${lm.count === 1 ? '' : 's'}`;
  return `${who} passed`;
}

function game(m) {
  const v = m.view;
  const me = m.mySeat;
  const cur = v.players[v.current];
  const status = m.over ? 'Game over' : (m.myTurn ? 'Your turn' : `${esc(cur.name)}'s turn`);
  const opponents = v.players.filter((p) => p.id !== me).map((p) => {
    const bubble = m.emoji && m.emoji.seat === p.id ? `<span class="bubble">${esc(m.emoji.e)}</span>` : '';
    return `<div class="opp${p.id === v.current && !m.over ? ' turn' : ''}"><span class="oname">${esc(p.name)}</span><span class="ocount" aria-label="${p.handCount} cards">${p.handCount}</span>${bubble}</div>`;
  }).join('');
  const top = v.discardPile[0];
  const penalty = v.penalty.amount > 0 ? `<div class="penalty" aria-label="Penalty">+${v.penalty.amount}</div>` : '';
  const canDraw = m.myTurn && v.phase !== 'DREW';
  const drawLabel = v.penalty.amount > 0 ? `Draw ${v.penalty.amount}` : 'Draw';
  const hand = me !== null && v.players[me].hand ? v.players[me].hand : [];
  const myBubble = m.emoji && m.emoji.seat === me ? `<span class="bubble me">${esc(m.emoji.e)}</span>` : '';
  const actions = [
    m.selection.length ? btn(`Play ${m.selection.length}`, 'play', '', 'btn primary') : '',
    m.selection.length ? btn('Cancel', 'clear', '', 'btn ghost') : '',
    m.myTurn && v.phase === 'DREW' ? btn('Pass', 'pass', '', 'btn') : '',
    m.canUndo ? btn('Undo', 'undo', '', 'btn ghost') : '',
  ].join('');
  const emojiBar = m.mode === 'host' || m.mode === 'guest'
    ? `<div class="emojis">${m.emojis.map((e) => `<button type="button" class="emoji" data-act="emoji" data-e="${esc(e)}" aria-label="Send ${esc(e)}">${esc(e)}</button>`).join('')}</div>` : '';
  return `<main class="game${m.blocked ? ' blocked' : ''}">
    <header class="topbar">${btn('☰', 'menu', 'aria-label="Menu"', 'btn icon')}<div class="status${m.myTurn ? ' mine' : ''}">${status}</div><div class="dir" title="Direction">${v.direction === 1 ? '↻' : '↺'}</div></header>
    ${bannerHtml(m)}
    <section class="opps">${opponents}</section>
    <section class="table">
      ${btn(`<span class="pile-label">${esc(drawLabel)}</span><small>${v.drawCount} left</small>`, 'draw', `${canDraw ? '' : 'disabled'}`, 'pile draw')}
      <div class="discard">${staticCard(top, 'top')}<span class="active c-${esc(v.activeColor)}" aria-label="Active color ${esc(COLOR_NAME[v.activeColor])}"></span></div>
      ${penalty}
    </section>
    <p class="lastmove">${lastMoveText(v, me)}</p>
    ${toastHtml(m)}
    <section class="hand-wrap">${myBubble}<div class="hand" aria-label="Your hand">${hand.map((c) => handCard(c, m)).join('')}</div></section>
    <footer class="actions">${actions}</footer>
    ${emojiBar}
    ${m.pickColor ? colorPicker() : ''}
    ${m.over ? gameOver(m) : ''}
    ${menuOverlay(m)}
  </main>`;
}

function colorPicker() {
  return `<div class="overlay"><div class="sheet"><h3>Choose a color</h3><div class="colors">${
    ['red', 'yellow', 'green', 'blue'].map((c) => `<button type="button" class="swatch c-${c}" data-act="color" data-color="${c}" aria-label="${COLOR_NAME[c]}">${COLOR_NAME[c]}</button>`).join('')
  }</div>${btn('Cancel', 'clear', '', 'btn ghost')}</div></div>`;
}

function gameOver(m) {
  const v = m.view;
  const winner = v.winner !== null ? esc(v.players[v.winner].name) : '';
  const youWon = m.mySeat !== null && v.winner === m.mySeat;
  const votes = m.mode === 'host' && m.rematchVotes.length ? `<p class="muted small">${m.rematchVotes.map(esc).join(', ')} want a rematch.</p>` : '';
  const sent = m.mode === 'guest' && m.rematchSent ? '<p class="muted small">Rematch requested. Waiting for the host…</p>' : '';
  const top = m.stats.top.length ? `<p class="muted small">Games played: ${m.stats.played} · ${m.stats.top.map(([n, w]) => `${esc(n)} ${w}`).join(' · ')}</p>` : '';
  return `<div class="overlay"><div class="sheet over"><div class="trophy" aria-hidden="true">🏆</div>
    <h2>${winner} wins!</h2>${youWon ? '<p class="muted">Nicely played.</p>' : ''}${top}${votes}${sent}
    ${m.canRematch ? btn(m.mode === 'guest' ? (m.rematchSent ? 'Rematch requested' : 'Ask for a rematch') : 'Rematch', 'rematch', m.mode === 'guest' && m.rematchSent ? 'disabled' : '', 'btn primary wide')
      : '<p class="muted small">Waiting for everyone to be back…</p>'}
    ${btn('Home', 'quit', '', 'btn ghost wide')}</div></div>`;
}

function menuOverlay(m) {
  if (!m.menu) return '';
  const inGame = m.mode !== null;
  const themeLabel = { auto: 'Auto', light: 'Light', dark: 'Dark' }[m.settings.theme];
  const rules = inGame && m.view ? `<h3>House rules</h3><ul class="rule-list">${RULES_INFO.map((r) => `<li class="${m.rules[r.key] ? 'on' : 'off'}">${esc(r.title)}: ${m.rules[r.key] ? 'on' : 'off'}</li>`).join('')}</ul>` : '';
  const exit = !inGame ? ''
    : m.mode === 'host' ? `${btn('Pause and exit', 'quit', '', 'btn wide')}${btn('End game for everyone', 'end-all', '', 'btn danger wide')}`
      : m.mode === 'guest' ? btn('Leave game', 'quit', '', 'btn danger wide')
        : btn('Quit to home', 'quit', '', 'btn wide');
  return `<div class="overlay"><div class="sheet"><h3>Menu</h3>
    <button type="button" class="toggle${m.settings.vibrate ? ' on' : ''}" data-act="vibrate" role="switch" aria-checked="${m.settings.vibrate}"><span class="t-title">Vibrate on my turn</span><span class="t-desc">Uses a little battery.</span><span class="t-state">${m.settings.vibrate ? 'ON' : 'OFF'}</span></button>
    ${btn(`Theme: ${themeLabel}`, 'theme', '', 'btn wide')}
    ${rules}${exit}${btn('Close', 'menu-close', '', 'btn ghost wide')}</div></div>`;
}

// ---------- entry points ----------

export function render(m) {
  switch (m.screen) {
    case 'setup-local': return setupLocal(m);
    case 'setup-host': return setupHost(m);
    case 'setup-join': return setupJoin(m);
    case 'joining': return joining(m);
    case 'lobby': return lobby(m);
    case 'game':
      if (m.handoff) return handoff(m);
      return game(m);
    default: return home(m);
  }
}

/** What each control does. `d` holds data-* attributes plus the values of data-fields inputs. */
export function act(store, name, d = {}) {
  switch (name) {
    case 'nav': if (d.to === 'home') store.goHome(); else store.go(d.to); break;
    case 'count': store.setLocalCount(Number(d.n)); break;
    case 'start-local': {
      const n = store.getModel().localSetup.count;
      store.startLocal({ names: Array.from({ length: n }, (_, i) => d[`n${i}`]) });
      break;
    }
    case 'host-create': store.hostCreate({ name: d.name }); break;
    case 'join': store.guestJoin({ code: d.code, name: d.name }); break;
    case 'rule': store.toggleRule(d.rule); break;
    case 'lobby-start': store.hostStart(); break;
    case 'card': store.selectCard(Number(d.id)); break;
    case 'play': store.playSelected(); break;
    case 'clear': store.clearSelection(); break;
    case 'draw': store.draw(); break;
    case 'pass': store.pass(); break;
    case 'color': store.chooseColor(d.color); break;
    case 'undo': store.requestUndo(); break;
    case 'emoji': store.sendEmoji(d.e); break;
    case 'rematch': store.requestRematch(); break;
    case 'ready': store.localReady(); break;
    case 'menu': store.toggleMenu(); break;
    case 'menu-close': store.toggleMenu(false); break;
    case 'quit': store.toggleMenu(false); store.quit(); break;
    case 'end-all': store.toggleMenu(false); store.hostEndAll(); break;
    case 'vibrate': store.setSetting('vibrate', !store.getModel().settings.vibrate); break;
    case 'theme': {
      const order = ['auto', 'light', 'dark'];
      const cur = store.getModel().settings.theme;
      store.setSetting('theme', order[(order.indexOf(cur) + 1) % order.length]);
      break;
    }
    case 'resume-local': store.resumeLocal(); break;
    case 'reopen': store.hostReopen(); break;
    case 'rejoin': { const g = store.getModel().saves.guest; if (g) store.guestJoin({ code: g.code, name: g.name }); break; }
    default: break; // 'copy' and 'share' are handled by app.js (they need browser APIs)
  }
}
