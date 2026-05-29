import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

const statePath = resolve("public/state.json");
const hSignalBaseUrl = process.env.H_SIGNAL_API_BASE_URL || "";
const hSignalApiKey = process.env.H_SIGNAL_API_KEY || "";

const chainByIndex = new Map([
  ["1", "ethereum"],
  ["56", "bsc"],
  ["196", "xlayer"],
  ["501", "solana"],
  ["8453", "base"],
]);
const chainIndexByName = new Map(Array.from(chainByIndex, ([index, name]) => [name, index]));

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

function hSignalEnabled() {
  return Boolean(hSignalBaseUrl && hSignalApiKey);
}

function hSignalUrl(path) {
  return `${hSignalBaseUrl.replace(/\/+$/, "")}${path}`;
}

function hSignalPath(path, params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `${path}?${query}` : path;
}

function explainOnchainosError(detail) {
  if (detail.includes("Invalid Authority") || detail.includes("not logged in")) {
    return `${detail}\nGitHub Actions needs OKX_API_KEY, OKX_SECRET_KEY, and OKX_PASSPHRASE repository secrets, then the workflow will log in with onchainos wallet login before scanning.`;
  }

  return detail;
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
    const detail = explainOnchainosError([stderr.trim(), stdout.trim()].filter(Boolean).join("\n"));
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
      signalLedger: [],
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

function tokenKey(chainIndex, contract) {
  return `${chainIndex || ""}:${String(contract || "").toLowerCase()}`;
}

function signalToken(signal) {
  return signal?.token || {};
}

function signalContract(signal) {
  return signalToken(signal).tokenAddress || "";
}

function signalChain(signal) {
  return chainByIndex.get(signal.chainIndex) || signal.chain || "unknown";
}

function sameSignal(left, right) {
  return tokenKey(left?.chainIndex, signalContract(left)) === tokenKey(right?.chainIndex, signalContract(right));
}

function scanForSignal(scans, signal) {
  const key = tokenKey(signal.chainIndex, signalContract(signal));
  return scans.find((scan) => (scan.signals || []).some((item) => tokenKey(item.chainIndex, signalContract(item)) === key)) || null;
}

function compactStrategy(strategy) {
  const payload = strategy?.data || {};
  const evaluation = payload.evaluation || {};
  const tokenRisk = payload.tokenRisk || {};

  return {
    provider: strategy?.provider || null,
    mode: strategy?.mode || payload.mode || null,
    dataSource: payload.dataSource || tokenRisk.dataSource || null,
    decision: evaluation.decision || null,
    score: number(evaluation.score, null),
    confidence: number(evaluation.confidence, null),
    suggestedPositionPct: number(evaluation.suggestedPositionPct, null),
    reasons: Array.isArray(evaluation.reasons) ? evaluation.reasons.slice(0, 6) : [],
    factors: evaluation.factors || {},
    risk: tokenRisk
      ? {
          level: tokenRisk.level || null,
          score: number(tokenRisk.score, null),
          notes: Array.isArray(tokenRisk.notes) ? tokenRisk.notes.slice(0, 6) : [],
          metrics: tokenRisk.metrics || {},
          factors: tokenRisk.factors || {},
        }
      : null,
  };
}

function compactSignal(signal) {
  const token = signalToken(signal);
  return {
    amountUsd: number(signal.amountUsd, null),
    triggerWalletCount: number(signal.triggerWalletCount, null),
    soldRatioPercent: number(signal.soldRatioPercent, null),
    walletType: signal.walletType || null,
    signalPrice: number(signal.price, null),
    signalTimestamp: signal.timestamp || null,
    cursor: signal.cursor || null,
    token: {
      marketCapUsd: number(token.marketCapUsd, null),
      holders: number(token.holders, null),
      top10HolderPercent: number(token.top10HolderPercent, null),
      logo: token.logo || null,
    },
  };
}

function baselinePrice(signal, strategy, bought) {
  return (
    number(bought?.avgEntry, null) ??
    number(strategy?.data?.tokenRisk?.rawSnapshot?.priceInfo?.price, null) ??
    number(signal?.price, null)
  );
}

function signalAction(item, selected, bought) {
  if (item.error) return "ERROR";
  if (bought && sameSignal(item.signal, bought.entrySignal)) return "BUY_EXECUTED";
  if (selected?.signal && sameSignal(item.signal, selected.signal)) return item.decision === "BUY" ? "BUY_NOT_EXECUTED" : "WATCH_SELECTED";
  if (item.decision === "WATCH") return "WATCH_ONLY";
  return "SKIPPED";
}

function appendSignalLedger(state, scan, scans, strategyResult, bought) {
  const now = scan.time;
  const selected = strategyResult.selected;
  const entries = strategyResult.evaluations.map((item, index) => {
    const signal = item.signal;
    const token = signalToken(signal);
    const sourceScan = scanForSignal(scans, signal);
    const action = signalAction(item, selected, bought);
    const basePrice = baselinePrice(signal, item.strategy, action === "BUY_EXECUTED" ? bought : null);
    const contract = signalContract(signal);

    return {
      id: `${now}:${signal.chainIndex}:${contract}:${index}`,
      scanTime: now,
      roundAtScan: state.buyRounds,
      rank: index + 1,
      symbol: token.symbol || "UNKNOWN",
      name: token.name || "",
      chain: signalChain(signal),
      chainIndex: signal.chainIndex,
      contract,
      source: {
        signalProvider: scan.signalProvider || null,
        strategyProvider: scan.strategyProvider || null,
        dataSource: sourceScan?.dataSource || item.strategy?.data?.dataSource || null,
        provider: sourceScan?.provider || item.strategy?.meta?.provider || null,
      },
      scanParams: scan.params,
      signal: compactSignal(signal),
      strategy: compactStrategy(item.strategy),
      decision: item.decision,
      score: number(item.score, null),
      legacyScore: number(item.legacyScore, null),
      action,
      selected: selected?.signal ? sameSignal(signal, selected.signal) : false,
      execution: action === "BUY_EXECUTED" && bought
        ? {
            round: bought.round,
            price: bought.avgEntry,
            notional: bought.cost,
            quantity: bought.quantity,
          }
        : null,
      error: item.error || null,
      outcome: {
        baselinePrice: basePrice,
        latestPrice: basePrice,
        latestPriceAt: now,
        returnPct: 0,
        markSource: action === "BUY_EXECUTED" ? bought?.lastMarkSource || null : "entry-snapshot",
      },
    };
  });

  state.signalLedger = [...entries, ...(state.signalLedger || [])].slice(0, 300);
  scan.ledgerEntries = entries.length;
}

function refreshSignalLedgerOutcomes(state, scan, maxUniqueMarks = 16) {
  const ledger = state.signalLedger || [];
  const candidates = ledger.filter((entry) => entry.contract && entry.chain && entry.outcome?.baselinePrice).slice(0, 80);
  const priceCache = new Map();

  for (const entry of candidates) {
    const key = tokenKey(entry.chainIndex, entry.contract);
    if (priceCache.has(key)) continue;
    if (priceCache.size >= maxUniqueMarks) break;

    const args = ["token", "price-info", "--address", entry.contract, "--chain", entry.chain];
    try {
      const response = onchainos(args);
      const data = Array.isArray(response.data) ? response.data[0] : null;
      if (!response.ok || !data) throw new Error(`No price-info for ${entry.symbol}`);
      priceCache.set(key, {
        price: number(data.price, null),
        source: command(args),
        snapshot: data,
      });
    } catch (error) {
      scan.errors.push({ stage: "ledger-mark", symbol: entry.symbol, message: error.message });
    }
  }

  const now = timestamp();
  for (const entry of candidates) {
    const mark = priceCache.get(tokenKey(entry.chainIndex, entry.contract));
    if (!mark?.price) continue;
    const baseline = number(entry.outcome?.baselinePrice, null);
    entry.outcome.latestPrice = mark.price;
    entry.outcome.latestPriceAt = now;
    entry.outcome.returnPct = baseline ? ((mark.price - baseline) / baseline) * 100 : 0;
    entry.outcome.markSource = mark.source;
    entry.outcome.markSnapshot = mark.snapshot;
    entry.outcome.ageMinutes = Math.max(0, (new Date(now).getTime() - new Date(entry.scanTime).getTime()) / 60000);
  }

  scan.ledgerMarks = priceCache.size;
}

function scanSignalsViaOnchainos(state, onlyChain = null) {
  const params = state.scanParams;
  const supported = onchainos(["signal", "chains"]);
  const supportedChains = new Set((supported.data || []).map((item) => chainByIndex.get(item.chainIndex)).filter(Boolean));
  const scans = [];

  for (const chain of onlyChain ? [onlyChain] : params.chains) {
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
      dataSource: "onchainos-cli",
      ok: response.ok,
      count: Array.isArray(response.data) ? response.data.length : 0,
      signals: Array.isArray(response.data) ? response.data : [],
    });
  }

  return scans;
}

async function scanChainViaHSignal(chain, params) {
  const path = hSignalPath("/api/v1/onchain/signals/latest", {
    chain,
    walletType: params.walletType,
    minAmountUsd: params.minAmountUsd,
    minAddressCount: params.minAddressCount,
    minLiquidityUsd: params.minLiquidityUsd,
    limit: params.limit,
  });
  const response = await fetch(hSignalUrl(path), {
    headers: {
      "X-H-SIGNAL-KEY": hSignalApiKey,
    },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== "0") {
    throw new Error(`H-Signal signals failed (${response.status}): ${payload?.message || "invalid response"}`);
  }

  const signals = Array.isArray(payload.data?.items) ? payload.data.items : [];
  return {
    chain,
    chainIndex: chainIndexByName.get(chain) || payload.data?.requestParams?.chainIndex || null,
    params: payload.data?.requestParams || params,
    source: `H-Signal ${path}`,
    dataSource: payload.data?.dataSource || "h-signal-api",
    provider: payload.meta?.provider || "okx-signal-list",
    ok: true,
    count: signals.length,
    signals,
  };
}

async function scanSignals(state) {
  const params = state.scanParams;
  if (!hSignalEnabled()) return scanSignalsViaOnchainos(state);

  const scans = [];
  for (const chain of params.chains) {
    try {
      scans.push(await scanChainViaHSignal(chain, params));
    } catch (error) {
      try {
        const fallbackScans = scanSignalsViaOnchainos(state, chain);
        scans.push({
          ...(fallbackScans[0] || { chain, ok: false, count: 0, signals: [] }),
          hSignalError: error.message,
          fallback: "onchainos-cli",
        });
      } catch (fallbackError) {
        scans.push({
          chain,
          ok: false,
          count: 0,
          signals: [],
          dataSource: "h-signal-api",
          hSignalError: error.message,
          fallbackError: fallbackError.message,
        });
      }
    }
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

async function evaluateSignal(signal) {
  if (!hSignalEnabled()) {
    return {
      provider: "local-fallback",
      mode: "legacy-score",
      data: {
        evaluation: {
          strategyVersion: "legacy-local-score",
          decision: "BUY",
          score: number(signal.amountUsd) / 1000 + number(signal.triggerWalletCount) * 10 - number(signal.soldRatioPercent),
          suggestedPositionPct: 0.25,
          reasons: ["H-Signal is not configured; using the legacy local signal score."],
        },
      },
    };
  }

  const response = await fetch(hSignalUrl("/api/v1/onchain/strategies/evaluate"), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-H-SIGNAL-KEY": hSignalApiKey,
    },
    body: JSON.stringify({
      chainIndex: signal.chainIndex,
      tokenContractAddress: signal.token.tokenAddress,
      signal: {
        amountUsd: signal.amountUsd,
        triggerWalletCount: signal.triggerWalletCount,
        soldRatioPercent: signal.soldRatioPercent,
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== "0") {
    throw new Error(`H-Signal evaluate failed (${response.status}): ${payload?.message || "invalid response"}`);
  }

  return {
    provider: "h-signal-api",
    mode: payload.data?.mode || "unknown",
    data: payload.data,
    meta: payload.meta,
  };
}

async function pickSignalWithStrategy(scans, state) {
  const held = new Set(state.positions.map((position) => position.contract.toLowerCase()));
  const candidates = scans
    .flatMap((scan) => scan.signals || [])
    .filter((signal) => signal.token?.tokenAddress)
    .filter((signal) => !held.has(signal.token.tokenAddress.toLowerCase()))
    .map((signal) => ({
      signal,
      legacyScore: number(signal.amountUsd) / 1000 + number(signal.triggerWalletCount) * 10 - number(signal.soldRatioPercent),
    }))
    .sort((a, b) => b.legacyScore - a.legacyScore)
    .slice(0, 10);

  const evaluations = [];
  for (const candidate of candidates) {
    try {
      const strategy = await evaluateSignal(candidate.signal);
      const evaluation = strategy.data?.evaluation || {};
      evaluations.push({
        signal: candidate.signal,
        legacyScore: candidate.legacyScore,
        strategy,
        decision: evaluation.decision || "SKIP",
        score: number(evaluation.score, candidate.legacyScore),
      });
    } catch (error) {
      evaluations.push({
        signal: candidate.signal,
        legacyScore: candidate.legacyScore,
        error: error.message,
        decision: "SKIP",
        score: 0,
      });
    }
  }

  const selected =
    evaluations
      .filter((item) => item.decision === "BUY")
      .sort((a, b) => b.score - a.score)[0] ||
    evaluations
      .filter((item) => item.decision === "WATCH")
      .sort((a, b) => b.score - a.score)[0] ||
    null;

  return { selected, evaluations };
}

function buy(state, selected) {
  const signal = selected?.signal || selected;
  if (!signal || state.buyRounds >= state.maxBuyRounds) return null;

  const chain = chainByIndex.get(signal.chainIndex) || "solana";
  const contract = signal.token.tokenAddress;
  const args = ["token", "price-info", "--address", contract, "--chain", chain];
  const response = onchainos(args);
  const data = Array.isArray(response.data) ? response.data[0] : null;
  if (!response.ok || !data) throw new Error(`No price-info for candidate ${signal.token.symbol}`);

  const price = number(data.price);
  const suggestedPositionPct = number(selected?.strategy?.data?.evaluation?.suggestedPositionPct, state.riskRules.maxPositionPct);
  const positionPct = Math.min(state.riskRules.maxPositionPct, Math.max(0, suggestedPositionPct));
  const notional = Math.min(state.cash, equity(state) * positionPct);
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
    entryStrategy: selected?.strategy || null,
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
    strategy: selected?.strategy || null,
  });

  return position;
}

async function run() {
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
      const signalScans = await scanSignals(state);
      scan.signalScans = signalScans;
      scan.signalProvider = hSignalEnabled() ? "h-signal-api" : "onchainos-cli";
      const strategyResult = await pickSignalWithStrategy(signalScans, state);
      scan.strategyProvider = hSignalEnabled() ? "h-signal-api" : "local-fallback";
      scan.strategyEvaluations = strategyResult.evaluations.map((item) => ({
        symbol: item.signal.token?.symbol,
        chainIndex: item.signal.chainIndex,
        contract: item.signal.token?.tokenAddress,
        legacyScore: item.legacyScore,
        decision: item.decision,
        score: item.score,
        error: item.error || null,
        strategy: item.strategy || null,
      }));
      const bought = buy(state, strategyResult.selected);
      scan.actions.push(bought ? { type: "BUY", symbol: bought.symbol, round: bought.round } : { type: "NO_BUY", reason: "no-candidate" });
      appendSignalLedger(state, scan, signalScans, strategyResult, bought);
    } else {
      scan.actions.push({ type: "NO_BUY", reason: "max-buy-rounds-reached" });
    }

    refreshSignalLedgerOutcomes(state, scan);
    scan.status = "ok";
  } catch (error) {
    scan.status = "error";
    scan.errors.push({ stage: "run", message: error.message });
  }

  state.scans = [scan, ...(state.scans || [])].slice(0, 100);
  saveState(state);
}

run();
