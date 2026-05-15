import { create } from "zustand";
import { currentPrice } from "./stocks";

export const STARTING_CASH = 100000;
export const MATCH_DURATION_MS = 10 * 60 * 1000;

export type Trade = {
  id: string;
  ts: number;
  side: "BUY" | "SELL";
  symbol: string;
  qty: number;
  price: number;
};

export type Holding = { symbol: string; qty: number; avgPrice: number };

export type PlayerState = {
  id: string;
  name: string;
  avatar: string;
  cash: number;
  holdings: Holding[];
  trades: Trade[];
};

export type MatchStatus = "lobby" | "live" | "ended";

export type MatchState = {
  code: string;
  hostId: string;
  status: MatchStatus;
  startedAt: number | null;
  durationMs: number;
  players: Record<string, PlayerState>;
  // when ended
  winnerId?: string;
};

type Store = {
  matches: Record<string, MatchState>;
  current: string | null;
  pending: Record<string, boolean>;
  lastError: string | null;
  connect: () => void;
  setCurrent: (code: string | null) => void;
  createMatch: (host: { id: string; name: string; avatar: string }) => string;
  joinMatch: (code: string, player: { id: string; name: string; avatar: string }) => boolean;
  startMatch: (code: string) => void;
  endMatch: (code: string) => void;
  trade: (code: string, playerId: string, side: "BUY" | "SELL", symbol: string, qty: number) => string | null;
  ensureBot: (code: string) => void;
};

function newPlayer(p: { id: string; name: string; avatar: string }): PlayerState {
  return { ...p, cash: STARTING_CASH, holdings: [], trades: [] };
}

function genCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

export const useMatchStore = create<Store>((set, get) => ({
  matches: {},
  current: null,
  pending: {},
  lastError: null,
  connect: () => ensureSocket(set, get),
  setCurrent: (code) => set({ current: code }),
  createMatch: (host) => {
    ensureSocket(set, get);
    const code = genCode();
    sendMessage({ type: "create_match", code, host });
    set((s) => ({ current: code, pending: { ...s.pending, [code]: true } }));
    return code;
  },
  joinMatch: (code, player) => {
    ensureSocket(set, get);
    sendMessage({ type: "join_match", code, player });
    set((s) => ({ current: code, pending: { ...s.pending, [code]: true } }));
    return true;
  },
  startMatch: (code) => {
    ensureSocket(set, get);
    sendMessage({ type: "start_match", code });
  },
  endMatch: (code) => {
    ensureSocket(set, get);
    sendMessage({ type: "end_match", code });
  },
  trade: (code, playerId, side, symbol, qty) => {
    const m = get().matches[code];
    if (!m || m.status !== "live") return "Match not live";
    const p = m.players[playerId];
    if (!p) return "Player missing";
    if (qty <= 0) return "Invalid quantity";
    const price = currentPrice(symbol);
    const cost = price * qty;
    if (side === "BUY" && cost > p.cash) return "Insufficient cash";
    if (side === "SELL") {
      const existing = p.holdings.find((h) => h.symbol === symbol);
      if (!existing || existing.qty < qty) return "Not enough holdings";
    }
    ensureSocket(set, get);
    sendMessage({ type: "trade", code, playerId, side, symbol, qty });
    return null;
  },
  ensureBot: (code) => {
    ensureSocket(set, get);
    sendMessage({ type: "ensure_bot", code });
  },
}));

type WsMessage =
  | { type: "create_match"; code: string; host: { id: string; name: string; avatar: string } }
  | { type: "join_match"; code: string; player: { id: string; name: string; avatar: string } }
  | { type: "start_match"; code: string }
  | { type: "end_match"; code: string }
  | { type: "trade"; code: string; playerId: string; side: "BUY" | "SELL"; symbol: string; qty: number }
  | { type: "ensure_bot"; code: string };

type WsServerMessage =
  | { type: "match_update"; match: MatchState }
  | { type: "error"; code?: string; message: string };

let socket: WebSocket | null = null;
let outboundQueue: WsMessage[] = [];

function getWsUrl(): string | null {
  const env = (import.meta as unknown as { env?: Record<string, string> }).env?.VITE_WS_URL;
  if (env) return env;
  if (typeof window === "undefined") return null;
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  return `${protocol}://${window.location.hostname}:8787`;
}

function ensureSocket(
  set: (fn: (state: Store) => Partial<Store>) => void,
  get: () => Store
) {
  if (socket || typeof window === "undefined") return;
  const url = getWsUrl();
  if (!url) return;
  socket = new WebSocket(url);
  socket.onopen = () => {
    outboundQueue.forEach((msg) => socket?.send(JSON.stringify(msg)));
    outboundQueue = [];
  };
  socket.onmessage = (event) => {
    let msg: WsServerMessage | null = null;
    try {
      msg = JSON.parse(event.data as string) as WsServerMessage;
    } catch {
      return;
    }
    if (!msg) return;
    if (msg.type === "match_update") {
      set((s) => ({
        matches: { ...s.matches, [msg.match.code]: msg.match },
        pending: { ...s.pending, [msg.match.code]: false },
        lastError: null,
      }));
      return;
    }
    if (msg.type === "error") {
      set((s) => ({
        lastError: msg.message,
        pending: msg.code ? { ...s.pending, [msg.code]: false } : s.pending,
      }));
    }
  };
  socket.onclose = () => {
    socket = null;
    set((s) => ({ lastError: s.lastError ?? "Connection closed" }));
  };
}

function sendMessage(msg: WsMessage) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    outboundQueue.push(msg);
    return;
  }
  socket.send(JSON.stringify(msg));
}

export function portfolioValue(p: PlayerState): number {
  let v = p.cash;
  for (const h of p.holdings) v += currentPrice(h.symbol) * h.qty;
  return v;
}

export function pnl(p: PlayerState): number {
  return portfolioValue(p) - STARTING_CASH;
}
