#!/usr/bin/env node
// Pass Live: OBS overlay + TradingView bridge for MyFundedPerps, running on your own computer.
// No dependencies. Node 20+. Your API key never leaves this process; the overlay only ever sees numbers.
import http from 'node:http';
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { exec } from 'node:child_process';
import { meters, alertsFor, nyDay, fillOf } from './public/js/derive.js';
import { demoState } from './public/js/demo.js';
import { bridgeConfig, parseAlert, execute, sameSecret, alertKey } from './lib/bridge.js';

if (+process.versions.node.split('.')[0] < 22) { console.error(`Pass Live needs Node.js 22 or newer (you have ${process.versions.node}). Get the LTS from https://nodejs.org`); process.exit(1); }
const ROOT = dirname(fileURLToPath(import.meta.url)), PUB = join(ROOT, 'public');
const ENV_FILE = process.env.PASS_LIVE_ENV || join(ROOT, '.env');
const log = (...a) => console.log(new Date().toTimeString().slice(0, 8), ...a);

// ---------- config: .env is optional, the Setup page writes it for you ----------
function readEnv() {
  const out = {};
  if (existsSync(ENV_FILE)) for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (m) out[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
  return out;
}
function writeEnv(changes) {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : ['# Pass Live settings. Keep this file private.'];
  for (const [k, v] of Object.entries(changes)) {
    const safe = String(v ?? '').replace(/[\r\n]/g, '');
    const i = lines.findIndex((l) => new RegExp(`^\\s*#?\\s*${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = `${k}=${safe}`; else lines.push(`${k}=${safe}`);
  }
  writeFileSync(ENV_FILE, lines.join('\n').replace(/\n*$/, '\n'));
  try { chmodSync(ENV_FILE, 0o600); } catch {}
  Object.assign(ENV, changes);
}
const ENV = { ...readEnv(), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(FP_|WEBHOOK_|TRADING_|MAX_|BLOCK_|ALLOWED_|PORT$|NO_OPEN$)/.test(k))) };
const PORT = +(ENV.PORT || 4747), HOOK_PORT = +(ENV.WEBHOOK_PORT || PORT + 1);
const FORCE_DEMO = process.argv.includes('--demo');
let KEY = '', MODE = 'demo', REST = '', STREAM = '';
function configure() {
  KEY = FORCE_DEMO ? '' : (ENV.FP_API_KEY || '').trim();
  const sandbox = KEY.startsWith('fp_test_');
  MODE = !KEY ? 'demo' : sandbox ? 'sandbox' : 'live';
  // FP_API_BASE / FP_STREAM_URL exist only for the test suite's fake API
  REST = ENV.FP_API_BASE || (sandbox ? 'https://sandbox.myfundedperpetuals.com/v1' : 'https://developers.myfundedperpetuals.com/v1');
  STREAM = ENV.FP_STREAM_URL || `wss://account-stream.myfundedperpetuals.com/v1/${sandbox ? 'sandbox/' : ''}stream`;
}
const validKey = (k) => /^fp_(test|live)_[A-Za-z0-9_-]{8,}$/.test(k);
if (!ENV.WEBHOOK_SECRET) writeEnv({ WEBHOOK_SECRET: randomBytes(18).toString('base64url') });
configure();

// ---------- account state ----------
const A = new Map(); // id -> { acct, m, history, fills, seen, subs, seenFill }
const acc = (id) => { if (!A.has(id)) A.set(id, { acct: null, m: null, history: [], fills: [], seen: {}, subs: new Set(), seenFill: new Set() }); return A.get(id); };
let accounts = [], streamState = { connected: false, error: null }, markets = [];
const defaultAccount = () => (MODE === 'demo' ? 'demo' : ENV.FP_ACCOUNT_ID && accounts.some((a) => a.id === ENV.FP_ACCOUNT_ID) ? ENV.FP_ACCOUNT_ID : (accounts.find((a) => a.status === 'active') || accounts[0])?.id);

function publicState(id) {
  const s = acc(id), today = nyDay(), tf = s.fills.filter((f) => nyDay(f.time) === today);
  return {
    mode: MODE, stream: streamState,
    account: s.acct ? { id: s.acct.id, number: s.acct.account_number, name: s.acct.display_name || s.acct.name, status: s.acct.status, stage: s.acct.stage, failedRule: s.acct.failed_rule_id || null } : null,
    m: s.m, history: s.history.slice(-400),
    today: { trades: tf.length, wins: tf.filter((f) => f.pnl > 0).length, losses: tf.filter((f) => f.pnl < 0).length, realized: tf.reduce((a, f) => a + (f.pnl || 0) - (f.fee || 0), 0) },
  };
}
function send(id, event, data) { const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`; for (const res of acc(id).subs) res.write(msg); }
const pushTimer = new Map();
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
async function call(method, path, body, headers = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(REST + path, { method, headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json', 'User-Agent': 'pass-live', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch (e) { const err = new Error(`network: ${e.message}`); err.retry = true; throw err; }
    if ((res.status === 429 || res.status === 503) && method === 'GET') { await new Promise((r) => setTimeout(r, Math.min(30, +(res.headers.get('retry-after') || 2)) * 1000)); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) { const err = new Error(`${json?.error?.code || res.status}: ${json?.error?.message || 'request failed'}`); err.retry = res.status === 429 || res.status >= 500; err.status = res.status; throw err; }
    return { status: res.status, data: json.data, retryAfter: res.headers.get('retry-after') };
  }
  throw new Error('rate limited');
}
const api = async (path) => (await call('GET', path)).data;
async function loadAccounts() {
  accounts = await api('/accounts');
  for (const a of accounts) onAccount(a);
  log(`${accounts.length} account(s):`, accounts.map((a) => `${a.display_name || a.name} [${a.status}]`).join(', '));
}
async function loadMarkets() {
  try { const r = await fetch(REST + '/markets', { headers: { Accept: 'application/json' } }); markets = (await r.json()).data || []; } catch (e) { log('markets:', e.message); }
}
let pollRunning = false;
async function pollLoop() {
  if (pollRunning) return; pollRunning = true;
  for (;;) {
    if (MODE !== 'demo') {
      const ids = new Set([...A.entries()].filter(([, s]) => s.subs.size).map(([id]) => id)); const tv = bridge().accountId || defaultAccount(); if (tv) ids.add(tv);
      for (const id of ids) { if (!accounts.some((a) => a.id === id)) continue; try { onAccount(await api(`/accounts/${encodeURIComponent(id)}`)); } catch (e) { log('poll', e.message); } }
    }
    await new Promise((r) => setTimeout(r, 2500));
  }
}
async function backfillFills(id) {
  try {
    const page = await api(`/fills?account_id=${encodeURIComponent(id)}&limit=100`);
    const list = (Array.isArray(page) ? page : page?.data || []).slice().reverse();
    list.forEach((f) => onFill(id, f, { quiet: true }));
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

// ---------- account stream: resume, liveness, backoff ----------
let resume = null, lastSeq = 0, lastTime = 0, deadTimer = null, backoff = 1000, streamGen = 0, sock = null;
function connectStream() {
  const gen = ++streamGen; try { sock && sock.close(); } catch {}
  if (MODE === 'demo') return;
  const url = resume ? `${STREAM}?resume=${encodeURIComponent(resume)}&last_seq=${lastSeq}&since=${lastTime}` : STREAM;
  const ws = sock = new WebSocket(url, { headers: { Authorization: `Bearer ${KEY}` } });
  const alive = () => { clearTimeout(deadTimer); deadTimer = setTimeout(() => { log('stream silent 45 s, reconnecting'); try { ws.close(); } catch {} }, 45000); };
  ws.onopen = () => { if (gen !== streamGen) return ws.close(); alive(); backoff = 1000; streamState = { connected: true, error: null }; for (const id of A.keys()) pushState(id); };
  ws.onmessage = (ev) => {
    if (gen !== streamGen) return; alive(); let f; try { f = JSON.parse(ev.data); } catch { return; }
    if (f.seq) lastSeq = f.seq; if (f.time) lastTime = f.time;
    if (f.type === 'hello') { if (f.stream_id) resume = f.stream_id; log(`stream ${f.resumed ? 'resumed' : 'connected'} (${MODE})`); }
    else if (f.type === 'snapshot' && f.account) onAccount(f.account);
    else if (f.type === 'account' && f.event === 'updated' && f.account) onAccount(f.account);
    else if (f.type === 'fill') onFill(f.account_id || f.fill?.account_id, f.fill);
    else if (f.type === 'error' || f.type === 'notice') log('stream', f.type, f.code || '', f.message || '');
  };
  ws.onclose = (ev) => {
    clearTimeout(deadTimer); if (gen !== streamGen) return; streamState = { connected: false, error: null };
    if (ev.code === 4001) { streamState.error = 'Key revoked, expired or sandbox lapsed. Add a new key on the Setup page.'; log(streamState.error); }
    else { const w = ev.code === 1012 ? 200 : ev.code === 4008 ? (resume = null, 500) : backoff * (1 + Math.random() * 0.3); backoff = Math.min(30000, backoff * 2); setTimeout(() => gen === streamGen && connectStream(), w); }
    for (const id of A.keys()) pushState(id);
  };
  ws.onerror = () => {};
}

// ---------- demo feed ----------
let demoTimer = null;
function runDemo() {
  clearInterval(demoTimer); const t0 = Date.now(); streamState = { connected: true, error: null }; let lastLoop = -1;
  demoTimer = setInterval(() => {
    const sec = (Date.now() - t0) / 1000, d = demoState(sec), loop = Math.floor(sec / d.loop);
    if (loop !== lastLoop) { lastLoop = loop; const s = acc('demo'); s.history = []; s.seen = {}; s.fills = []; s.seenFill.clear(); }
    onAccount(d.account);
    for (const f of d.fills) onFill('demo', { ...f, time: t0 + (loop * d.loop + f.t) * 1000 });
  }, 400);
}

async function start() {
  if (MODE === 'demo') { log('No API key yet: running the demo. Open the Setup page to connect your account.'); runDemo(); return; }
  clearInterval(demoTimer);
  try { await loadAccounts(); streamState.error = null; } catch (e) { log('Could not list accounts:', e.message); streamState = { connected: false, error: e.message }; return; }
  loadMarkets(); connectStream(); pollLoop();
}

// ---------- TradingView bridge ----------
const bridge = () => bridgeConfig(ENV);
const ALERTS = [], seenAlerts = new Map(), alertTimes = [];
function recordAlert(entry) {
  ALERTS.unshift({ time: Date.now(), ...entry }); ALERTS.length = Math.min(ALERTS.length, 50);
  const id = bridge().accountId || defaultAccount(); if (id) send(id, 'tv', { status: entry.status, text: entry.text });
  log(`TradingView ${entry.status}: ${entry.text}`);
}
async function handleAlert(raw, ip, { dry = false } = {}) {
  const cfg = { ...bridge(), ...(dry ? { enabled: false } : {}) };
  let intent; try { intent = parseAlert(raw); } catch (e) { recordAlert({ status: 'error', text: e.message, ip }); return { ok: false, status: 'error', text: e.message }; }
  if (!sameSecret(intent.passphrase, cfg.secret)) { log(`TradingView alert with a wrong passphrase from ${ip}`); return { ok: false, status: 'error', text: 'bad passphrase' }; }
  const key = alertKey(intent), now = Date.now();
  for (const [k, t] of seenAlerts) if (now - t > 120000) seenAlerts.delete(k);
  if (seenAlerts.has(key)) { log('duplicate TradingView alert ignored'); return { ok: true, status: 'duplicate', text: 'Same alert already handled' }; }
  seenAlerts.set(key, now);
  while (alertTimes.length && now - alertTimes[0] > 60000) alertTimes.shift();
  const recent = alertTimes.length; alertTimes.push(now);
  if (MODE === 'demo') { const out = { status: 'dry', text: `Demo: got ${intent.action} ${intent.symbol || ''}. Add your API key on the Setup page to trade.` }; recordAlert(out); return { ok: true, ...out }; }
  const accountId = cfg.accountId || defaultAccount(), s = acc(accountId);
  if (!markets.length) await loadMarkets();
  const out = await execute(intent, { api: call, cfg, markets, accountId, meters: s.m, status: s.acct?.status, recent, log });
  recordAlert({ ...out, ip }); return { ok: out.status !== 'error', ...out };
}
// TradingView reaches this port through your tunnel. It only accepts POST /tv with the right passphrase.
const hook = http.createServer((req, res) => {
  const ip = req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
  if (req.method !== 'POST' || new URL(req.url, 'http://x').pathname !== '/tv') { res.writeHead(404).end(); return; }
  let size = 0; const chunks = [];
  req.on('data', (c) => { size += c.length; if (size > 8192) { res.writeHead(413).end(); req.destroy(); } else chunks.push(c); });
  req.on('end', () => {
    if (res.writableEnded) return;
    const raw = Buffer.concat(chunks).toString('utf8');
    let pre = null; try { pre = parseAlert(raw); } catch {}
    if (pre && !sameSecret(pre.passphrase, bridge().secret)) { res.writeHead(401).end('bad passphrase'); log(`rejected alert (wrong passphrase) from ${ip}`); return; }
    // answer TradingView straight away (it gives up after a few seconds), then do the work
    res.writeHead(202, { 'Content-Type': 'application/json' }).end('{"ok":true}');
    handleAlert(raw, ip).catch((e) => recordAlert({ status: 'error', text: e.message }));
  });
});

// ---------- HTTP: setup page, overlay, events, local API ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const SEC = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'" };
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SEC }); res.end(JSON.stringify(obj)); };
const masked = () => (KEY ? `${KEY.slice(0, 8)}••••${KEY.slice(-4)}` : '');
function statusPayload() {
  const cfg = bridge();
  return {
    mode: MODE, stream: streamState, key: masked(), port: PORT, hookPort: HOOK_PORT,
    accounts: (MODE === 'demo' ? [acc('demo').acct] : accounts).filter(Boolean).map((a) => ({ id: a.id, number: a.account_number, name: a.display_name || a.name, status: a.status, stage: a.stage })),
    defaultAccount: defaultAccount(),
    bridge: { enabled: cfg.enabled, secret: cfg.secret, accountId: cfg.accountId, maxOrderUsd: cfg.maxOrderUsd, maxLeverage: cfg.maxLeverage, blockAt: cfg.blockAt, allowed: cfg.allowed.join(','), perMinute: cfg.perMinute },
    alerts: ALERTS.slice(0, 20),
  };
}
function readBody(req) {
  return new Promise((ok, fail) => { let s = ''; req.on('data', (c) => { s += c; if (s.length > 16384) { fail(new Error('too large')); req.destroy(); } }); req.on('end', () => { try { ok(JSON.parse(s || '{}')); } catch { fail(new Error('bad json')); } }); });
}
const server = http.createServer(async (req, res) => {
  // only answer to localhost, so other websites can't read or change anything (DNS rebinding, CSRF)
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) { res.writeHead(403).end('localhost only'); return; }
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST') {
    const origin = req.headers.origin || '';
    if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/.test(origin) || !(req.headers['content-type'] || '').startsWith('application/json')) { res.writeHead(403).end('forbidden'); return; }
    let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { error: e.message }); }
    if (url.pathname === '/api/key') {
      const k = String(b.key || '').trim();
      if (!validKey(k)) return json(res, 400, { error: 'That doesn\'t look like a MyFundedPerps key. It starts with fp_test_ (sandbox) or fp_live_.' });
      const before = ENV.FP_API_KEY; ENV.FP_API_KEY = k; configure();
      try { await call('GET', '/accounts'); } catch (e) { ENV.FP_API_KEY = before; configure(); return json(res, 400, { error: `MyFundedPerps said: ${e.message}` }); }
      writeEnv({ FP_API_KEY: k }); resume = null; A.clear(); accounts = []; await start();
      return json(res, 200, statusPayload());
    }
    if (url.pathname === '/api/bridge') {
      const ch = {};
      if ('enabled' in b) ch.TRADING_ENABLED = b.enabled ? 'true' : 'false';
      if ('accountId' in b) ch.WEBHOOK_ACCOUNT_ID = String(b.accountId || '').replace(/[^\w-]/g, '');
      if ('maxOrderUsd' in b && +b.maxOrderUsd > 0) ch.MAX_ORDER_USD = String(+b.maxOrderUsd);
      if ('maxLeverage' in b && +b.maxLeverage >= 1) ch.MAX_LEVERAGE = String(+b.maxLeverage);
      if ('blockAt' in b && +b.blockAt > 0 && +b.blockAt <= 1) ch.BLOCK_AT_LIMIT_USED = String(+b.blockAt);
      if ('allowed' in b) ch.ALLOWED_SYMBOLS = String(b.allowed || '').replace(/[^A-Za-z0-9,:|]/g, '');
      if (b.newSecret) ch.WEBHOOK_SECRET = randomBytes(18).toString('base64url');
      writeEnv(ch); return json(res, 200, statusPayload());
    }
    if (url.pathname === '/api/test-alert') { const r = await handleAlert({ ...b, id: `setup-${Date.now()}`, passphrase: bridge().secret }, 'setup page', { dry: true }); return json(res, 200, { result: r, status: statusPayload() }); }
    return json(res, 404, { error: 'not found' });
  }
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (url.pathname === '/events') {
    const id = url.searchParams.get('account') || defaultAccount(); if (!id) { res.writeHead(503).end('no account yet'); return; }
    if (MODE === 'demo' ? id !== 'demo' : !accounts.some((a) => a.id === id)) { res.writeHead(404).end('unknown account'); return; }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...SEC });
    const s = acc(id); s.subs.add(res); res.write(`event: state\ndata: ${JSON.stringify(publicState(id))}\n\n`);
    if (MODE !== 'demo' && !s.backfilled) { s.backfilled = true; backfillFills(id); }
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); s.subs.delete(res); });
    return;
  }
  if (url.pathname === '/api/status' || url.pathname === '/api/accounts') return json(res, 200, statusPayload());
  const p = url.pathname === '/' ? '/index.html' : url.pathname === '/overlay' ? '/overlay.html' : url.pathname;
  const file = normalize(join(PUB, p));
  if (!file.startsWith(PUB) || !existsSync(file)) { res.writeHead(404).end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache', ...SEC });
  res.end(readFileSync(file));
});

function openBrowser(url) {
  if (ENV.NO_OPEN || process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}
server.on('error', (e) => { if (e.code === 'EADDRINUSE') { console.error(`Port ${PORT} is busy. Is Pass Live already running? Close it or set PORT in .env.`); process.exit(1); } throw e; });
hook.on('error', (e) => log(`TradingView port ${HOOK_PORT}: ${e.message}`));
server.listen(PORT, '127.0.0.1', async () => {
  console.log(`\n  Pass Live is running.\n  Setup and preview:  http://localhost:${PORT}\n  OBS browser source: http://localhost:${PORT}/overlay\n  TradingView port:   ${HOOK_PORT} (point your tunnel here)\n  Stop it with Ctrl+C.\n`);
  hook.listen(HOOK_PORT, '127.0.0.1');
  openBrowser(`http://localhost:${PORT}`);
  await start();
});
