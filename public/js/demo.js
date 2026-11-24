// Demo feed: a believable $100K challenge day, in the same shape as the real API.
// Used when there's no API key (and on the hosted demo page). Seeded, so it plays the same every time.

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const START = 100000, DAY_START = 104000, TARGET = 0.10, DLL = 0.03, MDD = 0.06;
// a scripted session: [seconds into the loop, realized P&L of the trade, symbol, side]
const SCRIPT = [
  [6, 420, 'BTC', 'sell'], [13, -310, 'ETH', 'sell'], [20, 650, 'SOL', 'buy'], [27, -900, 'BTC', 'buy'], [33, -850, 'BTC', 'sell'],
  [39, -700, 'ETH', 'buy'], [45, -650, 'SOL', 'buy'], [54, 380, 'SOL', 'sell'], [61, 910, 'BTC', 'sell'], [68, 540, 'ETH', 'sell'], [76, 780, 'BTC', 'buy'],
];
const PRICES = { BTC: 97000, ETH: 3400, SOL: 182 };
const LOOP = 84;

/** Account (API shape) and the fills so far, for a given time in seconds since the demo started. */
export function demoState(sec) {
  const s = sec % LOOP, r = rng(7 + Math.floor(sec / LOOP));
  let realized = DAY_START - START, fills = [];
  for (const [t, pnl, sym, side] of SCRIPT) {
    if (t > s) break;
    realized += pnl;
    const p = PRICES[sym] * (1 + (r() - 0.5) * 0.004);
    fills.push({ id: `demo-${Math.floor(sec / LOOP)}-${t}`, side, symbol: sym, size: +(Math.abs(pnl) / (p * 0.006)).toFixed(sym === 'SOL' ? 1 : 3), price: +p.toFixed(sym === 'SOL' ? 2 : 1), realized_pnl: pnl, fee: Math.abs(pnl) * 0.03, time: 0, t });
  }
  // a little open P&L wobble between trades
  const wob = Math.sin(s * 0.9) * 90 + Math.sin(s * 2.3) * 40;
  const balance = START + realized, equity = balance + wob;
  const dailyFloor = DAY_START - DLL * START, ddFloor = START * (1 - MDD);
  return {
    account: {
      id: 'demo', account_number: 'DEMO-100K', name: 'Signature 100K', display_name: 'Signature $100K (demo)',
      stage: 'evaluation', status: 'active', starting_balance: START, balance, created_at: 0,
      risk: {
        observed_at: 0, marks_complete: true, missing_markets: [], equity, unrealized_pnl: wob, margin_used: 0, available_balance: balance, gross_exposure: 0,
        daily_loss_floor: dailyFloor, max_drawdown_floor: ddFloor, daily_loss_room: equity - dailyFloor, max_drawdown_room: equity - ddFloor,
        remaining_profit: Math.max(0, START * (1 + TARGET) - balance), remaining_profit_equity: Math.max(0, START * (1 + TARGET) - equity),
        requirements: { daily_loss_pct: DLL * 100, max_drawdown_pct: MDD * 100, profit_target_pct: TARGET * 100, consistency_pct: null, minimum_trading_days: null },
      },
    },
    fills,
    loop: LOOP,
  };
}
