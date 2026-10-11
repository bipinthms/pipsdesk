# Pipdesk

A personal, self-hosted charting and order-entry app for a MetaTrader 5 prop account (built for FundingPips). It has:

- candlestick charts on the broker's own price feed, with indicators and drawings
- manual order entry from a panel or by dragging lines on the chart
- a risk engine that enforces the prop firm's rules before any order reaches MT5

Personal use only. Every trade is placed manually through the UI. There is no automation, signal following or copy trading.

## Contents

- [How it fits together](#how-it-fits-together)
- [Quick start on a Mac (mock mode)](#quick-start-on-a-mac-mock-mode)
- [Going live (Windows)](#going-live-windows)
- [Using the app](#using-the-app)
- [Risk engine](#risk-engine)
- [Tests](#tests)
- [API reference](#api-reference)
- [Troubleshooting](#troubleshooting)
- [Mock mode details](#mock-mode-details)

## How it fits together

```
Browser ──HTTP/WS──► FastAPI backend (127.0.0.1:8000) ──► mt5_bridge.py ──► MetaTrader5 pkg ──► MT5 terminal ──► broker
                      ├─ risk.py   every order action is checked here first
                      ├─ SQLite    journal, risk settings, drawings, news events
                      └─ serves the built UI (frontend/dist) on the same port
```

| Path | What it is |
|---|---|
| `backend/mt5_bridge.py` | The only code that talks to MT5: connect and reconnect with backoff, data, `order_send`, readable error messages |
| `backend/mt5_mock.py` | A drop-in simulator of the `MetaTrader5` package (`MT5_MOCK=1`) |
| `backend/risk.py` | Pure risk engine; `risk_service.py` connects it to MT5 and SQLite |
| `backend/trading.py` | Each order action runs as one locked step: risk check, then MT5, then journal |
| `backend/api.py`, `backend/stream.py` | REST API and the live WebSocket stream |
| `frontend/` | React + TypeScript + Vite + Tailwind + `lightweight-charts` |
| `frontend/src/lib/indicators.ts` | Indicator maths (unit-tested) |

## Quick start on a Mac (mock mode)

Mock mode simulates prices and fills, so no MT5 install or broker account is needed.

```bash
cd "Trading Platform"
python3 -m venv .venv && source .venv/bin/activate
pip install -r backend/requirements-dev.txt
cp backend/.env.example backend/.env          # MT5_MOCK=1 by default

cd frontend && npm install && npm run build && cd ..
python -m backend                              # UI + API on http://127.0.0.1:8000
```

Open **http://127.0.0.1:8000**. A **MOCK** badge in the header confirms it's simulated.

**Developing with hot reload:** run `python -m backend --reload` in one terminal (restarts on backend changes) and `cd frontend && npm run dev` in another, then open http://127.0.0.1:5173. Vite proxies `/api` to the backend.

## Going live (Windows)

The `MetaTrader5` Python package **only runs on Windows**, next to a running MT5 terminal. Your browser can still be on the Mac.

### 1. Choose where Windows runs

- **Windows 11 VM on the Mac** (Parallels, VMware Fusion or UTM). On Apple Silicon this is Windows 11 on ARM, which runs x64 programs through emulation. You must install the **x64** build of Python, because `MetaTrader5` only ships x64 (`win_amd64`) wheels.
- **Windows VPS.** It is always on and close to the broker's servers.

### 2. On Windows: MT5 terminal

1. Install MetaTrader 5.
   - For a **MetaQuotes-Demo** test account, the standard installer from metatrader5.com already knows the `MetaQuotes-Demo` server.
   - For **FundingPips**, use the terminal from your FundingPips dashboard. Type the server name exactly as FundingPips gives it.
2. Log in: **File → Login to Trade Account**.
3. Allow API trading: **Tools → Options → Expert Advisors → Allow algorithmic trading**, and make sure the **Algo Trading** toolbar button is green. Without this, every order fails with retcode 10027.
4. Leave the terminal running while you use the app.

> **FundingPips rules:** MT5 records trades sent through its Python API as "expert" trades, even though you place each one by hand. Confirm your account terms allow trading through the MT5 API or third-party tools before you go live.

### 3. On Windows: backend

Install **Python 3.12 (x64)** from python.org and Node 20+. Then, in the project folder:

```powershell
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -r backend\requirements.txt        # installs MetaTrader5 on Windows
copy backend\.env.example backend\.env         # start from the example, not the Mac's .env
cd frontend; npm install; npm run build; cd ..
```

Edit `backend\.env`:

```ini
MT5_MOCK=0
MT5_LOGIN=<your login>
MT5_PASSWORD=<your password>
MT5_SERVER=<exact server name, e.g. MetaQuotes-Demo>
# MT5_PATH=C:\Program Files\MetaTrader 5\terminal64.exe   # only if several terminals are installed
APP_HOST=127.0.0.1
# Leave CORS_ORIGINS unset: in live mode only the app itself (port 8000) may call the API.
```

`APP_HOST` must be a loopback address; the backend refuses to start otherwise.

Run `python -m backend`. The log should say `Connected to MT5 terminal`, and the header badge shows **LIVE · DEMO**. On a real-money account it shows **LIVE · REAL** in red.

`backend/.env` is git-ignored and readable only by you. Credentials are never logged and never sent to the browser.

### 4. From the Mac: open the app through an SSH tunnel

Keep the backend bound to `127.0.0.1` on Windows; don't open port 8000 to the network. Enable OpenSSH Server on Windows (**Settings → System → Optional features**), then on the Mac:

```bash
ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -L 8000:127.0.0.1:8000 <windows-user>@<vm-or-vps-address>
```

Open **http://127.0.0.1:8000** on the Mac and check the badge says **LIVE**. Stop any local mock backend first: if something on the Mac already uses port 8000, `ExitOnForwardFailure` makes ssh exit instead of silently leaving you on the mock. `ServerAliveInterval` drops a dead tunnel within about 45 seconds, and the UI then shows "Backend offline".

### 5. Before your first live trade

Open **Settings** and do the following:
1. Set **Initial balance** to the account size.
2. Confirm the **daily loss** and **max drawdown** match your FundingPips rules, and that the **day reset** time matches their server day.
3. Enter the **commission per lot** if your account is charged one.
4. If the broker's symbols have suffixes (for example `EURUSD.raw`), set `SERVER_TIME_SYMBOL` in `.env` to a liquid symbol that exists. The app learns the server's offset from UTC from that symbol's ticks while they're moving, saves it, and keeps the server clock running from it when ticks stop (weekends, holidays). The log says `MT5 server clock is UTC+03:00` when it learns or updates the offset.

## Using the app

### Account bar

- **Badge:** MOCK / LIVE · DEMO / LIVE · REAL.
- **Numbers:** balance, equity, open P/L, today's P/L, margin, and connection status.
- **Meters:** **Daily loss left** and **Drawdown left** show how far equity is above each limit. They turn amber at 50% of the limit used and red at 80%, and show BREACHED at the limit. Hover for the details.
- **Buttons:** **Settings** and the theme toggle.

### Watchlist and chart

- **Watchlist:** search by symbol or description, then press Enter to add. Hover a row and click × to remove it. It shows live bid/ask and the change since the day's open.
- **Timeframes:** M1, M5, M15, H1, H4, D1.
- **Layouts:** the layout button at the top-left of the first chart picks from 13 layouts with 1, 2, 3, 4, 6 or 8 charts (side by side, stacked, rows, columns, grids, or one large chart beside smaller ones). Each chart has its own symbol, timeframe and indicators. Click a chart to make it active (outlined): the watchlist, the Positions/Pending tables and the order panel use the active chart's symbol. The layout is saved in your browser.
- **Panels:** the watchlist, order panel and bottom tabs each have a chevron to hide them; the chart takes the space. A hidden side panel leaves a thin strip that brings it back. A hidden bottom panel keeps its tab bar, and clicking a tab opens it. Panels keep their state while hidden, and this is saved in your browser.
- **History:** drag left and older candles load automatically.
- **Legend:** shows open, high, low, close, volume and indicator values under the crosshair.
- **Times:** shown in **MT5 server time**, so they match the terminal.
- **Indicators menu:**
  - SMA, EMA, Bollinger Bands and VWAP draw on the price chart; RSI and MACD each get their own pane.
  - You can edit periods and colours. The list is saved in your browser.
  - VWAP resets at server midnight.
- **Drawings:**
  - Tools, grouped in the chart toolbar (the arrow next to each group lists the rest; narrow charts fold the toolbar into one button). The ⇤ button at the end hides the toolbar on every chart for more room; the pencil button brings it back, and Alt+key shortcuts still work while it's hidden:
    - Lines: trend line, ray, extended line, arrow, horizontal line, horizontal ray, vertical line, cross line.
    - Channels & Fibonacci: parallel channel, Fib retracement.
    - Shapes: rectangle, ellipse, triangle.
    - Text & measure: text, price range (price change, %, pips, bars and time), long and short position (stop, target, pips and R:R).
  - Place points by dragging, or click point by point. Channels and triangles take a third click. Positions are placed with one click and then adjusted.
  - Shortcuts: Alt+T trend, Alt+H horizontal line, Alt+J horizontal ray, Alt+V vertical line, Alt+C cross, Alt+F Fib, Alt+R rectangle, Alt+X text, Alt+M price range, Alt+L long, Alt+S short.
  - **Magnet** (toolbar): off, weak (snaps to a bar's open/high/low/close when close to it) or strong (always snaps). Hold Ctrl/⌘ while drawing to flip it. Hold Shift to keep a line level.
  - **Keep drawing** (toolbar): stay on the tool after each drawing instead of going back to the cursor.
  - Selecting a drawing shows a style bar: colour, width, line style, text, settings, lock, clone and delete. **Settings** also has fill, extend left/right, labels, Fib levels, font size and exact prices. A drawing's style becomes the default for new drawings of that type.
  - With the cursor tool, drag a drawing to move it or drag its handles to reshape it. Locked drawings can be selected but not moved.
  - **Delete** removes the selected drawing and **Esc** cancels. The ⋯ menu has lock all, hide all and remove all (after confirmation).
  - Drawings are saved per symbol and stay in place when you change timeframe.
  - **Sync drawings across charts** (toolbar link button, or the ⋯ menu) is one setting for every chart. On: charts of the same symbol share drawings, whatever their timeframe, and follow each other's edits. Off: each chart shows only the drawings made on it. Drawings made before this setting existed show on every chart.
  - Drawing preferences (magnet, keep drawing, sync, default styles) are saved in your browser.
- **Licence logo:** the small logo at the chart's bottom-left is the attribution required by the charting library's Apache-2.0 licence.

### Placing and managing trades

- **Order panel:**
  - Buy/Sell, and Market/Limit/Stop.
  - Volume in lots, or **Risk %**, which sizes the volume from the stop distance.
  - SL/TP as pips or prices. A pip is 0.0001 on FX (0.01 on JPY pairs), 0.1 on metals, and 1 on indices and crypto.
  - Shows estimated risk in $ and %, reward, reward:risk, worst-case equity, and the risk engine's verdict before you submit.
- **Confirmations:**
  - Every order, change, close and cancel shows a summary dialog. Enter and Escape cancel it.
  - **One-click** (in the panel header) skips the dialog for orders and cancels. It is off every time the app loads.
  - **Flatten all** and chart drags always ask.
- **Lines on the chart:**
  - Positions: a solid entry line with live P/L, a red SL and a green TP, each labelled with the P/L at that level.
  - Pending orders: dashed lines. The order being built in the panel: dotted lines.
  - Drag SL/TP lines to move them. Drag a position's entry line towards the loss side to set the SL, or the profit side to set the TP.
- **Bottom tabs:**
  - Positions: SL/TP edit, full or partial close, **Flatten all**.
  - Pending: edit, cancel.
  - History: deals with net P/L.
  - Journal: every attempt, filterable, with **notes** (click "+ note") and **Export CSV**. Status `unknown` means MT5 gave no clear answer; check Positions before trying again.
- **Unclear outcomes:** if MT5 or the backend doesn't answer clearly (lost connection, timeout), the order isn't retried. New orders carry a tag (`pd:xxxxxxxx`) in their MT5 comment, so the app looks for them and reports the order as placed when it finds it. Pressing confirm again in the same dialog never places a second order.
- **Toasts:** fills, rejections with the reason, pending fills, SL/TP closes, disconnects.

### Settings page

- All risk limits, saved in SQLite and enforced on the server.
- Saving shows every change; changes that **loosen** a limit are flagged in amber. Every change is written to the journal.
- **News events:** enter them in local time. New orders are blocked within ± the blackout window.

## Risk engine

Every order action passes `RiskEngine.evaluate` (`backend/risk.py`) before it reaches MT5. Blocked attempts are journaled with the reason.

| Rule | Default | Notes |
|---|---|---|
| Daily loss | 5% | Of the higher of balance or equity at the day reset (configurable basis) |
| Day reset | 00:00 server time | Any `HH:MM` and timezone (`server` or an IANA timezone name such as `Europe/Prague`). The trading day only moves forward, and a changed schedule starts at its next reset, so the day's anchor is never re-taken mid-day |
| Max drawdown | 10%, static | From **Initial balance**; if that's blank, from the account's first deposit in MT5 history. In live mode, new orders are blocked when neither is known (mock mode falls back to the first balance seen). `trailing` mode follows the equity high-water mark |
| Worst case | always on | Blocks an order if every open SL, every pending order filled then stopped, and this order's SL (plus commission) together would breach either limit |
| Risk per trade | 1% of balance | A stop loss is required. A per-order "no stop loss" override exists only when **Allow orders without a stop loss** is on in Settings (off by default), and such orders always show the confirmation, even in one-click mode |
| Exposure | 3 positions, 5 lots | Pending orders count towards both |
| Rate limit | 5 actions/min | Hard ceiling of 30/min |
| News blackout | ±2 min | Around events you enter |
| Commission | $0/lot | Round turn |

- **Never blocked:** closing, cancelling, adding a stop, or moving a stop closer. Blocking those could trap you in a losing position.
- **Locking:** one lock is held from the check through `order_send`, so two simultaneous orders can't both pass.
- **Restarts:** the day's starting balance and the high-water mark persist across restarts. If the app wasn't running at the reset, the day start is rebuilt from MT5 history: today's balance minus the trading P/L booked since the reset (deposits and withdrawals excluded), and the equity at the reset from the positions open then, priced from M1 bars. It's flagged in the UI (hover the `*`). If history can't be read, the account as first seen today is used and flagged.
- **One account:** the saved day start, high-water mark and observed balances belong to the MT5 account they were recorded on (a fingerprint of login@server, kept server-side). If the terminal switches to another account, they start afresh and new orders are blocked (**ACCOUNT CHANGED** in the header) until you check the limits in Settings and save. In live mode, new orders are also blocked while the terminal is logged into a different account from `MT5_LOGIN`.

## Tests

```bash
python -m pytest                    # backend: bridge, mock, risk engine, API, stream, trading
cd frontend && npm test             # Vitest: indicators, trading maths, drawings, drawing sync, chart lines
npm run typecheck
```

## API reference

Every path also works under the `/api` prefix (`/api/account` = `/account`), which is how the UI calls it. Interactive docs are at http://127.0.0.1:8000/docs.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Connection state, mock flag, retry countdown |
| GET | `/account` | Balance, equity, margin, profit, `account_mode` (demo/contest/real) |
| GET | `/symbols` | Symbol specs |
| GET | `/candles?symbol=&timeframe=&count=&before=` | M1…D1. `count` ≤ 5000. `before` pages back |
| GET | `/positions`, `/orders` | Open positions, pending orders |
| POST | `/orders` | Market, limit or stop order with SL/TP. Risk-checked and journaled. Optional `client_order_id`: sending the same id again returns the first result instead of placing a second order |
| PATCH / DELETE | `/orders/{ticket}` | Modify or cancel a pending order |
| PATCH / DELETE | `/positions/{ticket}[?volume=]` | Modify SL/TP; close fully or partially |
| POST | `/positions/flatten` | Close all positions and cancel all orders |
| GET | `/history?days=` | Deals |
| GET | `/journal?limit=&before_id=&status=` | Journal entries |
| PATCH | `/journal/{id}` | Set a note on an entry: `{"note": "..."}` |
| GET / PUT | `/drawings/{symbol}` | Drawings per symbol (PUT replaces the list) |
| GET / PUT | `/risk/settings` | Risk limits |
| GET | `/risk/status` | Daily loss and drawdown remaining |
| POST | `/risk/check` | Dry-run an order through the risk engine |
| GET / POST / DELETE | `/risk/news[/{id}]` | News events (UTC epoch) |
| WS | `/ws/stream` | Live stream; see below |

**Stream** (`/ws/stream`):
- The client sends `{"type":"subscribe","symbols":[…]}` and `{"type":"charts","charts":[{"symbol":…,"timeframe":…}, …]}` (one entry per open chart; the single-chart `{"type":"chart",…}` still works).
- The server pushes `status`, `account`, `risk`, `positions`, `orders`, `tick`, `candle` and `error`, and only what changed.
- One shared poller runs every 300 ms (`STREAM_INTERVAL_MS`).

**Errors:**

| Status | Meaning |
|---|---|
| 404 | Unknown symbol |
| 409 | Rejected by the broker (`kind: "broker"`, `retcode`) |
| 422 | Blocked by risk rules (`kind: "risk"`, `violations`) or invalid input |
| 502 | Other MT5 error |
| 503 | Terminal unavailable |
| 409 / 502 / 503 with `kind: "unknown"` | The request was sent but MT5 gave no clear answer (no reply, timeout). It may have been executed: check Positions and Orders. Never retried automatically, and journaled as `unknown` |

**Security:**
- The backend binds to 127.0.0.1.
- It only accepts requests addressed to localhost or 127.0.0.1, which blocks DNS-rebinding attacks.
- Browser requests and WebSocket connections are only accepted from the app's own pages.
- State-changing requests need the `X-Requested-With: trading-ui` header, so other websites can't trigger trades.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `The MetaTrader5 package only runs on Windows` | Set `MT5_MOCK=1` on the Mac, or run the backend on Windows |
| "Authorization failed" | Check `MT5_LOGIN`, `MT5_PASSWORD` and `MT5_SERVER` (exact server name) |
| "Could not start or find the MT5 terminal" | Install and start MT5; set `MT5_PATH` if several terminals are installed |
| Orders fail with "Algo Trading is disabled" (10027) | Turn on the **Algo Trading** button in the terminal |
| "Unknown symbol" | Your broker uses different names or suffixes. Search for them in the watchlist, and set `SERVER_TIME_SYMBOL` |
| Meters show `*` | The day start was recorded late, or the initial balance isn't set. Hover for which |
| Header says "MT5 disconnected · retry Ns" | The terminal closed or lost its connection. The app reconnects on its own with backoff |

## Mock mode details

- **Prices:** generated deterministically, so every timeframe agrees with every other and history goes back indefinitely.
- **Symbols:** EURUSD, GBPUSD, USDJPY, XAUUSD, US30, NAS100 and BTCUSD, with realistic specs.
- **Simulated:** fills, pending triggers, SL/TP hits, partial closes, margin, requotes, invalid stops and volume, no money, market closed, disconnects.
- **Not simulated:** swaps, commissions, stop-out and weekend gaps.
- **Resets:** the mock account resets when the backend restarts (`MOCK_INITIAL_BALANCE`), while SQLite data persists. Delete `backend/data/trading.db` for a completely fresh start.
