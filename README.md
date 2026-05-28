# Agent Wallet Paper Trading

Static GitHub Pages dashboard for a 1000 USDT paper trading account.

- `public/index.html` renders the dashboard.
- `public/state.json` is the ledger and data source.
- `scripts/run-paper-trading.mjs` scans OKX OnchainOS signals and updates the ledger.
- `workflow-template/paper-trading.yml` is the GitHub Actions workflow template.

To enable automation, copy `workflow-template/paper-trading.yml` to:

```text
.github/workflows/paper-trading.yml
```

Then open the repository Settings, enable GitHub Pages with GitHub Actions, and run
the workflow once from the Actions tab.

Rules:

- Spot-long simulation only.
- No real wallet transactions.
- Maximum 10 buy rounds.
- Default position size is at most 25% of equity.
- Stop loss: -10%.
- Take profit: +20%.
UI组件
