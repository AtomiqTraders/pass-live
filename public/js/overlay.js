// Pass Live overlay: listens to the local relay (or runs the demo) and draws the panel.
import { meters, alertsFor, nyDay, fillOf } from './derive.js';
import { demoState } from './demo.js';

const $ = (id) => document.getElementById(id);
const q = new URLSearchParams(location.search);
const root = document.documentElement;
// options: ?layout=card|bar  ?corner=left|right  ?pos=bottom|top  ?theme=dark|light  ?scale=1  ?account=ID  ?demo
if (q.get('layout') === 'bar') root.classList.add('bar');
if (q.get('corner') === 'right') root.classList.add('right');
if (q.get('pos') === 'top') root.classList.add('top');
if (q.get('theme') === 'light') root.classList.add('light');
root.style.setProperty('--scale', String(Math.min(2.5, Math.max(0.5, +(q.get('scale') || 1)))));

const money = (v, sign = false) => (v == null ? '–' : (sign && v > 0 ? '+' : v < 0 ? '−' : '') + '$' + Math.abs(Math.round(v)).toLocaleString('en-US'));
const pctTxt = (v) => (v == null ? '–' : Math.round(v * 100) + '%');
const css = (n) => getComputedStyle(root).getPropertyValue(n).trim();

// ---------- numbers glide to their new value ----------
const shown = { equity: null };
function tweenEquity(to) {
  if (to == null) return; const from = shown.equity ?? to, t0 = performance.now(), d = 700;
  shown.target = to;
  const step = (now) => { const u = Math.min(1, (now - t0) / d), e = 1 - Math.pow(1 - u, 3), v = from + (to - from) * e; shown.equity = v; $('equity').textContent = money(v); if (u < 1 && shown.target === to) requestAnimationFrame(step); };
  requestAnimationFrame(step);
}

// ---------- render one state ----------
let last = null;
function render(s) {
  last = s; const m = s.m; $('panel').hidden = false;
  $('acct').textContent = s.account ? s.account.name : '';
  const live = $('live'); live.className = 'live ' + (s.mode || '') + (s.stream && !s.stream.connected ? ' off' : '');
  live.querySelector('b').textContent = s.stream && s.stream.error ? 'KEY ERROR' : !s.stream?.connected ? 'RECONNECTING' : s.mode === 'live' ? 'LIVE' : s.mode === 'sandbox' ? 'SANDBOX' : 'DEMO';
  if (!m) return;
  tweenEquity(m.equity);
  const pnl = $('pnl'); pnl.textContent = m.pnl == null ? '' : `${money(m.pnl, true)} (${m.start ? ((m.pnl / m.start) * 100).toFixed(2) : '0'}%)`; pnl.className = 'pnl ' + (m.pnl > 0 ? 'up' : m.pnl < 0 ? 'down' : '');
  setMeter('target', m.targetProgress, m.targetProgress == null ? '–' : `${pctTxt(m.targetProgress)} · ${money(m.toGo)} to go`);
  setMeter('daily', m.dailyUsed, m.dailyUsed == null ? 'no daily limit' : `${pctTxt(m.dailyUsed)} used · ${money(m.dailyRoom)} left`, true);
  setMeter('dd', m.ddUsed, m.ddUsed == null ? '–' : `${pctTxt(m.ddUsed)} used · ${money(m.ddRoom)} left`, true);
  const worst = Math.max(m.dailyUsed || 0, m.ddUsed || 0), p = $('panel');
  p.classList.toggle('warn75', worst >= 0.75 && worst < 0.9); p.classList.toggle('warn90', worst >= 0.9);
  const t = s.today || {};
  $('today').innerHTML = `<span>Today <b>${t.trades || 0}</b> trades</span><span><b>${t.wins || 0}</b>W <b>${t.losses || 0}</b>L</span><span class="${t.realized > 0 ? 'up' : t.realized < 0 ? 'down' : ''}">${money(t.realized || 0, true)} realized</span><span>${m.status === 'active' ? '' : esc(m.status.toUpperCase() + (s.account?.failedRule ? ': ' + s.account.failedRule.replace(/-/g, ' ') : ''))}</span>`;
  drawSpark(s.history || [], m);
  root.style.setProperty('--panel-h', $('panel').offsetHeight + 'px');
}
function setMeter(k, v, text, risk) {
  const el = $('m-' + k); el.style.width = `${Math.round((v || 0) * 1000) / 10}%`;
  if (risk) { el.classList.toggle('w50', v >= 0.5 && v < 0.75); el.classList.toggle('w75', v >= 0.75 && v < 0.9); el.classList.toggle('w90', v >= 0.9); }
  $('v-' + k).textContent = text;
}

// ---------- equity line against the target and the limits ----------
function drawSpark(hist, m) {
  const cv = $('spark'), c = cv.getContext('2d'), W = cv.width, H = cv.height; c.clearRect(0, 0, W, H);
  const pts = hist.slice(-240); if (pts.length < 2 && m.equity != null) pts.push([Date.now() - 1000, m.equity], [Date.now(), m.equity]);
  if (pts.length < 2) return;
  const eqs = pts.map((p) => p[1]); let lo = Math.min(...eqs), hi = Math.max(...eqs);
  const lines = [];
  if (m.dailyFloor != null) lines.push([m.dailyFloor, css('--amber'), 'DAILY LIMIT']);
  if (m.target != null) lines.push([m.target, css('--lime'), 'TARGET']);
  if (m.ddFloor != null && m.ddFloor > lo - (hi - lo) * 2) lines.push([m.ddFloor, css('--red'), 'MAX DD']);
  for (const [v] of lines) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const t0 = pts[0][0], t1 = pts[pts.length - 1][0] || t0 + 1, L = 8, R = W - 8;
  const X = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (R - L), Y = (v) => H - 10 - ((v - lo) / (hi - lo)) * (H - 20);
  c.font = '600 20px "Instrument Sans", sans-serif'; c.textBaseline = 'bottom';
  for (const [v, col, label] of lines) { c.strokeStyle = col; c.globalAlpha = 0.75; c.setLineDash([8, 8]); c.lineWidth = 2; c.beginPath(); c.moveTo(L, Y(v)); c.lineTo(R, Y(v)); c.stroke(); c.setLineDash([]); c.globalAlpha = 0.9; c.fillStyle = col; c.textAlign = 'left'; c.fillText(label, L, Y(v) - 4); }
  c.globalAlpha = 1;
  const up = m.equity >= (m.start || m.equity), col = up ? css('--lime') : css('--red');
  const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, col + '55'); g.addColorStop(1, col + '00');
  c.beginPath(); pts.forEach(([t, v], i) => (i ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v)))); c.lineTo(X(t1), H); c.lineTo(X(t0), H); c.closePath(); c.fillStyle = g; c.fill();
  c.beginPath(); pts.forEach(([t, v], i) => (i ? c.lineTo(X(t), Y(v)) : c.moveTo(X(t), Y(v)))); c.strokeStyle = col; c.lineWidth = 4; c.lineJoin = 'round'; c.stroke();
  const [tx, tv] = pts[pts.length - 1]; c.fillStyle = col; c.beginPath(); c.arc(X(tx), Y(tv), 7, 0, 7); c.fill();
}

// ---------- fills and warnings ----------
function toast(f) {
  if (!f) return; const el = document.createElement('div'); el.className = 'toast';
  const side = (f.side || '').toLowerCase(), pnl = f.pnl;
  el.innerHTML = `<span class="side ${side === 'buy' ? 'buy' : 'sell'}">${side === 'buy' ? 'BUY' : 'SELL'}</span><span>${esc(f.size ?? '')} ${esc(f.symbol || '')} @ ${esc(f.price != null ? f.price.toLocaleString('en-US') : '')}</span>${pnl ? `<span class="p ${pnl > 0 ? 'up' : 'down'}">${money(pnl, true)}</span>` : ''}`;
  $('toasts').prepend(el); while ($('toasts').children.length > 3) $('toasts').lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 4500);
}
// TradingView alerts: what was sent, blocked or (in dry run) would have been sent
function tvToast(t) {
  if (!t || !t.text) return; const el = document.createElement('div'); el.className = `toast tv ${t.status}`;
  const label = { sent: 'TV ✓', dry: 'TV · DRY', blocked: 'TV · PAUSED', error: 'TV · ERROR' }[t.status] || 'TV';
  el.innerHTML = `<span class="side tv">${esc(label)}</span><span>${esc(t.text.replace(/^(Sent|Dry run): /, ''))}</span>`;
  $('toasts').prepend(el); while ($('toasts').children.length > 3) $('toasts').lastChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, t.status === 'blocked' ? 7000 : 5000);
}
let alertTimer = 0;
function showAlert(a) {
  const el = $('alert'); el.textContent = a.text; el.className = `alert l${a.level}`; el.hidden = false;
  clearTimeout(alertTimer); alertTimer = setTimeout(() => { el.hidden = true; root.style.setProperty('--panel-h', $('panel').offsetHeight + 'px'); }, a.level >= 90 ? 12000 : 7000);
  root.style.setProperty('--panel-h', $('panel').offsetHeight + 'px');
  if (a.kind === 'status' && /passed/i.test(a.text)) burst();
}
function burst() {
  const b = $('burst'); b.innerHTML = ''; b.hidden = false; const cols = [css('--lime'), '#ffffff', css('--green')];
  for (let i = 0; i < 70; i++) { const p = document.createElement('i'); p.style.left = 32 + Math.random() * 520 + 'px'; p.style.bottom = 120 + Math.random() * 120 + 'px'; p.style.background = cols[i % 3]; p.style.setProperty('--dx', (Math.random() - 0.5) * 500 + 'px'); p.style.setProperty('--dy', -(150 + Math.random() * 450) + 'px'); p.style.setProperty('--r', (Math.random() * 720 - 360) + 'deg'); p.style.animationDelay = Math.random() * 0.2 + 's'; b.append(p); }
  setTimeout(() => { b.hidden = true; }, 2800);
}
const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// ---------- data: the local relay, or the built-in demo ----------
if (q.has('demo')) {
  // runs entirely in the page, so the hosted demo works with no install
  // ?from=<sec> starts partway through the demo day, ?speed=<x> plays it faster, ?t0=<epoch ms> pins the clock
  const t0 = +q.get('t0') || Date.now(), from = +q.get('from') || 0, speed = Math.min(10, Math.max(0.1, +q.get('speed') || 1));
  const seen = {}, seenFills = new Set(); let hist = [], lastLoop = -1, first = true;
  setInterval(() => {
    const sec = from + Math.max(0, (Date.now() - t0) / 1000) * speed, d = demoState(sec), loop = Math.floor(sec / d.loop);
    if (loop !== lastLoop) { lastLoop = loop; hist = []; seenFills.clear(); for (const k in seen) delete seen[k]; }
    const m = meters(d.account); hist.push([Date.now(), m.equity]);
    const fills = d.fills.map((f) => fillOf({ ...f, time: Date.now() }));
    // trades from before the page opened count, but don't pop up
    for (const f of fills) if (!seenFills.has(f.id)) { seenFills.add(f.id); if (!first) toast(f); }
    first = false;
    for (const a of alertsFor(m, seen, nyDay())) showAlert(a);
    render({ mode: 'demo', stream: { connected: true }, account: { name: d.account.display_name }, m, history: hist, today: { trades: fills.length, wins: fills.filter((f) => f.pnl > 0).length, losses: fills.filter((f) => f.pnl < 0).length, realized: fills.reduce((a, f) => a + f.pnl - f.fee, 0) } });
  }, 100);
} else {
  const src = new EventSource('/events' + (q.get('account') ? '?account=' + encodeURIComponent(q.get('account')) : ''));
  src.addEventListener('state', (e) => render(JSON.parse(e.data)));
  src.addEventListener('fill', (e) => toast(JSON.parse(e.data)));
  src.addEventListener('alert', (e) => showAlert(JSON.parse(e.data)));
  src.addEventListener('tv', (e) => tvToast(JSON.parse(e.data)));
  src.onerror = () => { if (last) render({ ...last, stream: { connected: false } }); };
}
