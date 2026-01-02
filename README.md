# NEAR Delta-Neutral Solver (BTC/USDC)

A professional NEAR Intents solver implementing a **Delta-Neutral Hedging Strategy** using **Hyperliquid**.

## 🚀 Overview

This solver provides liquidity for **BTC <> USDC** swaps on NEAR. It operates on a "high spread, zero delta" philosophy:
1.  **Quote**: Offers to Buy BTC from users (Solver Buys Spot BTC) at a profitable spread.
2.  **Settle**: Receives Spot BTC on NEAR.
3.  **Hedge**: Immediately shorts BTC Perps on Hyperliquid to neutralize price exposure.
4.  **Unwind**: Once inventory is acquired, offers to Sell BTC back to users, closing the short position.

## 🏗 System Architecture

The solver is built with Node.js/TypeScript and consists of five core services:

### 1. `HyperliquidService`
*   **Role**: The "Brain" for market data and execution.
*   **Function**:
    *   Connects to Hyperliquid WebSocket for real-time L2 Orderbook.
    *   Executes `IOC` (Immediate-or-Cancel) orders to hedge positions.
    *   Monitors **Funding Rates** and **Available Margin**.

### 2. `QuoterService`
*   **Role**: The pricing engine.
*   **Function**:
    *   Calculates quotes based on Hyperliquid's weighted average depth + configured spread (default 2%).
    *   **Risk Guard**: Rejects quotes if the **Hourly Funding Rate** is too negative (preventing paying excessive funding on shorts).
    *   **Inventory Guard**: Rejects Buys if inventory cap is reached; rejects Sells if inventory is empty.

### 3. `HedgerService`
*   **Role**: The executioner.
*   **Function**:
    *   Polls the NEAR `intents.near` contract to detect confirmed settlements.
    *   Triggers the corresponding hedge on Hyperliquid (Short or Long) only after on-chain confirmation.

### 4. `InventoryStateService`
*   **Role**: The state machine.
*   **Function**:
    *   Determines if the solver is in `BUY_ONLY` (building inventory), `SELL_ONLY`, or `BOTH` modes.
    *   Supports an **Emergency Mode** to force Sell-Only behavior in critical failures.

### 5. `CronService`
*   **Role**: The watchdog.
*   **Function**:
    *   Runs hourly to check for **Inventory Drift**.
    *   Alerts if `|Spot BTC| != |Perp Short|` by more than a threshold (e.g., 0.001 BTC).

---

## 🛡 Risk Management Features

1.  **Funding Rate Checks**: Quotes are rejected if the Hyperliquid funding rate < `-0.05%` (hourly), protecting against expensive short positions.
2.  **Inventory Drift Monitor**: Periodic checks ensure the hedge remains perfect. Drift alerts require manual intervention or the auto-rebalancer (roadmap).
3.  **Margin Protection**: Quoting halts immediately if Hyperliquid margin falls below a safety threshold (`$1000`).
4.  **Slippage Protection**: Hedge orders use marketable limits with strict slippage bounds (5%) to prevent bad fills during volatility.

---

## 🛠 Configuration

Create a `.env` file in the root directory:

```bash
# --- Identity ---
SOLVER_ID=solver.near
SOLVER_PRIVATE_KEY=ed25519:...
HYPERLIQUID_WALLET_ADDRESS=0x...
HYPERLIQUID_PRIVATE_KEY=0x... # Ethereum-style private key

# --- Connectivity ---
SOLVER_BUS_WS_URL=wss://solver-relay-v2.chaindefuser.com/ws
NEAR_RPC_URL=https://rpc.mainnet.near.org
NEAR_NETWORK_ID=mainnet

# --- Hyperliquid ---
HYPERLIQUID_MAINNET=true

# --- Strategy Constraints ---
MAX_BTC_INVENTORY=5.0
MIN_USDC_RESERVE=2000
TARGET_SPREAD_BIPS=200  # 2.0%
MIN_HOURLY_FUNDING_RATE=-0.0005 # -0.05%
DRIFT_THRESHOLD_BTC=0.001
```

## 📦 Installation & Usage

1.  **Install Dependencies**:
    ```bash
    npm install
    ```

2.  **Build**:
    ```bash
    npm run build
    ```

3.  **Verify Hyperliquid Connection**:
    Runs a script to fetch the orderbook and current funding rate.
    ```bash
    npm run test-hl
    ```

4.  **Start the Solver**:
    ```bash
    npm start
    ```

---

## ☁️ Production Deployment (AWS EC2)

This workflow outlines the "Happy Path" for deploying the Delta-Neutral Solver to a fresh AWS EC2 instance (Ubuntu/Amazon Linux 2).

### 1. Provision EC2 Instance
- **OS**: Ubuntu 22.04 LTS (Recommended) or Amazon Linux 2023.
- **Type**: `t3.micro` or `t3.small` (Process is lightweight, mainly WebSocket wait times).
- **Security Group**: Allow outbound traffic. No inbound ports strictly required unless you want to expose metrics.

### 2. Connect & Setup Environment
SSH into your instance:
```bash
ssh -i key.pem ubuntu@<ec2-ip>
```

Install Dependencies (Node.js 18+ & Git):
```bash
# Ubuntu
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential

# Install PM2 globally
sudo npm install -g pm2 ts-node typescript
```

### 3. Clone & Configure
Clone the repository:
```bash
git clone <your-repo-url>
cd near-delta-neutral-solver
```

Create Production Environment Config:
```bash
nano .env
# Paste your production keys here
```

### 4. Build & Start
Install dependencies and build the TypeScript code:
```bash
npm install
npm run build
```

Start with PM2 (using the `ecosystem.config.js` included in this repo):
```bash
pm2 start ecosystem.config.js
```

### 5. Post-Deployment
Save the process list to resurrect on reboot:
```bash
pm2 save
pm2 startup
# Follow the command output to enable systemd
```

Monitor logs:
```bash
pm2 logs near-delta-neutral-solver
```
