# Pass Live

**Your MyFundedPerps challenge, live on stream.**

Pass Live is an OBS overlay for traders who stream their challenge. It shows your equity against the profit target and the loss limits, every fill as it happens, and a warning before you blow the account, all from the MyFundedPerps account stream.

- Equity line against the **target**, **daily loss limit** and **max drawdown** lines
- Meters: progress to target, daily loss used, max drawdown used
- A toast for every fill (side, size, market, price, P&L)
- Warnings at **50 / 75 / 90 %** of a limit; the panel turns orange, then pulses red
- A burst when you pass; the failed rule if you breach
- **Card** (corner) or **bar** (top strip) layout, dark or light, three sizes
- **Demo mode** with no key, so you can set up your scene first

> Unofficial community tool, not made by or affiliated with MyFundedPerps. Read-only: it never places, changes or cancels orders.

## How it works

```
MyFundedPerps API ──(your key)──> Pass Live app on your computer ──(numbers only)──> OBS Browser Source
   account stream (WebSocket)       localhost:4747                                  /overlay
   account risk snapshot (REST)
```

Browsers (and OBS) can't send the API key the stream needs, so a tiny local app holds the key and serves the overlay on `localhost`. **Your key never leaves your computer and never reaches OBS or your stream.**

It reads your account's real rules from the API (each plan's target and limits differ), follows the account stream with resume and reconnect handling, and polls the risk snapshot every 2.5 s for live equity.

## Quick start

Needs [Node.js](https://nodejs.org) 20 or newer. No other installs.

```bash
git clone https://github.com/AtomiqTraders/pass-live
cd pass-live
npm run demo
```

Open http://localhost:4747 to see it with a demo account.

### Connect your account

1. On myfundedperpetuals.com go to **Settings → API keys** and create a **Read Only** key. Use **Test (Sandbox)** to try it on a sandbox account first.
2. Copy the example config and paste your key after `FP_API_KEY=`:
   ```bash
   cp .env.example .env
   ```
3. Start it:
   ```bash
   npm start
   ```
4. Open http://localhost:4747, pick the account and look, and copy the overlay URL.

### Add it to OBS

Sources → **+** → **Browser** → paste the URL → width **1920**, height **1080**. The page is transparent; only the panel shows.

URL options: `layout=card|bar`, `corner=left|right`, `pos=bottom|top`, `theme=dark|light`, `scale=0.8|1|1.3`, `account=<id>`. Demo only: `demo`, `from=<seconds>` (start partway through the demo day), `speed=<x>`.

## Security

- The app only listens on `127.0.0.1` and refuses requests that don't come to `localhost` (blocks other websites from reading your numbers).
- A Read Only key is enough; the app has no code that trades.
- `.env` is git-ignored. Never share it or show it on stream.
- No dependencies; pages ship with a strict Content Security Policy.

## Tests

```bash
npm test
```

## Roadmap

- Sound cues for fills and warnings
- Session recap card at the end of the stream
- More layouts (vertical, minimal)

## License

MIT
