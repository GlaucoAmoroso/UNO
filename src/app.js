// =============================================================================
// app.js - the only file that touches the DOM and browser APIs.
// It wires: store -> render(model) -> innerHTML, one delegated click listener,
// clipboard/share, wake lock, visibility handling, theme, service worker.
// =============================================================================
import { createStore } from './store.js';
import { render, act } from './ui.js';
import { loadPeerJS } from './transport.js';

const storage = (() => {
  try {
    const k = '__uno_probe__';
    window.localStorage.setItem(k, '1');
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch { return null; } // private mode etc.: the app works, it just cannot save
})();

const random32 = () => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0]; };

const store = createStore({
  storage,
  random32,
  loadPeer: () => loadPeerJS(), // PeerJS is downloaded only when online mode is opened
  vibrate: (ms) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch { /* unsupported */ } },
});

const root = document.getElementById('app');

// ----- painting (coalesced; typed text and scroll position survive a repaint) -----
let paintQueued = false;
function schedulePaint() {
  if (paintQueued) return;
  paintQueued = true;
  Promise.resolve().then(() => { paintQueued = false; paint(); });
}
function paint() {
  const m = store.getModel();
  const typed = {};
  root.querySelectorAll('[data-field]').forEach((el) => { typed[el.dataset.field] = el.value; });
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.field : null;
  const hand = root.querySelector('.hand');
  const scroll = hand ? hand.scrollLeft : 0;

  root.innerHTML = render(m);

  root.querySelectorAll('[data-field]').forEach((el) => {
    const v = typed[el.dataset.field];
    if (v !== undefined && v !== '') el.value = v;
  });
  if (focused) { const el = root.querySelector(`[data-field="${focused}"]`); if (el) el.focus(); }
  const newHand = root.querySelector('.hand');
  if (newHand) newHand.scrollLeft = scroll;

  document.documentElement.dataset.theme = m.settings.theme === 'auto' ? '' : m.settings.theme;
  syncWakeLock(m);
}
store.subscribe(schedulePaint);

// ----- clicks -----
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else throw new Error('no clipboard');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
  }
  store.toast('Code copied.');
}
async function shareText(code) {
  const text = `Join my Color Rush game! Room code: ${code}`;
  if (navigator.share) {
    try { await navigator.share({ title: 'Color Rush', text, url: location.href.split('#')[0] }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  await copyText(text); // fallback: copy
}

root.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const name = el.dataset.act;
  if (name === 'copy') { copyText(el.dataset.text); return; }
  if (name === 'share') { shareText(el.dataset.text); return; }
  const data = { ...el.dataset };
  if (el.dataset.fields) {
    for (const f of el.dataset.fields.split(',')) {
      const input = root.querySelector(`[data-field="${f}"]`);
      data[f] = input ? input.value : '';
    }
  }
  act(store, name, data);
});
root.addEventListener('keydown', (e) => { // Enter in a text field presses the screen's main button
  if (e.key !== 'Enter' || !e.target.matches('[data-field]')) return;
  const main = root.querySelector('button[data-fields]');
  if (main) main.click();
});

// ----- visibility, connectivity, wake lock -----
document.addEventListener('visibilitychange', () => { if (!document.hidden) { store.nudge(); syncWakeLock(store.getModel()); } });
window.addEventListener('online', () => store.nudge());

let wake = null;
let wakeBusy = false;
async function syncWakeLock(m) {
  if (wakeBusy || !('wakeLock' in navigator)) return;
  const want = (m.mode === 'host' || m.mode === 'guest') && ['lobby', 'game', 'joining'].includes(m.screen);
  wakeBusy = true;
  try {
    if (want && !wake && !document.hidden) {
      wake = await navigator.wakeLock.request('screen');
      wake.addEventListener('release', () => { wake = null; });
    } else if (!want && wake) {
      const w = wake; wake = null; await w.release();
    }
  } catch { wake = null; /* denied or unsupported: not essential */ } finally { wakeBusy = false; }
}

// ----- service worker (offline play for the local mode) -----
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => {}); });
}

paint();
// Handy for debugging and for the browser test; read-only information.
window.__colorRush = { store };
