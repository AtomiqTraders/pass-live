// Pure helpers shared by the relay (Node) and the overlay (browser).
// Turn a MyFundedPerps Account (with its AccountRisk snapshot) into the numbers the overlay shows.

/** Requirements may come as 3 or 0.03; return a fraction. */
export const frac = (v) => (v == null || !isFinite(v) ? null : Math.abs(v) > 1 ? v / 100 : v);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * @param {object} acct Account from GET /v1/accounts/{id} (fields: starting_balance, balance, status, stage, risk{...})
 * @returns meters, or null if there's no usable risk snapshot
 */
export function meters(acct) {
  if (!acct) return null;
  const r = acct.risk || {}, req = r.requirements || {};
  const start = num(acct.starting_balance), balance = num(acct.balance);
  const equity = num(r.equity) ?? balance;
  const tPct = frac(req.profit_target_pct), dPct = frac(req.daily_loss_pct), mPct = frac(req.max_drawdown_pct);
  const targetAmt = tPct != null && start ? tPct * start : null;
  const dailyAmt = dPct != null && start ? dPct * start : null;
  const ddAmt = mPct != null && start ? mPct * start : null;
  const dailyRoom = num(r.daily_loss_room), ddRoom = num(r.max_drawdown_room);
  const remaining = num(r.remaining_profit_equity) ?? num(r.remaining_profit);
  return {
    status: acct.status || 'active',
    stage: acct.stage || 'evaluation',
    start, balance, equity,
    pnl: equity != null && start != null ? equity - start : null,
    upnl: num(r.unrealized_pnl),
    marksComplete: r.marks_complete !== false,
    target: targetAmt != null ? start + targetAmt : null,
    targetProgress: targetAmt ? clamp01(remaining != null ? 1 - remaining / targetAmt : (equity - start) / targetAmt) : null,
    toGo: remaining != null ? Math.max(0, remaining) : targetAmt != null && equity != null ? Math.max(0, start + targetAmt - equity) : null,
    dailyFloor: num(r.daily_loss_floor), dailyRoom, dailyAmt,
    dailyUsed: dailyAmt && dailyRoom != null ? clamp01(1 - dailyRoom / dailyAmt) : null,
    ddFloor: num(r.max_drawdown_floor), ddRoom, ddAmt,
    ddUsed: ddAmt && ddRoom != null ? clamp01(1 - ddRoom / ddAmt) : null,
    pcts: { target: tPct, daily: dPct, dd: mPct },
  };
}

function num(v) { return v == null || v === '' || !isFinite(+v) ? null : +v; }

/** Which warning level (0, 50, 75, 90) a usage fraction is at. */
export const level = (used) => (used == null ? 0 : used >= 0.9 ? 90 : used >= 0.75 ? 75 : used >= 0.5 ? 50 : 0);

/**
 * Remembers which levels already fired today so each warning shows once.
 * Returns alerts to show for this update.
 */
export function alertsFor(m, seen, dayKey) {
  const out = [];
  if (!m) return out;
  if (seen.day !== dayKey) { seen.day = dayKey; seen.daily = 0; }
  const dl = level(m.dailyUsed), md = level(m.ddUsed);
  if (dl > (seen.daily || 0)) { seen.daily = dl; out.push({ kind: 'daily', level: dl, text: dl >= 90 ? 'Daily limit 90% used: one more loss could end it' : `Daily loss limit ${dl}% used` }); }
  if (md > (seen.dd || 0)) { seen.dd = md; out.push({ kind: 'dd', level: md, text: md >= 90 ? 'Max drawdown 90% used: protect the account' : `Max drawdown ${md}% used` }); }
  if (seen.status && seen.status !== m.status) out.push({ kind: 'status', level: 100, text: m.status === 'passed' ? 'Challenge passed!' : m.status === 'failed' ? 'Challenge failed' : `Account ${m.status}` });
  seen.status = m.status;
  return out;
}

/** New York calendar day, which is when the daily loss limit resets. */
export function nyDay(ms = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms));
}

/** Normalise a fill from the stream (price/order_type) or REST (fill_price/type). */
export function fillOf(f) {
  if (!f) return null;
  return {
    id: f.id, side: f.side, symbol: f.symbol || (f.market_id || '').split('|').pop(),
    size: num(f.size), price: num(f.price ?? f.fill_price), pnl: num(f.realized_pnl), fee: num(f.fee),
    time: num(f.time ?? f.settled_at) ?? Date.now(),
  };
}
