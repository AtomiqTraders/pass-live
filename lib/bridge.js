// TradingView -> MyFundedPerps bridge. Pure helpers (tested) plus the executor that talks to the API.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

/** Settings with safe defaults. Values come from .env (strings) or the Setup page. */
export function bridgeConfig(env = {}) {
  const n = (v, d) => (v == null || v === '' || !isFinite(+v) ? d : +v);
  return {
    enabled: String(env.TRADING_ENABLED || '').toLowerCase() === 'true', // false = dry run
    secret: env.WEBHOOK_SECRET || '',
    accountId: env.WEBHOOK_ACCOUNT_ID || '',
    maxOrderUsd: n(env.MAX_ORDER_USD, 5000),
    maxLeverage: n(env.MAX_LEVERAGE, 2),
    blockAt: n(env.BLOCK_AT_LIMIT_USED, 0.8), // pause new trades at 80% of a limit
    allowed: (env.ALLOWED_SYMBOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
    perMinute: n(env.MAX_ALERTS_PER_MINUTE, 6),
  };
}

export const sameSecret = (a, b) => {
  if (!a || !b) return false;
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Turn a TradingView alert body into an intent, or throw a readable error. */
export function parseAlert(body) {
  let a = body;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { throw new Error('Alert message must be JSON. Copy the template from the Setup page.'); } }
  if (!a || typeof a !== 'object') throw new Error('Empty alert');
  const action = String(a.action || '').toLowerCase().trim();
  const map = { buy: 'buy', long: 'buy', sell: 'sell', short: 'sell', close: 'close', exit: 'close', flat: 'close', close_all: 'close_all', closeall: 'close_all' };
  if (!map[action]) throw new Error(`Unknown action "${a.action}". Use buy, sell, close or close_all.`);
  const num = (v) => (v == null || v === '' || !isFinite(+v) ? null : +v);
  const intent = {
    action: map[action], symbol: String(a.symbol || a.ticker || '').trim(),
    size: num(a.size ?? a.qty ?? a.contracts), usd: num(a.usd), price: num(a.price),
    tp: num(a.tp), sl: num(a.sl), leverage: num(a.leverage),
    id: a.id != null ? String(a.id).slice(0, 80) : null, passphrase: a.passphrase,
  };
  if (intent.action !== 'close_all' && !intent.symbol) throw new Error('Missing symbol');
  if ((intent.action === 'buy' || intent.action === 'sell') && !(intent.size > 0) && !(intent.usd > 0)) throw new Error('Give a size (in coins) or usd (position value).');
  return intent;
}

/** TradingView tickers (BTCUSDT, BINANCE:BTCUSDT.P, BTCUSDT.P, BTC) or a market_id -> a MyFundedPerps market. */
export function findMarket(symbol, markets) {
  if (!symbol) return null;
  const raw = symbol.trim();
  if (raw.includes('|')) return markets.find((m) => m.market_id === raw) || null;
  const s = raw.toUpperCase().replace(/^[A-Z0-9_]+:/, '').replace(/(\.P|\.PERP|PERP)$/, '');
  const dv = markets.filter((m) => m.default_venue !== false);
  return dv.find((m) => m.coin.toUpperCase() === s)
    || dv.find((m) => m.symbol.toUpperCase() === s)
    || dv.find((m) => (m.symbol + 'USDT').toUpperCase() === s)
    || dv.find((m) => m.coin.toUpperCase().replace(/^XYZ:/, '') === s)
    || null;
}

export function floorStep(size, step, decimals) {
  if (!(step > 0)) return size;
  const d = Number.isInteger(decimals) ? decimals : Math.max(0, -Math.floor(Math.log10(step)));
  return Number((Math.floor(size / step + 1e-9) * step).toFixed(d));
}

/**
 * Decide whether an opening order may go out. Closes are never blocked.
 * @returns {string|null} reason to block, or null to allow
 */
export function guard(intent, { market, meters, status, cfg, recent }) {
  if (intent.action === 'close' || intent.action === 'close_all') return null;
  if (status && status !== 'active') return `Account is ${status}; no new trades.`;
  if (cfg.allowed.length && !cfg.allowed.includes(market.symbol.toUpperCase()) && !cfg.allowed.includes(market.coin.toUpperCase())) return `${market.symbol} isn't in your allowed symbols.`;
  if (meters) {
    if (meters.dailyUsed != null && meters.dailyUsed >= cfg.blockAt) return `Daily loss limit ${Math.round(meters.dailyUsed * 100)}% used; new trades are paused (you set ${Math.round(cfg.blockAt * 100)}%).`;
    if (meters.ddUsed != null && meters.ddUsed >= cfg.blockAt) return `Max drawdown ${Math.round(meters.ddUsed * 100)}% used; new trades are paused.`;
  }
  if (recent >= cfg.perMinute) return `More than ${cfg.perMinute} alerts in a minute; slowing down.`;
  return null;
}

/** Build the CreateOrderRequest for buy/sell. Returns { body, notional } or throws. */
export function buildOrder(intent, { market, accountId, price, cfg }) {
  if (!(price > 0)) throw new Error('No price for the order. Add "price": {{close}} to the alert.');
  let size = intent.size > 0 ? intent.size : intent.usd / price;
  size = floorStep(size, market.size_step, market.size_decimals);
  const notional = size * price;
  if (!(size >= market.min_size)) throw new Error(`Size is below ${market.symbol}'s minimum of ${market.min_size}.`);
  if (notional < (market.min_notional || 0)) throw new Error(`Order value $${notional.toFixed(2)} is below the $${market.min_notional} minimum.`);
  if (notional > cfg.maxOrderUsd) throw new Error(`Order value $${Math.round(notional).toLocaleString('en-US')} is over your max of $${cfg.maxOrderUsd.toLocaleString('en-US')}.`);
  const leverage = Math.max(1, Math.min(intent.leverage || cfg.maxLeverage, cfg.maxLeverage, market.max_leverage || 1));
  const body = {
    client_order_id: `tv:${String(intent.id || randomUUID()).replace(/[^\w:.-]/g, '').slice(0, 100)}`,
    type: 'market', account_id: accountId, market_id: market.market_id, side: intent.action,
    size, expected_price: price, leverage, margin_mode: 'isolated',
  };
  if (intent.tp > 0) body.take_profit_price = intent.tp;
  if (intent.sl > 0) body.stop_loss_price = intent.sl;
  return { body, notional };
}

/** Fingerprint used to ignore TradingView sending the same alert twice. */
export const alertKey = (intent) => (intent.id ? `id:${intent.id}` : createHash('sha256').update(JSON.stringify({ ...intent, passphrase: undefined })).digest('hex').slice(0, 24));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one alert end to end. `api(method, path, body, headers)` talks to MyFundedPerps and returns { status, data, retryAfter }.
 * Returns { status: 'sent'|'dry'|'blocked'|'error', text, detail }
 */
export async function execute(intent, ctx) {
  const { api, cfg, markets, accountId, meters, status, recent, log = () => {} } = ctx;
  if (intent.action === 'close_all') {
    if (!cfg.enabled) return { status: 'dry', text: 'Dry run: would close all positions' };
    const key = randomUUID(); let op;
    for (let i = 0; i < 12; i++) {
      const r = await api('POST', `/accounts/${encodeURIComponent(accountId)}/close-all-positions`, undefined, { 'Idempotency-Key': key });
      op = r.data; if (r.status !== 202 && op?.status === 'completed') break;
      await wait(Math.min(5000, (+r.retryAfter || 1) * 1000));
    }
    return { status: 'sent', text: `Closed ${op?.succeeded_count ?? '?'} of ${op?.total_count ?? '?'} positions`, detail: op };
  }
  const market = findMarket(intent.symbol, markets);
  if (!market) return { status: 'error', text: `Unknown symbol "${intent.symbol}". Use a MyFundedPerps market such as BTCUSDT.` };
  if (intent.action === 'close') {
    const pos = (await api('GET', `/positions?account_id=${encodeURIComponent(accountId)}&status=open`)).data || [];
    const p = pos.find((x) => x.market_id === market.market_id);
    if (!p) return { status: 'error', text: `No open ${market.symbol} position to close.` };
    if (!cfg.enabled) return { status: 'dry', text: `Dry run: would close ${p.side} ${p.size} ${market.symbol}` };
    // A market close needs the price we expect (the live API refuses an empty body), like a market order.
    const exitSide = p.side === 'long' ? 'sell' : 'buy';
    let price = intent.price;
    if (!(price > 0)) {
      try { const q = await api('GET', `/markets/${encodeURIComponent(market.market_id)}/quote?side=${exitSide}&size=${p.size}`); price = +(exitSide === 'sell' ? q.data?.bid : q.data?.ask) || +q.data?.mid; }
      catch (e) { log('quote failed', e.message); }
    }
    const body = { type: 'market' };
    if (price > 0) body.expected_price = price;
    if (intent.id) body.client_order_id = `tv:${intent.id}`.slice(0, 128);
    const key = randomUUID(); let last;
    for (let i = 0; i < 3; i++) { // same key on every retry, so a timeout can never close twice
      try {
        const o = (await api('POST', `/positions/${encodeURIComponent(p.id)}/close`, body, { 'Idempotency-Key': key })).data;
        return o?.status === 'rejected' ? { status: 'error', text: `Close rejected: ${o.reject_reason || 'by the exchange'}`, detail: o } : { status: 'sent', text: `Closed ${p.side} ${p.size} ${market.symbol}`, detail: o };
      } catch (e) { last = e; if (!e.retry) break; await wait(600 * (i + 1)); }
    }
    return { status: 'error', text: last ? last.message : 'Close failed' };
  }
  const blocked = guard(intent, { market, meters, status, cfg, recent });
  if (blocked) return { status: 'blocked', text: blocked };
  let price = intent.price;
  if (!(price > 0)) {
    try { const q = await api('GET', `/markets/${encodeURIComponent(market.market_id)}/quote?side=${intent.action}&size=${market.min_size}`); price = +(q.data?.mid ?? q.data?.mid_price ?? q.data?.price); }
    catch (e) { log('quote failed', e.message); }
  }
  let built; try { built = buildOrder(intent, { market, accountId, price, cfg }); } catch (e) { return { status: 'error', text: e.message }; }
  const desc = `${intent.action.toUpperCase()} ${built.body.size} ${market.symbol} (~$${Math.round(built.notional).toLocaleString('en-US')}, ${built.body.leverage}x)${intent.sl ? ` SL ${intent.sl}` : ''}${intent.tp ? ` TP ${intent.tp}` : ''}`;
  if (!cfg.enabled) return { status: 'dry', text: `Dry run: would ${desc}`, detail: built.body };
  const key = randomUUID(); let last;
  for (let i = 0; i < 3; i++) { // same key on every retry, so a timeout can never double the order
    try {
      const o = (await api('POST', '/orders', built.body, { 'Idempotency-Key': key })).data;
      return o?.status === 'rejected' ? { status: 'error', text: `Rejected: ${o.reject_reason || 'by the exchange'}`, detail: o } : { status: 'sent', text: `Sent: ${desc}`, detail: o };
    } catch (e) { last = e; if (!e.retry) break; await wait(600 * (i + 1)); }
  }
  return { status: 'error', text: last ? last.message : 'Order failed' };
}
