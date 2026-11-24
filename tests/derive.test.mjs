import { test } from 'node:test';
import assert from 'node:assert/strict';
import { meters, alertsFor, level, frac, fillOf, nyDay } from '../public/js/derive.js';
import { demoState } from '../public/js/demo.js';

test('percent requirements accept 3 or 0.03', () => { assert.equal(frac(3), 0.03); assert.equal(frac(0.03), 0.03); assert.equal(frac(null), null); });

test('meters from a risk snapshot', () => {
  const base = { id: 'a1', status: 'active', starting_balance: 100000, balance: 102000, risk: { equity: 101500, daily_loss_floor: 99000, max_drawdown_floor: 94000, daily_loss_room: 2500, max_drawdown_room: 7500, remaining_profit_equity: 8500, requirements: { daily_loss_pct: 3, max_drawdown_pct: 6, profit_target_pct: 10 } } };
  const m = meters(base);
  assert.equal(m.equity, 101500); assert.equal(m.pnl, 1500); assert.equal(m.target, 110000);
  assert.ok(Math.abs(m.targetProgress - 0.15) < 1e-9); assert.equal(m.toGo, 8500);
  assert.ok(Math.abs(m.dailyUsed - (1 - 2500 / 3000)) < 1e-9); assert.equal(m.ddUsed, 0); // more room than the limit: nothing used
});

test('missing marks fall back to balance and null rooms stay null', () => {
  const m = meters({ id: 'x', starting_balance: 50000, balance: 50500, risk: { equity: null, daily_loss_room: null, max_drawdown_room: null, requirements: { daily_loss_pct: null, max_drawdown_pct: 5, profit_target_pct: 10 } } });
  assert.equal(m.equity, 50500); assert.equal(m.dailyUsed, null); assert.equal(m.ddUsed, null);
});

test('each warning level fires once per day', () => {
  const seen = {}, mk = (room) => meters({ id: 'a', starting_balance: 100000, balance: 100000, status: 'active', risk: { equity: 100000, daily_loss_room: room, max_drawdown_room: 6000, requirements: { daily_loss_pct: 3, max_drawdown_pct: 6, profit_target_pct: 10 } } });
  assert.deepEqual(alertsFor(mk(3000), seen, 'd1'), []);
  assert.equal(alertsFor(mk(1400), seen, 'd1')[0].level, 50);
  assert.deepEqual(alertsFor(mk(1300), seen, 'd1'), []);
  assert.equal(alertsFor(mk(200), seen, 'd1')[0].level, 90);
  assert.equal(alertsFor(mk(1400), seen, 'd2')[0].level, 50); // new day resets
  assert.equal(level(0.76), 75);
});

test('status change raises an alert', () => {
  const seen = {}, base = { id: 'a', starting_balance: 1e5, balance: 1.1e5, risk: { equity: 1.1e5, requirements: {} } };
  alertsFor(meters({ ...base, status: 'active' }), seen, 'd');
  const out = alertsFor(meters({ ...base, status: 'passed' }), seen, 'd');
  assert.ok(out.some((a) => /passed/i.test(a.text)));
});

test('fills from the stream and from REST look the same', () => {
  const s = fillOf({ id: 'f1', side: 'buy', symbol: 'BTC', size: '0.5', price: '97000', realized_pnl: 12, fee: 1, time: 5 });
  const r = fillOf({ id: 'f1', side: 'buy', market_id: 'binance|BTCUSDT', size: 0.5, fill_price: 97000, realized_pnl: 12, fee: 1, settled_at: 5 });
  assert.equal(s.price, 97000); assert.equal(r.price, 97000); assert.equal(r.symbol, 'BTCUSDT'); assert.equal(s.time, 5);
});

test('New York day key', () => { assert.equal(nyDay(Date.UTC(2026, 0, 2, 4, 0)), '2026-01-01'); assert.equal(nyDay(Date.UTC(2026, 0, 2, 6, 0)), '2026-01-02'); });

test('demo feed reaches the 75% daily warning and recovers', () => {
  const seen = {}; let levels = [];
  for (let s = 0; s < 84; s += 0.5) for (const a of alertsFor(meters(demoState(s).account), seen, 'd')) levels.push(a.level);
  assert.deepEqual(levels, [50, 75]);
  assert.ok(meters(demoState(83).account).dailyUsed < 0.2);
});
