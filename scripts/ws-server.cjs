const { WebSocketServer } = require("ws");
const { randomUUID } = require("crypto");

// PaaS providers (Render/Railway/Fly/etc.) usually inject PORT.
// Keep WS_PORT for local/dev overrides.
const PORT = Number(process.env.PORT || process.env.WS_PORT || 8787);
const STARTING_CASH = 100000;
const MATCH_DURATION_MS = 10 * 60 * 1000;

const STOCKS = [
  { symbol: "RELIANCE", basePrice: 2942.1 },
  { symbol: "TCS", basePrice: 3812.45 },
  { symbol: "INFY", basePrice: 1532.0 },
  { symbol: "HDFCBANK", basePrice: 1442.15 },
  { symbol: "ICICIBANK", basePrice: 1012.3 },
  { symbol: "TATAMOTORS", basePrice: 942.0 },
  { symbol: "WIPRO", basePrice: 482.1 },
  { symbol: "SBIN", basePrice: 722.45 },
  { symbol: "ADANIENT", basePrice: 3122.9 },
  { symbol: "BHARTIARTL", basePrice: 1212.0 },
];

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function noise(symbol, t) {
  const a = hash(symbol + ":" + t) / 2 ** 32;
  return a - 0.5;
}

function priceAt(symbol, basePrice, ts) {
  const minute = Math.floor(ts / 1000);
  let drift = 0;
  for (let i = 0; i < 8; i++) {
    drift += Math.sin(minute / (8 + i * 3) + hash(symbol + i)) * (0.004 / (i + 1));
  }
  const jitter = noise(symbol, minute) * 0.003;
  const factor = 1 + drift + jitter;
  return +(basePrice * factor).toFixed(2);
}

function currentPrice(symbol) {
  const s = STOCKS.find((x) => x.symbol === symbol);
  if (!s) return 0;
  return priceAt(symbol, s.basePrice, Date.now());
}

function newPlayer(p) {
  return { ...p, cash: STARTING_CASH, holdings: [], trades: [] };
}

const matches = new Map();
const subscriptions = new Map();

function broadcast(code, match) {
  for (const [ws, codes] of subscriptions.entries()) {
    if (!codes.has(code) || ws.readyState !== 1) continue;
    ws.send(JSON.stringify({ type: "match_update", match }));
  }
}

function subscribe(ws, code) {
  if (!subscriptions.has(ws)) subscriptions.set(ws, new Set());
  subscriptions.get(ws).add(code);
}

function endMatch(match) {
  if (!match || match.status === "ended") return match;
  let winnerId;
  let bestVal = -Infinity;
  for (const p of Object.values(match.players)) {
    const val = portfolioValue(p);
    if (val > bestVal) {
      bestVal = val;
      winnerId = p.id;
    }
  }
  return { ...match, status: "ended", winnerId };
}

function portfolioValue(p) {
  let v = p.cash;
  for (const h of p.holdings) v += currentPrice(h.symbol) * h.qty;
  return v;
}

function ensureBot(match) {
  if (Object.keys(match.players).length >= 2) return match;
  const botId = "bot:" + match.code;
  if (match.players[botId]) return match;
  return {
    ...match,
    players: {
      ...match.players,
      [botId]: newPlayer({ id: botId, name: "MarketBot", avatar: "#7c3aed" }),
    },
  };
}

function tickBot(match) {
  if (!match || match.status !== "live") return match;
  const botId = "bot:" + match.code;
  const bot = match.players[botId];
  if (!bot) return match;
  if (Math.random() > 0.3) return match;
  const sym = STOCKS[Math.floor(Math.random() * STOCKS.length)].symbol;
  const price = currentPrice(sym);
  const willSell = bot.holdings.length > 0 && Math.random() < 0.4;
  if (willSell) {
    const h = bot.holdings[Math.floor(Math.random() * bot.holdings.length)];
    const q = Math.max(1, Math.floor(h.qty * (0.3 + Math.random() * 0.7)));
    return trade(match, botId, "SELL", h.symbol, q).match;
  }
  const maxQty = Math.floor((bot.cash * 0.2) / price);
  if (maxQty < 1) return match;
  const q = Math.max(1, Math.floor(maxQty * Math.random()));
  return trade(match, botId, "BUY", sym, q).match;
}

function trade(match, playerId, side, symbol, qty) {
  if (!match || match.status !== "live") return { error: "Match not live", match };
  const p = match.players[playerId];
  if (!p) return { error: "Player missing", match };
  if (qty <= 0) return { error: "Invalid quantity", match };
  const price = currentPrice(symbol);
  const cost = price * qty;
  let np;
  if (side === "BUY") {
    if (cost > p.cash) return { error: "Insufficient cash", match };
    const existing = p.holdings.find((h) => h.symbol === symbol);
    const newHoldings = existing
      ? p.holdings.map((h) =>
          h.symbol === symbol
            ? { ...h, qty: h.qty + qty, avgPrice: (h.avgPrice * h.qty + cost) / (h.qty + qty) }
            : h
        )
      : [...p.holdings, { symbol, qty, avgPrice: price }];
    np = { ...p, cash: p.cash - cost, holdings: newHoldings };
  } else {
    const existing = p.holdings.find((h) => h.symbol === symbol);
    if (!existing || existing.qty < qty) return { error: "Not enough holdings", match };
    const newHoldings = existing.qty === qty
      ? p.holdings.filter((h) => h.symbol !== symbol)
      : p.holdings.map((h) => (h.symbol === symbol ? { ...h, qty: h.qty - qty } : h));
    np = { ...p, cash: p.cash + cost, holdings: newHoldings };
  }
  const t = { id: randomUUID(), ts: Date.now(), side, symbol, qty, price };
  np = { ...np, trades: [t, ...np.trades] };
  const updated = {
    ...match,
    players: { ...match.players, [playerId]: np },
  };
  return { match: updated };
}

const wss = new WebSocketServer({ port: PORT });

wss.on("connection", (ws) => {
  subscriptions.set(ws, new Set());
  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    if (!msg || !msg.type) return;

    if (msg.code) subscribe(ws, msg.code);

    if (msg.type === "create_match") {
      if (matches.has(msg.code)) {
        ws.send(JSON.stringify({ type: "error", code: msg.code, message: "Code already exists" }));
        return;
      }
      const match = {
        code: msg.code,
        hostId: msg.host.id,
        status: "lobby",
        startedAt: null,
        durationMs: MATCH_DURATION_MS,
        players: { [msg.host.id]: newPlayer(msg.host) },
      };
      matches.set(msg.code, match);
      broadcast(msg.code, match);
      return;
    }

    if (msg.type === "join_match") {
      const match = matches.get(msg.code);
      if (!match) {
        ws.send(JSON.stringify({ type: "error", code: msg.code, message: "Room not found" }));
        return;
      }
      if (!match.players[msg.player.id] && Object.keys(match.players).length >= 2) {
        ws.send(JSON.stringify({ type: "error", code: msg.code, message: "Room full" }));
        return;
      }
      const updated = match.players[msg.player.id]
        ? match
        : { ...match, players: { ...match.players, [msg.player.id]: newPlayer(msg.player) } };
      matches.set(msg.code, updated);
      broadcast(msg.code, updated);
      return;
    }

    if (msg.type === "start_match") {
      const match = matches.get(msg.code);
      if (!match) return;
      const updated = { ...match, status: "live", startedAt: Date.now() };
      matches.set(msg.code, updated);
      broadcast(msg.code, updated);
      return;
    }

    if (msg.type === "end_match") {
      const match = matches.get(msg.code);
      if (!match) return;
      const updated = endMatch(match);
      matches.set(msg.code, updated);
      broadcast(msg.code, updated);
      return;
    }

    if (msg.type === "trade") {
      const match = matches.get(msg.code);
      if (!match) return;
      const result = trade(match, msg.playerId, msg.side, msg.symbol, msg.qty);
      if (result.error) {
        ws.send(JSON.stringify({ type: "error", code: msg.code, message: result.error }));
        return;
      }
      matches.set(msg.code, result.match);
      broadcast(msg.code, result.match);
      return;
    }

    if (msg.type === "ensure_bot") {
      const match = matches.get(msg.code);
      if (!match) return;
      const updated = ensureBot(match);
      matches.set(msg.code, updated);
      broadcast(msg.code, updated);
    }
  });

  ws.on("close", () => {
    subscriptions.delete(ws);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, match] of matches.entries()) {
    if (match.status === "live" && match.startedAt && now - match.startedAt >= match.durationMs) {
      const ended = endMatch(match);
      matches.set(code, ended);
      broadcast(code, ended);
    }
  }
}, 1000);

setInterval(() => {
  for (const [code, match] of matches.entries()) {
    if (match.status !== "live") continue;
    const updated = tickBot(match);
    if (updated !== match) {
      matches.set(code, updated);
      broadcast(code, updated);
    }
  }
}, 4000);

console.log(`[ws] match server running on ws://localhost:${PORT}`);
