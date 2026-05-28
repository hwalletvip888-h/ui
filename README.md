# Agent Wallet Paper Trading

Static GitHub Pages dashboard for a 1000 USDT paper trading account.

- `public/index.html` renders the dashboard.
- `public/state.json` is the ledger and data source.
- `scripts/run-paper-trading.mjs` scans OKX OnchainOS signals and updates the ledger.
- `.github/workflows/paper-trading.yml` runs every 30 minutes and deploys GitHub Pages.

Rules:

- Spot-long simulation only.
- No real wallet transactions.
- Maximum 10 buy rounds.
- Default position size is at most 25% of equity.
- Stop loss: -10%.
- Take profit: +20%.
UI组件
