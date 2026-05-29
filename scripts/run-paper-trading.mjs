import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const statePath = resolve("public/state.json");

const chainByIndex = new Map([
  ["1", "ethereum"],
  ["56", "bsc"],
  ["196", "xlayer"],
  ["501", "solana"],
  ["8453", "base"],
]);

function timestamp() {
  return new Date().toISOString();
}

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function command(args) {
  return `onchainos ${args.join(" ")}`;
}

function onchainos(args) {
  try {
    const output = execFileSync("onchainos", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
    });
    const start = output.indexOf("{");
    return JSON.parse(start >= 0 ? output.slice(start) : output);
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : "";
    const stderr = error.stderr ? String(error.stderr) : "";
    const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n");
    throw new Error(`${command(args)} failed${detail ? `: ${detail}` : ""}`);
  }
}

function loadState() {
  if (!existsSync(statePath)) {
    return {
      version: 1,
      updatedAt: timestamp(),
      mode: "paper",
      initialCapital: 1000,
      cash: 1000,
      realizedPnl: 0,
      buyRounds: 0,
      maxBuyRounds: 10,
      scanParams: {
        chains: ["solana", "ethereum", "bsc", "base"],
        walletType: "1,3",
        minAmountUsd: 5000,
        minAddressCount: 2,
        minLiquidityUsd: 100000,
        limit: 20,
      },
      riskRules: {
        maxPositionPct: 0.25,
        stopLossPct: -10,
        takeProfitPct: 20,
        noLeverage: true,
        spotLongOnly: true,
      },
      positions: [],
      trades: [],
      scans: [],
    };
  }

  return JSON.parse(readFileSync(statePath, "utf8"));
}

function saveState(state) {
  mkdirSync(dirname(statePath), { recursive: true });
  state.updatedAt = timestamp();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function equity(state) {
  return state.cash + state.positions.reduce((sum, position) => sum + number(position.marketValue, position.cost), 0);
}

function markPosition(position) {
  const args = ["token", "price-info", "--address", position.contract, "--chain", position.chain];
  const response = onchainos(args);
  const data = Array.isArray(response.data) ? response.data[0] : null;
  if (!response.ok || !data) throw new Error(`No price-info for ${position.symbol}`);

  const price = number(data.price);
  const marketValue = position.quantity * price;
  const unrealizedPnl = marketValue - position.cost;
  const unrealizedPnlPct = position.cost > 0 ? (unrealizedPnl / position.cost) * 100 : 0;

  return {
    ...position,
    lastMark: price,
    marketValue,
    unrealizedPnl,
    unrealizedPnlPct,
    lastMarkSource: command(args),
    lastMarkSnapshot: data,
  };
}

function sell(state, position, reason) {
  const notional = position.marketValue;
  const realizedPnl = notional - position.cost;
  state.cash += notional;
  state.realizedPnl += realizedPnl;
  state.trades.push({
    id: state.trades.length + 1,
    round: position.round || null,
    time: timestamp(),
    side: "SELL",
    symbol: position.symbol,
    chain: position.chain,
    contract: position.contract,
    price: position.lastMark,
    quantity: position.quantity,
    notional,
    fees: 0,
    realizedPnl,
    reason,
    source: position.lastMarkSource,
  });
}

function scanSignals(state) {
  const params = state.scanParams;
  const supported = onchainos(["signal", "chains"]);
  const supportedChains = new Set((supported.data || []).map((item) => chainByIndex.get(item.chainIndex)).filter(Boolean));
  const scans = [];

  for (const chain of params.chains) {
    if (!supportedChains.has(chain)) {
      scans.push({ chain, skipped: true, reason: "unsupported-chain" });
      continue;
    }

    const args = [
      "signal",
      "list",
      "--chain",
      chain,
      "--wallet-type",
      params.walletType,
      "--min-amount-usd",
      String(params.minAmountUsd),
      "--min-address-count",
      String(params.minAddressCount),
      "--min-liquidity-usd",
      String(params.minLiquidityUsd),
      "--limit",
      String(params.limit),
    ];
    const response = onchainos(args);
    scans.push({
      chain,
      params,
      source: command(args),
      ok: response.ok,
      count: Array.isArray(response.data) ? response.data.length : 0,
      signals: Array.isArray(response.data) ? response.data : [],
    });
  }

  return scans;
}

function pickSignal(scans, state) {
  const held = new Set(state.positions.map((position) => position.contract.toLowerCase()));
  return scans
    .flatMap((scan) => scan.signals || [])
    .filter((signal) => signal.token?.tokenAddress)
    .filter((signal) => !held.has(signal.token.tokenAddress.toLowerCase()))
    .map((signal) => ({
      signal,
      score: number(signal.amountUsd) / 1000 + number(signal.triggerWalletCount) * 10 - number(signal.soldRatioPercent),
    }))
    .sort((a, b) => b.score - a.score)[0]?.signal;
}

function buy(state, signal) {
  if (!signal || state.buyRounds >= state.maxBuyRounds) return null;

  const chain = chainByIndex.get(signal.chainIndex) || "solana";
  const contract = signal.token.tokenAddress;
  const args = ["token", "price-info", "--address", contract, "--chain", chain];
  const response = onchainos(args);
  const data = Array.isArray(response.data) ? response.data[0] : null;
  if (!response.ok || !data) throw new Error(`No price-info for candidate ${signal.token.symbol}`);

  const price = number(data.price);
  const notional = Math.min(state.cash, equity(state) * state.riskRules.maxPositionPct);
  if (notional <= 0) return null;

  const quantity = notional / price;
  const round = state.buyRounds + 1;
  const position = {
    round,
    symbol: signal.token.symbol,
    name: signal.token.name,
    chain,
    chainIndex: signal.chainIndex,
    contract,
    quantity,
    avgEntry: price,
    cost: notional,
    lastMark: price,
    marketValue: notional,
    unrealizedPnl: 0,
    unrealizedPnlPct: 0,
    entrySignal: signal,
    entrySource: command(args),
    lastMarkSource: command(args),
    lastMarkSnapshot: data,
  };

  state.cash -= notional;
  state.buyRounds = round;
  state.positions.push(position);
  state.trades.push({
    id: state.trades.length + 1,
    round,
    time: timestamp(),
    side: "BUY",
    symbol: position.symbol,
    chain,
    contract,
    price,
    quantity,
    notional,
    fees: 0,
    realizedPnl: 0,
    source: command(args),
    signal,
  });

  return position;
}

function run() {
  const state = loadState();
  const scan = {
    time: timestamp(),
    status: "started",
    params: state.scanParams,
    actions: [],
    errors: [],
  };

  try {
    const open = [];
    for (const position of state.positions) {
      try {
        const marked = markPosition(position);
        if (marked.unrealizedPnlPct <= state.riskRules.stopLossPct) {
          sell(state, marked, "stop-loss");
          scan.actions.push({ type: "SELL", symbol: marked.symbol, reason: "stop-loss" });
        } else if (marked.unrealizedPnlPct >= state.riskRules.takeProfitPct) {
          sell(state, marked, "take-profit");
          scan.actions.push({ type: "SELL", symbol: marked.symbol, reason: "take-profit" });
        } else {
          open.push(marked);
        }
      } catch (error) {
        open.push(position);
        scan.errors.push({ stage: "mark", symbol: position.symbol, message: error.message });
      }
    }
    state.positions = open;

    if (state.buyRounds < state.maxBuyRounds) {
      const signalScans = scanSignals(state);
      scan.signalScans = signalScans;
      const bought = buy(state, pickSignal(signalScans, state));
      scan.actions.push(bought ? { type: "BUY", symbol: bought.symbol, round: bought.round } : { type: "NO_BUY", reason: "no-candidate" });
    } else {
      scan.actions.push({ type: "NO_BUY", reason: "max-buy-rounds-reached" });
    }

    scan.status = "ok";
  } catch (error) {
    scan.status = "error";
    scan.errors.push({ stage: "run", message: error.message });
  }

  state.scans = [scan, ...(state.scans || [])].slice(0, 100);
  saveState(state);
}

run();
