# NEAR Delta-Neutral Solver (BTC/USDT)

A professional NEAR Intents solver implementing a **Delta-Neutral Hedging Strategy** using **Hyperliquid**.

## 🚀 Overview

This solver provides liquidity for **BTC <> USDT** swaps on NEAR. It operates on a "high spread, zero delta" philosophy with a **stochastic inventory model**:

1.  **Quote**: Offers to Buy or Sell BTC based on current inventory and profitability.
    *   **Buy BTC**: Allowed if `Total BTC <> Max Cap` and `USDT > Min Reserve`.
    *   **Sell BTC**: Allowed if `Total BTC > Min Trade Size`.
2.  **Settle**: Receives Spot BTC (or USDT) on NEAR.
3.  **Hedge**: Immediately executes the inverse trade (Short or Long) on Hyperliquid to neutralize price exposure.

---

## 🏗 System Architecture

The solver is built with Node.js/TypeScript and consists of the following core services:

### Core Logic
*   **`HyperliquidService`**: Connects to Hyperliquid WebSocket for real-time L2 orderbook data and executes hedge orders.
*   **`QuoterService`**: Calculates quotes based on market depth, spread, and inventory constraints. Signs intents with the solver's private key.
*   **`HedgerService`**: Detects settlements on NEAR and triggers offsets on Hyperliquid. Tracks quote lifecycles to prevent double-hedging.
*   **`InventoryStateService`**: Manages inventory limits and directs quote logic based on current holdings.
*   **`CronService`**: Essential watchdog that monitors "Inventory Drift" (Spot vs Perp divergence) and alerts on issues.

### Observability Suite (New)
*   **`LoggerService`**: Centralized structured logging for all trade lifecycle events (`trades.jsonl`) and position snapshots (`positions.jsonl`).
*   **`ApiService`**: Express.js REST API providing real-time state, statistics, and metrics.
*   **Web Dashboard**: A real-time UI for visual monitoring of solver operations.

---

## 📊 Observability & Monitoring

The solver includes a comprehensive observability suite accessible via a web dashboard and API.

### 🖥️ Web Dashboard
**URL**: `http://localhost:3000/dashboard.html` (Default port)

Features:
*   **Real-time Positions**: Visualizes Spot BTC vs Perp Position and Net Delta.
*   **Health Status**: Indicators for API and Drift status.
*   **Recent Activity**: Live feed of Quotes Generated and Hedges Executed.
*   **One-Click Export**: Download trade history as CSV.

### 🔌 API Endpoints
The API runs on port `3000` by default.

| Method | Endpoint | Description |
| :--- | :--- | :--- |
| `GET` | `/health` | System health status (uptime). |
| `GET` | `/api/positions` | Current inventory, perp position, margin, and delta. |
| `GET` | `/api/pending-quotes` | List of quotes currently tracked for settlement. |
| `GET` | `/api/trades` | Recent trade events (quotes, hedges). |
| `GET` | `/api/stats` | 24-hour statistics (volume, success rate). |
| `GET` | `/api/export/trades.csv` | Download full trade history as CSV. |
| `GET` | `/metrics` | Prometheus-compatible metrics endpoint. |

### 📝 Logs
Structured logs are written to the `logs/` directory:
*   `logs/trades.jsonl`: Trade lifecycle events (`QUOTE_GENERATED`, `QUOTE_PUBLISHED`, `HEDGE_EXECUTED`, `HEDGE_FAILED`).
*   `logs/positions.jsonl`: Periodic snapshots of inventory and margin.

---

## 🛠 Configuration

Create a `.env` file in the root directory. See `.env.example` for a complete template.

### Key Environment Variables

**Identity**
*   `SOLVER_PRIVATE_KEY`: NEAR private key (ed25519) for signing intents.
*   `SOLVER_ID`: NEAR account ID.
*   `HYPERLIQUID_PRIVATE_KEY`: Ethereum-style private key for hedging.
*   `HYPERLIQUID_WALLET_ADDRESS`: Associated wallet address.

**Strategy Constraints**
*   `MAX_BTC_INVENTORY`: Maximum BTC to hold (e.g., `5.0`).
*   `MIN_TRADE_SIZE_BTC`: Minimum quote size (e.g., `0.0001`).
*   `MAX_TRADE_SIZE_BTC`: Maximum quote size (e.g., `1.0`).
*   `TARGET_SPREAD_BIPS`: Target spread in basis points (e.g., `200` = 2%).
*   `DRIFT_THRESHOLD_BTC`: Alert threshold for inventory drift (e.g., `0.001`).

**Network**
*   `API_PORT`: Port for the API and Dashboard (default `3000`).
*   `SOLVER_BUS_WS_URL`: WebSocket URL for the Solver Bus.

---

## 📦 Installation & Usage

### 1. Install Dependencies
```bash
npm install
```

### 2. Build the Project
```bash
npm run build
```

### 3. Start the Solver
```bash
npm start
```
*   This will start the Solver, API, and Web Dashboard.
*   Console logs will show "Connected to Solver Bus" and "Hyperliquid Connected".

### 4. Verify Operation
*   Open `http://localhost:3000/dashboard.html`.
*   Check `logs/trades.jsonl` to see generated quotes.

---

## 🚨 Operational Guide

### Monitoring for Issues
1.  **Hedge Failures**: Check the dashboard "Hedge Failures" count or grep logs for `HEDGE_FAILED`.
2.  **Inventory Drift**: The `CronService` checks drift every 10 minutes. Using the API `/api/positions`, ensure `Net Delta` is near zero.
3.  **Margin**: Monitor `Available Margin` on the dashboard. Ensure `MIN_MARGIN_THRESHOLD` in config is appropriate.

### Accounting & Reporting
To generate a monthly report of all trades:
```bash
curl "http://localhost:3000/api/export/trades.csv" > monthly_report.csv
```

### Emergency Shutdown
The solver handles `SIGINT` (Ctrl+C) and `SIGTERM` gracefully:
1.  Stops accepting new quotes.
2.  Closes WebSocket connections.
3.  Stops all internal timers.

---

## ☁️ Production Deployment (AWS EC2)

### Recommended Specs
*   **Instance**: `t3.micro` or `t3.small` (Ubuntu 22.04 LTS).
*   **Firewall**: Allow Inbound TCP 3000 (if exposing dashboard publicly, otherwise SSH tunnel).

### Setup using PM2
1.  Install PM2: `sudo npm install -g pm2`
2.  Start:
    ```bash
    pm2 start ecosystem.config.js
    ```
3.  Monitor:
    ```bash
    pm2 monit
    ```
4.  Logs:
    ```bash
    pm2 logs near-delta-neutral-solver
    ```
