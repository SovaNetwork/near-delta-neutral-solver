# NEAR Delta-Neutral Solver

A high-performance NEAR Intents solver implementing a delta-neutral hedging strategy using Hyperliquid perpetuals.

## Overview

This solver provides liquidity for **BTC ↔ USDT** swaps on NEAR Protocol's Intents system. It operates on a "wide spread, zero delta" philosophy:

1. **Quote**: Respond to quote requests from the Solver Bus with competitive pricing derived from Hyperliquid's orderbook
2. **Settle**: Receive spot BTC (or USDT) on NEAR when the user accepts the quote
3. **Hedge**: Immediately execute the inverse perpetual trade on Hyperliquid to neutralize price exposure

The solver maintains delta neutrality by holding offsetting positions: spot BTC on NEAR balanced by an equivalent short perpetual position on Hyperliquid (or vice versa for sells).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              NEAR Intents Solver                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │  Solver Bus  │◄──►│   app.ts     │◄──►│QuoterService │                   │
│  │  (WebSocket) │    │  (main loop) │    │ (pricing)    │                   │
│  └──────────────┘    └──────────────┘    └──────────────┘                   │
│                             │                   │                           │
│                             ▼                   ▼                           │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │HedgerService │◄───│  Inventory   │◄───│ Hyperliquid  │                   │
│  │ (settlement) │    │StateService  │    │   Service    │                   │
│  └──────────────┘    │(risk state)  │    │ (orderbook)  │                   │
│         │            └──────────────┘    └──────────────┘                   │
│         ▼                   ▲                   │                           │
│  ┌──────────────┐    ┌──────────────┐          │                           │
│  │ NearService  │    │ CronService  │──────────┘                           │
│  │  (balances)  │    │(bg refresh)  │                                       │
│  └──────────────┘    └──────────────┘                                       │
│                                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐                   │
│  │  ApiService  │    │LoggerService │    │  SpotPrice   │                   │
│  │ (dashboard)  │    │  (trades)    │    │  Service     │                   │
│  └──────────────┘    └──────────────┘    │(basis calc)  │                   │
│                                          └──────────────┘                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Core Services

### `app.ts` - Main Entry Point

The main event loop that:
- Connects to the Solver Bus via WebSocket with exponential backoff reconnection
- Subscribes to the `quote` stream to receive quote requests
- Processes incoming quote requests and publishes signed responses
- Tracks quote lifecycle timing for performance monitoring

**Quote Flow:**
1. Receive quote request from Solver Bus
2. Validate token pair (BTC/USDT only)
3. Calculate quote price using `QuoterService` (synchronous, ~1ms)
4. Sign the intent using NEP-413 standard
5. Publish quote response to relay
6. Track quote for settlement detection

### `QuoterService`

Calculates competitive quotes with **zero network I/O** in the hot path.

**Pricing Logic:**
- Uses real-time L2 orderbook data from Hyperliquid (streamed via WebSocket)
- Calculates volume-weighted average price (VWAP) for the requested size
- Applies spread to the reference price (static or dynamic)
- For buys: `finalPrice = referencePrice * (1 - spread)`
- For sells: `finalPrice = referencePrice * (1 + spread)`

**Static Spread Mode (default):**
- Uses `TARGET_SPREAD_BIPS` as a fixed spread for all quotes

**Dynamic Spread Mode** (enabled via `DYNAMIC_SPREAD_ENABLED=true`):
- Fetches BTC spot price from Coinbase/Binance every 10 seconds
- Calculates **basis** = `(perpPrice - spotPrice) / spotPrice`
- Adjusts spread based on basis direction to ensure consistent profitability:

| Direction | Hedge Action | Basis | Impact | Spread Adjustment |
|-----------|--------------|-------|--------|-------------------|
| Buy BTC | Short perp | Positive (perp > spot) | Favorable - we short at premium | Tighten spread |
| Buy BTC | Short perp | Negative (perp < spot) | Adverse - we short at discount | Widen spread |
| Sell BTC | Long perp | Positive (perp > spot) | Adverse - we buy at premium | Widen spread |
| Sell BTC | Long perp | Negative (perp < spot) | Favorable - we buy at discount | Tighten spread |

Formula: `effectiveSpread = BASE_SPREAD_BIPS ± basisBps` (clamped to `[BASE_SPREAD_BIPS, MAX_SPREAD_BIPS]`)

This ensures the solver maintains consistent profit margins regardless of the perp/spot basis, which can fluctuate 0-15 bps throughout the day.

**Gating Checks (all synchronous from cached RiskSnapshot):**
- Inventory direction (can we buy/sell BTC?)
- Position capacity (would this exceed max inventory?)
- Funding rate (reject buys if funding is too negative)
- Margin availability (halt if below threshold)

### `InventoryStateService`

Manages the centralized `RiskSnapshot` that enables zero-latency quoting.

**RiskSnapshot Contents:**
```typescript
interface RiskSnapshot {
    updatedAt: number;      // Timestamp of last refresh
    margin: number;         // Hyperliquid available margin (USDC)
    btcPos: number;         // Hyperliquid BTC perpetual position
    fundingRate: number;    // Current hourly funding rate
    btcBalance: number;     // NEAR intents BTC balance
    usdtBalance: number;    // NEAR intents USDT balance
}
```

**Key Methods:**
- `refreshRiskSnapshot()` - Fetches all state in parallel (called every 5s by CronService)
- `getQuoteDirection()` - Synchronous check: `BUY_BTC_ONLY | SELL_BTC_ONLY | BOTH | NONE`
- `checkPositionCapacity()` - Synchronous position limit validation
- `isSnapshotFresh()` - Guard: returns false if snapshot > 30s old (pauses quoting)

### `HyperliquidService`

Manages connection to Hyperliquid for orderbook data and hedge execution.

**Real-time Data (WebSocket):**
- Subscribes to L2 orderbook updates for BTC
- `getHedgePrice(side, size)` - VWAP calculation from live orderbook

**Hedge Execution:**
- `executeHedge(direction, size)` - Places IOC limit order with 5% slippage protection
- Invalidates position cache after execution

**Cached Data (HTTP, refreshed by RiskSnapshot):**
- Available margin
- Current BTC perpetual position
- Funding rate (60s cache, changes slowly)

### `HedgerService`

Detects settlements on NEAR and triggers hedge execution on Hyperliquid.

**Settlement Detection:**
- Polls NEAR contract every 5 seconds
- Checks if quote nonces have been consumed (via `is_nonce_used`)
- Processes nonce checks in batches of 3 to avoid RPC rate limits

**Quote Lifecycle:**
- `trackQuote(nonce, data)` - Register quote after successful publish
- Quotes expire after 5 minutes if not settled
- On settlement: execute hedge, log result, remove from tracking

### `CronService`

Background maintenance tasks:

1. **Risk Snapshot Refresh** (every 5s)
   - Updates `InventoryStateService.riskSnapshot`
   - Ensures quoting always has fresh risk state

2. **Drift Check** (every 10 minutes)
   - Compares spot BTC balance vs perpetual position
   - Alerts if `|netDelta| > DRIFT_THRESHOLD_BTC`
   - Logs position snapshots for auditing

### `NearService`

NEAR Protocol integration:

- Initializes connection with in-memory keystore
- Pre-loads keypair for fast signing (~0.1ms vs ~5ms cold)
- `getBalance(tokenId)` - Fetches intents contract balance (10s cache)
- `sign(message)` - Signs with Ed25519 keypair
- `wasNonceUsed(nonce)` - Checks if quote was settled

### `ApiService` & `LoggerService`

**REST API Endpoints:**
| Endpoint | Description |
|----------|-------------|
| `GET /health` | Uptime and health status |
| `GET /api/positions` | Current inventory, perp position, margin, net delta |
| `GET /api/pending-quotes` | Quotes awaiting settlement |
| `GET /api/trades` | Recent trade events |
| `GET /api/stats` | 24h statistics (volume, win rate, failures) |
| `GET /api/config` | Current strategy configuration |
| `GET /api/market` | Hyperliquid orderbook summary and funding |
| `GET /api/export/trades.csv` | Full trade history export |
| `GET /metrics` | Prometheus-compatible metrics |

**Structured Logging:**
- `logs/trades.jsonl` - Trade lifecycle events with timing data
- `logs/positions.jsonl` - Periodic position snapshots

## Performance Optimizations

### Zero Network I/O in Quote Path

The critical quote path is fully synchronous:

```
Quote Request → getQuote() → Return
                   │
                   ├── Read cached RiskSnapshot (memory)
                   ├── Read live orderbook (memory, WebSocket-fed)
                   └── Calculate VWAP + spread (CPU)
```

**Latency Breakdown (typical):**
- `quote`: 0.5-2ms (calculation only)
- `sign`: 0.1-0.5ms (Ed25519, pre-loaded key)
- `post`: 10-50ms (network RTT to relay)
- `total`: 15-60ms end-to-end

### Background State Refresh

All remote state is fetched in parallel every 5 seconds:
```typescript
const [margin, btcPos, fundingRate, btcBalance, usdtBalance] = await Promise.all([
    hlService.getAvailableMargin(),
    hlService.getBtcPosition(),
    hlService.getFundingRate(),
    nearService.getBalance(BTC_TOKEN_ID),
    nearService.getBalance(USDT_TOKEN_ID),
]);
```

### Stale Data Protection

If `RiskSnapshot` is older than 30 seconds, `getQuoteDirection()` returns `NONE`, halting all quotes until fresh data is available.

## Configuration

Create a `.env` file from `.env.example`:

```bash
cp .env.example .env
```

### Identity

| Variable | Description |
|----------|-------------|
| `SOLVER_PRIVATE_KEY` | NEAR Ed25519 private key for signing intents |
| `SOLVER_ID` | NEAR account ID (e.g., `mysolver.near`) |
| `HYPERLIQUID_PRIVATE_KEY` | Ethereum private key for Hyperliquid |
| `HYPERLIQUID_WALLET_ADDRESS` | Ethereum address for Hyperliquid |

### Connectivity

| Variable | Default | Description |
|----------|---------|-------------|
| `SOLVER_BUS_WS_URL` | `wss://solver-relay-v2.chaindefuser.com/ws` | Solver Bus WebSocket |
| `RELAY_AUTH_KEY` | - | Authorization key (if required) |
| `NEAR_RPC_URL` | `https://near.drpc.org` | NEAR RPC endpoint |
| `NEAR_NETWORK_ID` | `mainnet` | Network ID |
| `INTENTS_CONTRACT_ID` | `intents.near` | Intents contract address |
| `HYPERLIQUID_MAINNET` | `true` | Use mainnet (`false` for testnet) |

### Strategy

| Variable | Default | Description |
|----------|---------|-------------|
| `MAX_BTC_INVENTORY` | `5.0` | Maximum BTC to hold before stopping buys |
| `MIN_USDT_RESERVE` | `2000.0` | Minimum USDT to keep (stop buying if below) |
| `TARGET_SPREAD_BIPS` | `30` | Spread in basis points (used when dynamic spread is disabled) |
| `MIN_TRADE_SIZE_BTC` | `0.001` | Minimum quote size (Hyperliquid minimum) |
| `MAX_TRADE_SIZE_BTC` | `1.0` | Maximum quote size |

### Dynamic Spread (Basis-Adjusted)

Enable dynamic spread to automatically adjust pricing based on the perp/spot basis:

| Variable | Default | Description |
|----------|---------|-------------|
| `DYNAMIC_SPREAD_ENABLED` | `false` | Enable basis-adjusted dynamic spread |
| `BASE_SPREAD_BIPS` | `15` | Minimum spread (covers HL fees ~5 bps + profit margin) |
| `MAX_SPREAD_BIPS` | `50` | Maximum spread cap |
| `SPOT_PRICE_SOURCE` | `coinbase` | Primary spot price source (`coinbase` or `binance`) |
| `SPOT_PRICE_UPDATE_INTERVAL_MS` | `10000` | How often to fetch spot price (ms) |
| `SPOT_PRICE_FALLBACK` | `true` | Try alternate source if primary fails |

**Example Configuration:**
```bash
# Enable dynamic spread for consistent profitability
DYNAMIC_SPREAD_ENABLED=true
BASE_SPREAD_BIPS=15    # Covers ~5 bps HL fees + 10 bps profit
MAX_SPREAD_BIPS=50     # Cap spread during extreme basis
```

**How it works:**
- When basis is favorable (e.g., +10 bps when shorting), effective spread = 15 - 10 = 5 bps
- When basis is adverse (e.g., -5 bps when shorting), effective spread = 15 + 5 = 20 bps
- Spread never goes below `BASE_SPREAD_BIPS` (ensures minimum profit) or above `MAX_SPREAD_BIPS`

### Risk Management

| Variable | Default | Description |
|----------|---------|-------------|
| `MIN_MARGIN_THRESHOLD` | `1000.0` | Halt quoting if HL margin below this |
| `MIN_HOURLY_FUNDING_RATE` | `-0.0005` | Reject buys if funding worse than -0.05%/hr |
| `DRIFT_THRESHOLD_BTC` | `0.001` | Alert if spot/perp drift exceeds this |

### Assets

| Variable | Default | Description |
|----------|---------|-------------|
| `BTC_TOKEN_ID` | `base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near` | cbBTC on Base |
| `USDT_TOKEN_ID` | `eth-0xdac17f958d2ee523a2206206994597c13d831ec7.omft.near` | USDT on Ethereum |

**Supported BTC Variants:**
- cbBTC (Base): `base-0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf.omft.near`
- wBTC (Ethereum): `eth-0x2260fac5e5542a773aa44fbcfedf7c193bc2c599.omft.near`
- Native BTC: `btc.omft.near`

### Observability

| Variable | Default | Description |
|----------|---------|-------------|
| `API_PORT` | `3000` | API/Dashboard port (use `PORT` on Railway) |
| `LOGS_DIR` | `./logs` | Directory for trade/position logs |

## Installation & Usage

### Prerequisites

- Node.js 18+
- NEAR account with intents balance
- Hyperliquid account with USDC margin

### Install

```bash
npm install
```

### Build

```bash
npm run build
```

### Run

```bash
npm start
```

### Verify Operation

1. Check console for "Connected to Solver Bus" and "Risk snapshot initialized"
2. Open `http://localhost:3000/dashboard.html`
3. Monitor `logs/trades.jsonl` for quote activity

## Deployment

### Railway (Recommended)

1. Connect repository to Railway
2. Set build command: `npm run build`
3. Set start command: `npm start`
4. Add all environment variables
5. **Important**: Set region outside US (e.g., Tokyo, Europe)
6. Optional: Mount volume at `/data/logs` and set `LOGS_DIR=/data/logs`

### PM2 (VPS/EC2)

```bash
# Install PM2
npm install -g pm2

# Start
pm2 start ecosystem.config.js

# Monitor
pm2 monit

# Logs
pm2 logs near-delta-neutral-solver
```

## Monitoring

### Console Output

```
✅ [a1b2c3d4] PUBLISHED | BUY 0.001234 → 123.45 | 45ms
❌ [e5f6g7h8] REJECTED (solver lost) | SELL 0.005000 → 0.00004812 | 62ms (post: 48ms)
💰 [a1b2c3d4] SETTLED | executing hedge...
✅ [a1b2c3d4] HEDGED | short 0.001234 BTC
```

### Key Metrics

- **Win Rate**: `quotesPublished / (quotesPublished + quotesRejected)`
- **Net Delta**: Should be near zero (`spotBtc + perpPosition`)
- **Hedge Failures**: Should be zero (requires manual intervention)

### Alerts

- `[CRITICAL] HIGH INVENTORY DRIFT` - Spot/perp mismatch exceeds threshold
- `Risk snapshot stale` - Background refresh failing, quoting paused
- `HEDGE FAILED` - Manual rebalancing required

## Project Structure

```
src/
├── app.ts                      # Main entry point and WebSocket handler
├── configs/
│   ├── btc-only.config.ts      # Strategy configuration
│   └── near.config.ts          # NEAR network configuration
├── interfaces/
│   └── intents.interface.ts    # NEAR Intents message types
├── services/
│   ├── api.service.ts          # REST API and dashboard
│   ├── cron.service.ts         # Background tasks
│   ├── hedger.service.ts       # Settlement detection and hedging
│   ├── hyperliquid.service.ts  # Hyperliquid integration
│   ├── inventory-manager.service.ts  # Risk state management
│   ├── logger.service.ts       # Structured logging
│   ├── near.service.ts         # NEAR Protocol integration
│   ├── quoter.service.ts       # Quote calculation
│   └── spot-price.service.ts   # Spot price feed for basis calculation
└── utils/
    └── hashing.ts              # NEP-413 serialization and signing

public/
└── dashboard.html              # Web monitoring dashboard

logs/
├── trades.jsonl                # Trade lifecycle events
└── positions.jsonl             # Position snapshots
```

## License

ISC
