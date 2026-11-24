# Pass Live

**Your MyFundedPerps challenge, live on stream. And your TradingView alerts, placing your trades.**

Website: see `site/` (deploys to Vercel). Code: https://github.com/AtomiqTraders/pass-live

Pass Live is a small app that runs on your computer. It gives you:

1. **An OBS overlay** that shows your equity against the profit target and the loss limits, every fill as it happens, and a warning before you blow the account.
2. **A TradingView bridge** that turns your TradingView alerts into orders on your MyFundedPerps account, with guards so one bad alert can't blow the account.

Overlay features:

- Equity line against the **target**, **daily loss limit** and **max drawdown** lines
- Meters: progress to target, daily loss used, max drawdown used
- A toast for every fill (side, size, market, price, P&L) and for every TradingView alert
- Warnings at **50 / 75 / 90 %** of a limit; the panel turns orange, then pulses red
- A burst when you pass; the failed rule if you breach
- **Card** (corner) or **bar** (top strip) layout, dark or light, three sizes
- **Demo mode** with no key, so you can set up your scene first

> Unofficial community tool, not made by or affiliated with MyFundedPerps. Trading is risky; you're responsible for the orders your alerts send.

## Install

You need **[Node.js](https://nodejs.org) 22 or newer** (free). Nothing else.

### Windows

1. Install Node.js: download the **LTS** installer from [nodejs.org](https://nodejs.org) and click through it.
2. [Download Pass Live as a ZIP](https://github.com/AtomiqTraders/pass-live/archive/refs/heads/main.zip), right-click it → **Extract All**.
3. Open the extracted folder and double-click **`start.bat`**. Your browser opens http://localhost:4747.
4. Keep that window open while you stream. Close it to stop.

### Linux and macOS

```bash
git clone https://github.com/AtomiqTraders/pass-live
cd pass-live
./start.sh
```

No git? [Download the ZIP](https://github.com/AtomiqTraders/pass-live/archive/refs/heads/main.zip), unzip it, run `./start.sh` inside. Stop with `Ctrl+C`; update with `git pull`.

`npm start` works everywhere too. Add `--no-open` (or `NO_OPEN=1`) to stop it opening the browser.

## Set up (on the page at localhost:4747)

### 1 · Connect your account

On myfundedperpetuals.com go to **Settings → API keys** and create a key. Pick **Test (Sandbox)** to practise first.

- **Read Only** is enough for the overlay.
- **Read And Trade** is needed for TradingView trading.

Paste it into step 1. Pass Live checks it with MyFundedPerps, then saves it in the `.env` file on your computer (readable only by you). Sandbox keys (`fp_test_`) and live keys (`fp_live_`) go to the right servers automatically.

### 2 · Add the overlay to OBS

Pick the account and the look, copy the URL, then in OBS: Sources → **+** → **Browser** → paste the URL → width **1920**, height **1080**. The page is transparent; only the panel shows.

URL options: `layout=card|bar`, `corner=left|right`, `pos=bottom|top`, `theme=dark|light`, `scale=0.8|1|1.3`, `account=<id>`. Demo only: `demo`, `from=<seconds>`, `speed=<x>`.

### 3 · Trade from TradingView

TradingView webhooks need a **paid TradingView plan**.

1. **Choose your guards** on the Setup page: the account, max order value ($), max leverage, the point at which new trades pause (e.g. 80% of the daily loss limit used), and optionally the only symbols allowed.
2. **Start a tunnel** so TradingView can reach your computer. Alerts come in on port **4748**:
   - **ngrok** (same address every time): sign up free, claim your static domain, then
     `ngrok http --url=YOUR-DOMAIN.ngrok-free.app 4748`
     Webhook URL: `https://YOUR-DOMAIN.ngrok-free.app/tv`
   - **Cloudflare** (no account, new address each run):
     Windows `winget install Cloudflare.cloudflared` · Linux: the [cloudflared package](https://github.com/cloudflare/cloudflared/releases), then
     `cloudflared tunnel --url http://localhost:4748`
     Webhook URL: the `https://….trycloudflare.com` address it prints, plus `/tv`
     Some internet providers block quick tunnels ("failed to request quick Tunnel"); use ngrok then.
3. **Make the alert** in TradingView: Notifications → tick **Webhook URL** → paste the URL → paste the alert message from the Setup page into **Message**.
4. **Watch it in Dry run** first. Every alert shows on the Setup page (and as a toast on the overlay) with what it *would* have ordered. When it does what you expect, tick **Send real orders**.

#### Alert message format

JSON, one order per alert. The Setup page fills in your passphrase.

```
{"passphrase":"YOUR-PASSPHRASE","action":"buy","symbol":"{{ticker}}","usd":500,"price":{{close}},"id":"{{timenow}}"}
```

| Field | Meaning |
|---|---|
| `passphrase` | Required. Must match the one on the Setup page. |
| `action` | `buy`/`long`, `sell`/`short`, `close`/`exit`/`flat` (close this symbol), `close_all` |
| `symbol` | TradingView ticker, e.g. `{{ticker}}` → `BTCUSDT.P`, mapped to the MyFundedPerps market |
| `size` / `qty` / `contracts` | Size in coins (e.g. `0.01` BTC), **or** |
| `usd` | Order value in dollars |
| `price` | Optional. Used to size `usd` orders; if missing, Pass Live asks MyFundedPerps for a quote |
| `tp`, `sl` | Optional take-profit and stop-loss prices (`0` = none) |
| `leverage` | Optional, capped at your max leverage |
| `id` | Optional but recommended. The same `id` never trades twice |

For a Pine strategy, use the **Pine strategy** template: it sends `{{strategy.order.action}}` and `{{strategy.order.contracts}}`.

#### Guards

- Starts in **dry run**: nothing is sent until you switch it on.
- Every alert needs your passphrase; wrong passphrases are refused.
- Orders above your max order value or max leverage are refused.
- New trades pause when the daily loss limit or max drawdown is past your chosen share, or the account isn't active.
- **Closing is never blocked**, so you can always get out.
- Duplicate alerts (same `id`, or the same alert within 2 minutes) never trade twice; retries reuse the same idempotency key.
- At most 6 alerts a minute.

Don't show the Setup page on stream: anyone with your passphrase and tunnel address could send alerts. Use **New** to change the passphrase.

## How it works

```
TradingView alert ─> tunnel ─> :4748/tv ──┐
                                          ├─ Pass Live (your computer) ─(your key)─> MyFundedPerps API
OBS Browser Source <─ numbers only ─ :4747┘     account stream (WebSocket) + risk snapshot (REST)
```

Browsers (and OBS) can't send the API key the account stream needs, so the local app holds the key and serves the overlay on `localhost`. **Your key never leaves your computer and never reaches OBS, TradingView or your stream.**

It reads your account's real rules from the API (each plan's target and limits differ), follows the account stream with resume and reconnect handling, and polls the risk snapshot every 2.5 s for live equity.

## Security

- The Setup page and overlay only listen on `127.0.0.1` and refuse requests that aren't addressed to `localhost`, so other websites can't read your numbers or change settings. Changes also need a same-origin JSON request.
- The webhook port only accepts `POST /tv` with your passphrase (constant-time check), small bodies and a rate limit.
- `.env` is git-ignored and saved readable only by you. The key is shown masked and never logged.
- No dependencies; pages ship with a strict Content Security Policy.

## Website

The project site lives in `site/`. `node scripts/build-site.mjs` builds it into `dist/` with the real overlay in demo mode; `vercel.json` deploys it as a static site.

## Tests

```bash
npm test
```

Covers the overlay maths and the bridge end to end against a fake MyFundedPerps API (order shape, idempotency, duplicates, wrong passphrase, close, close-all, the limit pause, dry run, cross-site requests, key masking).

## License

MIT
