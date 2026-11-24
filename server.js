#!/usr/bin/env node
// Pass Live relay: holds your MyFundedPerps API key, follows your account, and serves an OBS overlay on localhost.
// No dependencies. Node 20+. The key never leaves this process; the overlay only ever sees numbers.
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meters, alertsFor, nyDay, fillOf } from './public/js/derive.js';
import { demoState } from './public/js/demo.js';

const ROOT = dirname(fileURLToPath(import.meta.url)), PUB = join(ROOT, 'public');
// ---------- config (.env is optional; real env vars win) ----------
if (existsSync(join(ROOT, '.env'))) for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
}
const KEY = process.env.FP_API_KEY || '', PORT = +(process.env.PORT || 4747);
const DEMO = process.argv.includes('--demo') || !KEY;
const SANDBOX = KEY.startsWith('fp_test_');
const REST = SANDBOX ? 'https://sandbox.myfundedperpetuals.com/v1' : 'https://developers.myfundedperpetuals.com/v1';
const STREAM = `wss://account-stream.myfundedperpetuals.com/v1/${SANDBOX ? 'sandbox/' : ''}stream`;
const MODE = DEMO ? 'demo' : SANDBOX ? 'sandbox' : 'live';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (KEY && !/^fp_(test|live)_[A-Za-z0-9_-]+$/.test(KEY)) { console.error('FP_API_KEY should start with fp_test_ (sandbox) or fp_live_.'); process.exit(1); }

// ---------- state per account ----------
const A = new Map(); // id -> { acct, m, history: [[t, equity]], fills: [], seen: {}, subs: Set<res> }
const acc = (id) => { if (!A.has(id)) A.set(id, { acct: null, m: null, history: [], fills: [], seen: {}, subs: new Set(), seenFill: new Set() }); return A.get(id); };
let accounts = [], streamState = { connected: false, error: null };

function publicState(id) {
  const s = acc(id), today = nyDay(), tf = s.fills.filter((f) => nyDay(f.time) === today);
  return {
    mode: MODE, stream: streamState, account: s.acct ? { id: s.acct.id, number: s.acct.account_number, name: s.acct.display_name || s.acct.name, status: s.acct.status, stage: s.acct.stage, failedRule: s.acct.failed_rule_id || null } : null,
    m: s.m, history: s.history.slice(-400),
    today: { trades: tf.length, wins: tf.filter((f) => f.pnl > 0).length, losses: tf.filter((f) => f.pnl < 0).length, realized: tf.reduce((a, f) => a + (f.pnl || 0) - (f.fee || 0), 0) },
  };
}
function send(id, event, data) { const s = acc(id), msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of s.subs) res.write(msg); }
let pushTimer = new Map();
function pushState(id) { if (pushTimer.has(id)) return; pushTimer.set(id, setTimeout(() => { pushTimer.delete(id); send(id, 'state', publicState(id)); }, 120)); }

function onAccount(a) {
  if (!a || !a.id) return;
  const s = acc(a.id); s.acct = Object.assign(s.acct || {}, a); s.m = meters(s.acct);
  if (s.m && s.m.equity != null) { const now = Date.now(), last = s.history[s.history.length - 1]; if (!last || now - last[0] > 900 || last[1] !== s.m.equity) s.history.push([now, s.m.equity]); if (s.history.length > 2000) s.history.splice(0, s.history.length - 2000); }
  for (const al of alertsFor(s.m, s.seen, nyDay())) send(a.id, 'alert', al);
  pushState(a.id);
}
function onFill(accountId, raw, { quiet = false } = {}) {
  const f = fillOf(raw); if (!f || !accountId) return; const s = acc(accountId);
  if (f.id && s.seenFill.has(f.id)) return; if (f.id) s.seenFill.add(f.id);
  s.fills.push(f); if (s.fills.length > 500) s.fills.shift();
  if (!quiet) send(accountId, 'fill', f); pushState(accountId);
}

// ---------- MyFundedPerps REST ----------
async function api(path) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(REST + path, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', 'User-Agent': 'pass-live-overlay' } });
    if (res.status === 429 || res.status === 503) { const wait = Math.min(30, +(res.headers.get('retry-after') || 2)); await new Promise((r) => setTimeout(r, wait * 1000)); continue; }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${res.status} ${body?.error?.code || ''} ${body?.error?.message || ''}`.trim());
    return body.data;
  }
  throw new Error('rate limited');
}
async function loadAccounts() {
  accounts = await api('/accounts');
  for (const a of accounts) onAccount(a);
  log(`${accounts.length} account(s):`, accounts.map((a) => `${a.display_name || a.name} [${a.status}]`).join(', '));
}
// poll the fresh risk snapshot for accounts someone is watching
async function pollLoop() {
  for (;;) {
    const ids = [...A.entries()].filter(([, s]) => s.subs.size).map(([id]) => id);
    for (const id of ids) { try { onAccount(await api(`/accounts/${encodeURIComponent(id)}`)); } catch (e) { log('poll', id, e.message); } }
    await new Promise((r) => setTimeout(r, 2500));
  }
}
async function backfillFills(id) {
  try {
    const page = await api(`/fills?account_id=${encodeURIComponent(id)}&limit=100`);
    const list = (Array.isArray(page) ? page : page?.data || []).slice().reverse(); // oldest first
    list.forEach((f) => onFill(id, f, { quiet: true }));
    // rebuild today's equity line from the fills: walk back from the current balance
    const st = acc(id), today = nyDay(), todays = st.fills.filter((f) => nyDay(f.time) === today);
    if (st.acct && todays.length) {
      let bal = +st.acct.balance; const pts = [];
      for (let i = todays.length - 1; i >= 0; i--) { pts.push([todays[i].time, bal]); bal -= (todays[i].pnl || 0) - (todays[i].fee || 0); }
      pts.push([todays[0].time - 60000, bal]);
      st.history = pts.reverse().concat(st.history.filter((p) => p[0] > todays[todays.length - 1].time));
      pushState(id);
    }
  } catch (e) { log('fills backfill skipped:', e.message); }
}

// ---------- MyFundedPerps account stream (resume, liveness, backoff) ----------
let ws = null, resume = null, lastSeq = 0, lastTime = 0, deadTimer = null, backoff = 1000, stopStream = false;
function connectStream() {
  if (stopStream) return;
  const url = resume ? `${STREAM}?resume=${encodeURIComponent(resume)}&last_seq=${lastSeq}&since=${lastTime}` : STREAM;
  ws = new WebSocket(url, { headers: { Authorization: `Bearer ${KEY}` } });
  const alive = () => { clearTimeout(deadTimer); deadTimer = setTimeout(() => { log('stream silent 45 s, reconnecting'); try { ws.close(); } catch {} }, 45000); };
  ws.onopen = () => { alive(); backoff = 1000; streamState = { connected: true, error: null }; for (const id of A.keys()) pushState(id); };
  ws.onmessage = (ev) => {
    alive(); let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.seq) lastSeq = f.seq; if (f.time) lastTime = f.time;
    switch (f.type) {
      case 'hello': if (f.stream_id) resume = f.stream_id; log(`stream ${f.resumed ? 'resumed' : 'connected'} (${MODE})`); break;
      case 'snapshot': if (f.account) onAccount(f.account); break;
      case 'account': if (f.event === 'updated' && f.account) onAccount(f.account); break;
      case 'fill': onFill(f.account_id || f.fill?.account_id, f.fill); break;
      case 'error': case 'notice': log('stream', f.type, f.code || '', f.message || ''); break;
    }
  };
  ws.onclose = (ev) => {
    clearTimeout(deadTimer); streamState = { connected: false, error: null };
    if (ev.code === 4001) { stopStream = true; streamState.error = 'Key revoked, expired or sandbox lapsed. Make a new key.'; log(streamState.error); }
    else { const wait = ev.code === 1012 ? 200 : ev.code === 4008 ? (resume = null, 500) : backoff * (1 + Math.random() * 0.3); backoff = Math.min(30000, backoff * 2); setTimeout(connectStream, wait); }
    for (const id of A.keys()) pushState(id);
  };
  ws.onerror = () => {};
}

// ---------- demo feed ----------
function runDemo() {
  const t0 = Date.now();
  streamState = { connected: true, error: null };
  let lastLoop = -1;
  setInterval(() => {
    const sec = (Date.now() - t0) / 1000, d = demoState(sec), loop = Math.floor(sec / d.loop);
    if (loop !== lastLoop) { lastLoop = loop; const s = acc('demo'); s.history = []; s.seen = {}; s.fills = []; s.seenFill.clear(); }
    onAccount(d.account);
    for (const f of d.fills) onFill('demo', { ...f, time: t0 + (loop * d.loop + f.t) * 1000 });
  }, 400);
}

// ---------- HTTP: control page, overlay, events ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" };
const server = http.createServer((req, res) => {
  // only answer to localhost, so other websites can't read your numbers (DNS rebinding)
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) { res.writeHead(403).end('localhost only'); return; }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/events') {
    const id = url.searchParams.get('account') || defaultAccount(); if (!id) { res.writeHead(503).end('no account yet'); return; }
    if (DEMO ? id !== 'demo' : !accounts.some((a) => a.id === id)) { res.writeHead(404).end('unknown account'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...SEC });
    const s = acc(id); s.subs.add(res); res.write(`event: state\ndata: ${JSON.stringify(publicState(id))}\n\n`);
    if (!DEMO && s.subs.size === 1 && !s.backfilled) { s.backfilled = true; backfillFills(id); }
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); s.subs.delete(res); });
    return;
  }
  if (url.pathname === '/api/accounts') { res.writeHead(200, { 'Content-Type': 'application/json', ...SEC }); res.end(JSON.stringify({ mode: MODE, stream: streamState, accounts: (DEMO ? [acc('demo').acct] : accounts).filter(Boolean).map((a) => ({ id: a.id, number: a.account_number, name: a.display_name || a.name, status: a.status, stage: a.stage })) })); return; }
  let p = url.pathname === '/' ? '/index.html' : url.pathname === '/overlay' ? '/overlay.html' : url.pathname;
  const file = normalize(join(PUB, p));
  if (!file.startsWith(PUB) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
  res.end(readFileSync(file));
});
const defaultAccount = () => (DEMO ? 'demo' : process.env.FP_ACCOUNT_ID || (accounts.find((a) => a.status === 'active') || accounts[0])?.id);

server.listen(PORT, '127.0.0.1', async () => {
  log(`Pass Live on http://localhost:${PORT}  (mode: ${MODE})`);
  log(`OBS browser source: http://localhost:${PORT}/overlay`);
  if (DEMO) { if (!KEY) log('No FP_API_KEY set, running the demo feed. See README to connect your account.'); runDemo(); return; }
  try { await loadAccounts(); } catch (e) { console.error('Could not list accounts:', e.message); streamState.error = e.message; }
  connectStream(); pollLoop();
});
