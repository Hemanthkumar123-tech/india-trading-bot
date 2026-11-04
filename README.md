# India Trading Bot

Paper-first stock assistant for NSE. **Not financial advice. No profit guarantee. Most bots lose money.**

## Features
- Scans Nifty, India VIX and a watchlist; labels market BULLISH / NEUTRAL / BEARISH
- Telegram alerts with one-click **Buy** buttons (or `/mode auto`)
- Bearish market: blocks buys and moves money to a liquid ETF (safe mode)
- Stop-loss (-5%), daily loss limit (-3%), max 5 positions
- Password-protected dashboard with equity curve, controls and kill switch
- Optional live trading via Angel One SmartAPI (off by default, hard rupee caps)

## Free data sources (no paid keys)
Yahoo Finance (prices, Nifty, VIX), Google News RSS (per-stock headlines), Economic Times / Moneycontrol / Mint RSS (market mood), Telegram Bot API, Angel One SmartAPI (live only).

## Setup
1. Install Node.js 20+.
2. `git clone <your-repo-url>` and open the folder in VS Code.
3. Copy `.env.example` to `.env` and fill it in (never commit `.env`).
4. Telegram: talk to @BotFather (`/newbot`) for the token, @userinfobot for your chat ID.
5. Set `DASH_PASS` (12+ characters).
6. `npm start`, then open http://localhost:3000 and message your bot `/start`.

## Going live (only after 30+ days of paper results)
Create a SmartAPI app with Angel One (register your static IP), fill the `ANGEL_*` values,
set `LIVE_ENABLED=1`, restart, then use **Go Live** on the dashboard (type `GO LIVE`).
Caps: `LIVE_CAPITAL` and `LIVE_MAX_PER_TRADE`. Check every order in the Angel One app.

## Security
- Only your Telegram chat ID is obeyed. Keep the repo **private**.
- If a secret was ever committed, revoke it and create a new one.
- The live order code has not been tested against a real account: start with 1 share.

## Telegram commands
`/status` `/scan` `/chart` (equity graph) `/portfolio` (money-split graph) `/dashboard` `/mode auto|approve` `/pause` `/resume` `/guide`
Graphs are rendered by the free QuickChart.io service (it receives chart numbers only, never keys).

## Dashboard link from your phone
Run `cloudflared tunnel --url http://localhost:3000` (free) and open the https link it prints.
Put that link in `.env` as `DASH_URL=...` so `/dashboard` sends it to you. The link changes each run.
