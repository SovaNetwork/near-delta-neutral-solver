# NEAR Delta-Neutral Solver (BTC/USDT)

A professional NEAR Intents solver implementing a **Delta-Neutral Hedging Strategy** using **Hyperliquid**.

## 🚀 Overview

This solver provides liquidity for **BTC <> USDT** swaps on NEAR. It operates on a "high spread, zero delta" philosophy with a **stochastic inventory model**:
1.  **Quote**: Offers to Buy or Sell BTC based on current inventory and profitability.
    *   **Buy BTC**: Allowed if `Total BTC < Max Cap` and `USDT > Min Reserve`.
    *   **Sell BTC**: Allowed if `Total BTC > Min Trade Size`.
    *   **Both**: Often provides two-way quotes to capture spread in both directions.
2.  **Settle**: Receives Spot BTC (or USDT) on NEAR.
3.  **Hedge**: Immediately executes the inverse trade (Short or Long) on Hyperliquid to neutralize price exposure.

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
    *   Calculates quotes based on Hyperliquid's weighted average depth + configured spread.
    *   **Risk Guard**: Rejects quotes if the **Hourly Funding Rate** is too negative (preventing expensive shorts).
    *   **Inventory Guard**: Ensures sufficient balances before quoting.

### 3. `HedgerService`
*   **Role**: The executioner.
*   **Function**:
    *   Polls the NEAR `intents.near` contract to detect confirmed settlements.
    *   Triggers the corresponding hedge on Hyperliquid.

### 4. `InventoryStateService`
*   **Role**: The state manager.
*   **Function**:
    *   Manages "Flexible Flow" logic, allowing random buy/sell patterns as long as inventory constraints are met.
    *   Supports an **Emergency Mode** to force Sell-Only behavior in critical failures.

### 5. `CronService`
*   **Role**: The watchdog.
*   **Function**:
    *   Runs hourly to check for **Inventory Drift**.
    *   Alerts if `|Spot BTC| != |Perp Short|` by more than a threshold.

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
# Base Asset: USDT (usdt.tether-token.near)
MAX_BTC_INVENTORY=5.0
MIN_USDT_RESERVE=2000
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
