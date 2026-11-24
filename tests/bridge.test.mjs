import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAlert, findMarket, floorStep, guard, buildOrder, bridgeConfig, sameSecret } from '../lib/bridge.js';

const MARKETS = [
  { market_id: 'binance|BTCUSDT', symbol: 'BTC', coin: 'BTCUSDT', provider: 'binance', size_decimals: 3, size_step: 0.001, min_size: 0.001, min_notional: 10, max_leverage: 10, default_venue: true },
  { market_id: 'binance|ETHUSDT', symbol: 'ETH', coin: 'ETHUSDT', provider: 'binance', size_decimals: 3, size_step: 0.001, min_size: 0.001, min_notional: 10, max_leverage: 5, default_venue: true },
  { market_id: 'hyperliquid|xyz:AAPL', symbol: 'AAPL', coin: 'xyz:AAPL', provider: 'hyperliquid', size_decimals: 3, size_step: 0.001, min_size: 0.001, min_notional: 10, max_leverage: 3, default_venue: true },
];
const cfg = bridgeConfig({ TRADING_ENABLED: 'true', WEBHOOK_SECRET: 'x', MAX_ORDER_USD: '5000', MAX_LEVERAGE: '2' });

// ---------- pure helpers ----------
test('alerts parse from JSON text and accept TradingView words', () => {
  const a = parseAlert('{"action":"{{strategy.order.action}}"}'.replace('{{strategy.order.action}}', 'BUY') .replace('}', ',"symbol":"BTCUSDT","size":"0.01"}'));
  assert.equal(a.action, 'buy'); assert.equal(a.size, 0.01);
  assert.equal(parseAlert({ action: 'short', symbol: 'ETHUSDT', usd: 500 }).action, 'sell');
  assert.equal(parseAlert({ action: 'exit', symbol: 'BTC' }).action, 'close');
  assert.throws(() => parseAlert('not json'), /must be JSON/);
  assert.throws(() => parseAlert({ action: 'buy', symbol: 'BTC' }), /size/);
  assert.throws(() => parseAlert({ action: 'moon', symbol: 'BTC', size: 1 }), /Unknown action/);
});

test('TradingView tickers map to MyFundedPerps markets', () => {
  assert.equal(findMarket('BINANCE:BTCUSDT.P', MARKETS).market_id, 'binance|BTCUSDT');
  assert.equal(findMarket('BTCUSDT', MARKETS).market_id, 'binance|BTCUSDT');
  assert.equal(findMarket('eth', MARKETS).market_id, 'binance|ETHUSDT');
  assert.equal(findMarket('NASDAQ:AAPL', MARKETS).market_id, 'hyperliquid|xyz:AAPL');
  assert.equal(findMarket('binance|ETHUSDT', MARKETS).symbol, 'ETH');
  assert.equal(findMarket('DOGEUSDT', MARKETS), null);
});

test('sizes round down to the step', () => { assert.equal(floorStep(0.01299, 0.001, 3), 0.012); assert.equal(floorStep(1.9999, 1, 0), 1); });

test('guard pauses new trades near a limit but never blocks a close', () => {
  const m = MARKETS[0], base = { market: m, status: 'active', cfg, recent: 0 };
  assert.equal(guard({ action: 'buy' }, { ...base, meters: { dailyUsed: 0.5, ddUsed: 0.1 } }), null);
  assert.match(guard({ action: 'buy' }, { ...base, meters: { dailyUsed: 0.85, ddUsed: 0.1 } }), /Daily loss limit 85% used/);
  assert.match(guard({ action: 'sell' }, { ...base, meters: { dailyUsed: 0, ddUsed: 0.9 } }), /Max drawdown/);
  assert.equal(guard({ action: 'close' }, { ...base, meters: { dailyUsed: 1, ddUsed: 1 } }), null);
  assert.match(guard({ action: 'buy' }, { ...base, status: 'failed' }), /failed/);
  assert.match(guard({ action: 'buy' }, { ...base, meters: null, recent: 6 }), /alerts in a minute/);
  assert.match(guard({ action: 'buy' }, { ...base, meters: null, cfg: { ...cfg, allowed: ['ETH'] } }), /allowed/);
});

test('orders are built to the API schema and capped', () => {
  const { body, notional } = buildOrder({ action: 'buy', usd: 1000, id: 'abc' }, { market: MARKETS[0], accountId: 'acc1', price: 97000, cfg });
  assert.deepEqual(Object.keys(body).sort(), ['account_id', 'client_order_id', 'expected_price', 'leverage', 'margin_mode', 'market_id', 'side', 'size', 'type'].sort());
  assert.equal(body.size, 0.01); assert.equal(body.leverage, 2); assert.equal(body.client_order_id, 'tv:abc'); assert.ok(notional < 1000);
  assert.throws(() => buildOrder({ action: 'buy', size: 1 }, { market: MARKETS[0], accountId: 'a', price: 97000, cfg }), /over your max/);
  assert.throws(() => buildOrder({ action: 'buy', size: 0.0001 }, { market: MARKETS[0], accountId: 'a', price: 97000, cfg }), /minimum/);
  assert.throws(() => buildOrder({ action: 'buy', size: 0.01 }, { market: MARKETS[0], accountId: 'a', price: null, cfg }), /No price/);
  const tpsl = buildOrder({ action: 'sell', size: 0.01, tp: 95000, sl: 98000, leverage: 50 }, { market: MARKETS[0], accountId: 'a', price: 97000, cfg }).body;
  assert.equal(tpsl.take_profit_price, 95000); assert.equal(tpsl.stop_loss_price, 98000); assert.equal(tpsl.leverage, 2);
});

test('passphrase check', () => { assert.ok(sameSecret('abc', 'abc')); assert.ok(!sameSecret('abc', 'abd')); assert.ok(!sameSecret('', '')); });

// ---------- end to end: real server, fake MyFundedPerps API ----------
const calls = []; let risk = { daily_loss_room: 4000, max_drawdown_room: 6000 }, fake, app, appPort, hookPort, closeAllHits = 0;
const ACCOUNT = { id: 'acc1', account_number: 'FP-1', name: 'Test', display_name: 'Test 100K', stage: 'evaluation', status: 'active', starting_balance: 100000, balance: 100000, created_at: 0 };
const send = (res, code, data, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify({ data })); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  fake = http.createServer((req, res) => {
    let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => {
      const u = new URL(req.url, 'http://x'), p = u.pathname.replace(/^\/v1/, '');
      calls.push({ method: req.method, path: p, body: s ? JSON.parse(s) : undefined, key: req.headers['idempotency-key'], auth: req.headers.authorization });
      if (p === '/markets') return send(res, 200, MARKETS);
      if (p === '/accounts') return send(res, 200, [ACCOUNT]);
      if (p === '/accounts/acc1') return send(res, 200, { ...ACCOUNT, risk: { equity: 100000, unrealized_pnl: 0, daily_loss_floor: 96000, max_drawdown_floor: 94000, ...risk, remaining_profit_equity: 8000, requirements: { daily_loss_pct: 4, max_drawdown_pct: 6, profit_target_pct: 8 } } });
      if (p === '/fills') return send(res, 200, []);
      if (p === '/positions') return send(res, 200, [{ id: 'pos1', account_id: 'acc1', market_id: 'binance|BTCUSDT', side: 'long', size: 0.01, entry_price: 97000 }]);
      if (req.method === 'POST' && p === '/orders') return send(res, 201, { id: 'o1', status: 'filled', ...JSON.parse(s) });
      if (req.method === 'POST' && p === '/positions/pos1/close') return send(res, 201, { id: 'o2', status: 'filled' });
      if (req.method === 'POST' && p === '/accounts/acc1/close-all-positions') { closeAllHits++; return closeAllHits === 1 ? send(res, 202, { status: 'running', total_count: 2, succeeded_count: 1 }, { 'Retry-After': '1' }) : send(res, 201, { status: 'completed', total_count: 2, succeeded_count: 2 }); }
      send(res, 404, null);
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const dir = mkdtempSync(join(tmpdir(), 'pass-live-test-')), envFile = join(dir, '.env');
  writeFileSync(envFile, 'WEBHOOK_SECRET=s3cret\nTRADING_ENABLED=true\n');
  appPort = 47000 + Math.floor(Math.random() * 900); hookPort = appPort + 1;
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  app = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PASS_LIVE_ENV: envFile, FP_API_KEY: 'fp_test_fakekey12345', FP_API_BASE: `http://127.0.0.1:${fake.address().port}/v1`, FP_STREAM_URL: 'ws://127.0.0.1:9/', PORT: String(appPort), NO_OPEN: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  app.stdout.on('data', () => {}); app.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 50; i++) { await wait(100); try { await fetch(`http://localhost:${appPort}/api/status`); break; } catch {} }
  await wait(600);
});
after(() => { app?.kill(); fake?.close(); });

const alert = (body) => fetch(`http://127.0.0.1:${hookPort}/tv`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
const orders = () => calls.filter((c) => c.method === 'POST' && c.path === '/orders');
const setBridge = (b) => fetch(`http://localhost:${appPort}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: `http://localhost:${appPort}` }, body: JSON.stringify(b) });

test('a TradingView alert places one order with an idempotency key', async () => {
  const r = await alert({ passphrase: 's3cret', action: 'buy', symbol: 'BINANCE:BTCUSDT.P', usd: 1000, price: 97000, sl: 95000, id: 'bar-1' });
  assert.equal(r.status, 202); await wait(400);
  assert.equal(orders().length, 1);
  const o = orders()[0];
  assert.equal(o.body.market_id, 'binance|BTCUSDT'); assert.equal(o.body.side, 'buy'); assert.equal(o.body.size, 0.01); assert.equal(o.body.stop_loss_price, 95000);
  assert.ok(o.key && o.key.length >= 16); assert.equal(o.auth, 'Bearer fp_test_fakekey12345');
});

test('the same alert sent twice only trades once', async () => {
  await alert({ passphrase: 's3cret', action: 'buy', symbol: 'BTCUSDT', usd: 1000, price: 97000, id: 'bar-1' }); await wait(300);
  assert.equal(orders().length, 1);
});

test('a wrong passphrase is refused and never trades', async () => {
  const r = await alert({ passphrase: 'nope', action: 'buy', symbol: 'BTCUSDT', usd: 1000, price: 97000, id: 'x1' });
  assert.equal(r.status, 401); await wait(200); assert.equal(orders().length, 1);
});

test('a broken alert with a wrong passphrase is refused before anything else', async () => {
  for (const body of [{ passphrase: 'nope', action: 'buy', symbol: 'BTCUSDT' }, { action: 'wat' }, 'not json']) {
    const r = await alert(body); assert.equal(r.status, 401);
  }
  const st = await (await fetch(`http://localhost:${appPort}/api/status`)).json();
  assert.ok(!st.alerts.some((x) => /size|Unknown action|must be JSON/.test(x.text)));
});

test('close finds the open position and closes it', async () => {
  await alert({ passphrase: 's3cret', action: 'close', symbol: 'BTCUSDT', id: 'c1' }); await wait(400);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/positions/pos1/close' && c.key));
});

test('close_all keeps going through 202 until completed', async () => {
  await alert({ passphrase: 's3cret', action: 'close_all', id: 'ca1' }); await wait(1800);
  const hits = calls.filter((c) => c.path === '/accounts/acc1/close-all-positions');
  assert.equal(hits.length, 2); assert.equal(hits[0].key, hits[1].key);
});

test('new trades pause when the daily limit is 85% used', async () => {
  risk = { daily_loss_room: 600, max_drawdown_room: 6000 }; await wait(3000); // let the poll pick it up
  await alert({ passphrase: 's3cret', action: 'sell', symbol: 'BTCUSDT', usd: 1000, price: 97000, id: 'b2' }); await wait(400);
  assert.equal(orders().length, 1);
  const st = await (await fetch(`http://localhost:${appPort}/api/status`)).json();
  assert.match(st.alerts[0].text, /Daily loss limit 85% used/); assert.equal(st.alerts[0].status, 'blocked');
  risk = { daily_loss_room: 4000, max_drawdown_room: 6000 };
});

test('dry run sends nothing', async () => {
  assert.equal((await setBridge({ enabled: false })).status, 200); await wait(2800);
  await alert({ passphrase: 's3cret', action: 'buy', symbol: 'ETHUSDT', usd: 500, price: 3400, id: 'd1' }); await wait(400);
  assert.equal(orders().length, 1);
  const st = await (await fetch(`http://localhost:${appPort}/api/status`)).json();
  assert.equal(st.alerts[0].status, 'dry'); assert.match(st.alerts[0].text, /would BUY/);
});

test('setup API refuses requests from other sites, and never returns the key', async () => {
  const r = await fetch(`http://localhost:${appPort}/api/bridge`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{"enabled":true}' });
  assert.equal(r.status, 403);
  const st = await (await fetch(`http://localhost:${appPort}/api/status`)).text();
  assert.ok(!st.includes('fakekey12345')); assert.ok(st.includes('fp_test_••••2345'));
});
