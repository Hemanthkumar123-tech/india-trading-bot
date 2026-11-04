// India Trading Assistant (Node.js 20+, zero packages)
// Run:  npm start
//
// What it does:
//  1. Scans NSE stocks + Nifty + India VIX (free Yahoo data, slightly delayed)
//  2. Detects market regime (BULLISH / NEUTRAL / BEARISH) and alerts on Telegram
//  3. Ranks stocks, sends "Buy" button messages (one-click invest) or auto-trades
//  4. Protects money: stop-loss, daily loss limit, max positions, no buying in bearish market
//  5. Live dashboard at http://localhost:3000 (password protected)
//  6. PAPER (virtual money) only. Live broker is intentionally disabled until you test for months.
//
// NOT financial advice. "Outlook" is an estimate from indicators, not a prediction.

const fs = require("fs");
const http = require("http");
const crypto = require("crypto");

// ---------- CONFIG ----------
const E = process.env;
const TG_TOKEN = E.TELEGRAM_TOKEN;
const CHAT_ID = String(E.TELEGRAM_CHAT_ID || "");
const DASH_USER = E.DASH_USER || "admin";
const DASH_PASS = E.DASH_PASS;
const DASH_PORT = Number(E.DASH_PORT || 3000);
const DASH_HOST = E.DASH_PUBLIC === "1" ? "0.0.0.0" : "127.0.0.1";

const CFG = {
  startingCash: 100000,       // virtual rupees for paper trading
  watchlist: ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "SBIN", "BHARTIARTL", "ITC", "LT", "HINDUNILVR", "KOTAKBANK", "AXISBANK", "MARUTI", "SUNPHARMA", "BAJFINANCE", "TITAN", "NTPC", "ASIANPAINT", "ULTRACEMCO", "WIPRO", "HCLTECH", "POWERGRID", "ONGC", "COALINDIA", "TATASTEEL", "JSWSTEEL", "ADANIENT", "ADANIPORTS", "NESTLEIND", "TECHM", "BAJAJFINSV", "GRASIM", "CIPLA", "DRREDDY", "EICHERMOT", "HEROMOTOCO", "BRITANNIA", "INDUSINDBK", "APOLLOHOSP", "HDFCLIFE", "SBILIFE", "TATACONSUM", "BPCL", "DIVISLAB", "HINDALCO", "SHRIRAMFIN", "TRENT", "BEL"],
  perTradePct: 0.05,          // 5% of equity per stock
  maxPositions: 5,
  stopLossPct: 0.05,          // auto-sell at -5%
  dailyLossLimitPct: 0.03,    // stop for the day at -3% equity
  scanEveryMin: 30,
  vixHigh: 22,                // fear level
  vixLow: 15,                 // calm level
  autoSafe: true,             // bearish market -> sell stocks, park money in safe liquid ETF
  liveCapital: Number(E.LIVE_CAPITAL || 5000),          // total rupees the bot may use when LIVE
  liveMaxPerTrade: Number(E.LIVE_MAX_PER_TRADE || 3000), // hard cap per single order
  livePerTradePct: 0.3,                                  // bigger slices because capital is small
  safeAsset: "LIQUIDBEES",    // Nippon India Liquid ETF (stays inside your demat account)
};

const STATE_FILE = "state.json";
let S = {
  cash: CFG.startingCash, positions: {}, trades: [],
  mode: "approve",            // "approve" (button click) or "auto"
  paused: false, regime: "UNKNOWN", dayKey: "", dayStartEquity: CFG.startingCash,
};
try { S = { ...S, ...JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) }; } catch {}
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(S, null, 2));

let LAST = { time: null, nifty: null, vix: null, regimeNote: "", stocks: [] };
const log = (...a) => console.log(new Date().toISOString(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rs = (n) => "₹" + Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 });

// ---------- TIME (IST) ----------
function istNow() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata", weekday: "short", hour: "2-digit", minute: "2-digit",
    year: "numeric", month: "2-digit", day: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const g = (t) => p.find((x) => x.type === t).value;
  return { wd: g("weekday"), mins: Number(g("hour")) * 60 + Number(g("minute")), day: `${g("year")}-${g("month")}-${g("day")}` };
}
function marketOpen() {
  const t = istNow();
  return !["Sat", "Sun"].includes(t.wd) && t.mins >= 9 * 60 + 15 && t.mins <= 15 * 60 + 30;
}

// ---------- DATA ----------
async function candles(ySymbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ySymbol)}?range=1y&interval=1d`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`${ySymbol} HTTP ${r.status}`);
  const res = (await r.json()).chart.result[0];
  const q = res.indicators.quote[0];
  const close = [], vol = [], ohlc = [];
  q.close.forEach((c, i) => {
    if (c != null) { close.push(c); vol.push(q.volume[i] || 0); ohlc.push([q.open[i], q.high[i], q.low[i], c].map((v) => Math.round((v || c) * 10) / 10)); }
  });
  return { close, vol, ohlc };
}

// Yahoo intraday quote: unlike the 1-year daily candles used for indicators, this
// endpoint supplies the latest intraday bar and its real exchange timestamp.
async function yahooQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1m`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`${symbol} quote HTTP ${r.status}`);
  const result = (await r.json()).chart?.result?.[0];
  if (!result) throw new Error(`${symbol} quote unavailable`);
  const q = result.indicators?.quote?.[0];
  const ts = result.timestamp || [];
  for (let i = ts.length - 1; i >= 0; i--) {
    const price = q?.close?.[i];
    if (price != null && Number.isFinite(price)) return { price, time: ts[i] * 1000 };
  }
  throw new Error(`${symbol} has no intraday price`);
}

// ---------- INDICATORS ----------
const sma = (a, n) => a.slice(-n).reduce((x, y) => x + y, 0) / Math.min(n, a.length);
function rsi(a, n = 14) {
  let g = 0, l = 0;
  for (let i = a.length - n; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    d >= 0 ? (g += d) : (l -= d);
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

// ---------- FREE NEWS (Google News RSS, no key needed) ----------
const POS = ["surge", "rally", "gain", "profit", "beats", "upgrade", "record", "growth", "wins", "strong", "order"];
const NEG = ["fall", "crash", "loss", "downgrade", "probe", "fraud", "penalty", "misses", "weak", "slump", "ban", "raid", "default", "cuts"];
async function newsScore(sym) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(sym + " share")}+when:2d&hl=en-IN&gl=IN&ceid=IN:en`;
    const xml = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
    const titles = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>/g)].map((m) => m[1].toLowerCase()).slice(0, 8);
    let n = 0;
    for (const t of titles) {
      n += POS.filter((w) => t.includes(w)).length ? 1 : 0;
      n -= NEG.filter((w) => t.includes(w)).length ? 1 : 0;
    }
    return { n, count: titles.length };
  } catch { return null; }
}

const FEEDS = [
  "https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms",
  "https://www.moneycontrol.com/rss/marketreports.xml",
  "https://www.livemint.com/rss/markets",
];
async function marketNews() {
  const heads = []; let n = 0;
  for (const u of FEEDS) {
    try {
      const xml = await (await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
      const t = [...xml.matchAll(/<item>[\s\S]*?<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/g)].map((m) => m[1].trim()).slice(0, 5);
      for (const h of t) { const l = h.toLowerCase(); n += POS.some((w) => l.includes(w)) ? 1 : 0; n -= NEG.some((w) => l.includes(w)) ? 1 : 0; }
      heads.push(...t.slice(0, 1));
    } catch {}
  }
  return { n, heads };
}

// ---------- ANALYSIS ----------
async function analyseMarket() {
  const nifty = await candles("^NSEI");
  const price = nifty.close.at(-1);
  const s50 = sma(nifty.close, 50), s200 = sma(nifty.close, 200);
  let vix = null;
  try { vix = (await candles("^INDIAVIX")).close.at(-1); } catch {}
  let score = (price > s50 ? 1 : -1) + (price > s200 ? 1 : -1);
  if (vix != null) score += vix > CFG.vixHigh ? -1 : vix < CFG.vixLow ? 1 : 0;
  const regime = score >= 2 ? "BULLISH" : score <= -1 ? "BEARISH" : "NEUTRAL";
  const note = `Nifty ${price.toFixed(0)} | 50DMA ${s50.toFixed(0)} | 200DMA ${s200.toFixed(0)}` +
    (vix != null ? ` | VIX ${vix.toFixed(1)}` : "");
  return { regime, price, vix, note, nc: nifty.ohlc.slice(-60), pc: nifty.close.at(-2) };
}

async function analyseStock(sym) {
  const { close, vol, ohlc } = await candles(sym + ".NS");
  if (close.length < 60) throw new Error("not enough data");
  const price = close.at(-1);
  const s20 = sma(close, 20), s50 = sma(close, 50);
  const r = rsi(close);
  const mom = (price / close.at(-22) - 1) * 100;
  const volUp = sma(vol, 5) > sma(vol, 30);
  let score = 0;
  if (s20 > s50) score += 2;
  if (price > s20) score += 1;
  if (mom > 0) score += 1;
  if (r >= 45 && r <= 70) score += 1;
  if (r > 75) score -= 1;           // overheated
  if (volUp && mom > 0) score += 1; // rising volume confirms move
  const outlook = score >= 5 ? "Likely UP" : score >= 3 ? "Sideways/Mild up" : "Likely DOWN/Weak";
  return { sym, price, s20, s50, rsi: r, mom, score, outlook, c: ohlc.slice(-60), pc: close.at(-2), tv: price * (vol.at(-1) || 0) };
}

// ---------- ANGEL ONE (LIVE) ----------
// Real orders only happen when S.live is true (dashboard "Go Live" + LIVE_ENABLED=1 in .env).
const AO = { base: "https://apiconnect.angelone.in", jwt: null, exp: 0 };
let TOK = {}; try { TOK = JSON.parse(fs.readFileSync("tokens.json", "utf8")); } catch {}
const tradePct = () => (S.live ? CFG.livePerTradePct : CFG.perTradePct);

function aoHeaders(auth) {
  return {
    "Content-Type": "application/json", Accept: "application/json", "X-UserType": "USER", "X-SourceID": "WEB",
    "X-ClientLocalIP": E.ANGEL_LOCAL_IP || "127.0.0.1", "X-ClientPublicIP": E.ANGEL_PUBLIC_IP || "127.0.0.1",
    "X-MACAddress": E.ANGEL_MAC || "00:00:00:00:00:00", "X-PrivateKey": E.ANGEL_API_KEY,
    ...(auth ? { Authorization: "Bearer " + AO.jwt } : {}),
  };
}
function totp(secret) {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/ /g, "").replace(/=+$/, "").toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac("sha1", key).update(buf).digest();
  return String((h.readUInt32BE(h[19] & 15) & 0x7fffffff) % 1e6).padStart(6, "0");
}
async function aoLogin() {
  if (!E.ANGEL_CLIENT_ID || !E.ANGEL_PIN || !E.ANGEL_TOTP_SECRET || !E.ANGEL_API_KEY) throw new Error("Angel One keys missing in .env");
  const r = await fetch(AO.base + "/rest/auth/angelbroking/user/v1/loginByPassword", {
    method: "POST", headers: aoHeaders(false),
    body: JSON.stringify({ clientcode: E.ANGEL_CLIENT_ID, password: E.ANGEL_PIN, totp: totp(E.ANGEL_TOTP_SECRET) }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.status || !j.data?.jwtToken) throw new Error(j.message || "login failed HTTP " + r.status);
  AO.jwt = j.data.jwtToken; AO.exp = Date.now() + 5 * 3600e3;
}
async function aoToken(sym) {
  if (TOK[sym]) return TOK[sym];
  const all = await (await fetch("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json")).json();
  const need = [...CFG.watchlist, CFG.safeAsset];
  for (const x of all) {
    if (x.exch_seg === "NSE" && x.symbol.endsWith("-EQ") && need.includes(x.symbol.slice(0, -3))) TOK[x.symbol.slice(0, -3)] = x.token;
  }
  fs.writeFileSync("tokens.json", JSON.stringify(TOK));
  return TOK[sym];
}
async function liveOrder(side, sym, qty) {
  try {
    if (E.LIVE_ENABLED !== "1") return { ok: false, msg: "LIVE_ENABLED is not 1" };
    if (!AO.jwt || Date.now() > AO.exp) await aoLogin();
    const token = await aoToken(sym);
    if (!token) return { ok: false, msg: "symbol token not found for " + sym };
    const r = await fetch(AO.base + "/rest/secure/angelbroking/order/v1/placeOrder", {
      method: "POST", headers: aoHeaders(true),
      body: JSON.stringify({ variety: "NORMAL", tradingsymbol: sym + "-EQ", symboltoken: token, transactiontype: side,
        exchange: "NSE", ordertype: "MARKET", producttype: "DELIVERY", duration: "DAY", price: "0",
        squareoff: "0", stoploss: "0", quantity: String(qty) }),
    });
    const txt = await r.text(); let j = {}; try { j = JSON.parse(txt); } catch {}
    if (j.status && j.data?.orderid) return { ok: true, id: j.data.orderid };
    return { ok: false, msg: j.message || `HTTP ${r.status} ${txt.slice(0, 100)}` };
  } catch (e) { return { ok: false, msg: e.message }; }
}
function goLive() {
  if (S.live) return;
  S.paperBackup = { cash: S.cash, positions: S.positions, trades: S.trades, history: S.history || [], dayStartEquity: S.dayStartEquity };
  Object.assign(S, { live: true, cash: CFG.liveCapital, positions: {}, trades: [], history: [], dayStartEquity: CFG.liveCapital, mode: "approve" });
  save();
}
function goPaper() {
  if (!S.live || !S.paperBackup) { S.live = false; return save(); }
  Object.assign(S, S.paperBackup, { live: false }); delete S.paperBackup; save();
}

// ---------- STRONG DATA: Angel One live quotes (one request = up to 50 prices) ----------
let OPT = null;
async function aoOptionTokens() {
  if (OPT && OPT.day === istNow().day) return OPT;
  const all = await (await fetch("https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json")).json();
  const mon = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const items = all.filter((x) => x.exch_seg === "NFO" && x.name === "NIFTY" && x.instrumenttype === "OPTIDX").map((x) => {
    const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(x.expiry || "");
    return m ? { t: Date.UTC(+m[3], mon[m[2]], +m[1]), label: x.expiry, strike: Number(x.strike) / 100, type: x.symbol.endsWith("CE") ? "CE" : "PE", token: x.token } : null;
  }).filter(Boolean);
  const next = items.filter((x) => x.t >= Date.now() - 86400000).sort((a, b) => a.t - b.t)[0];
  OPT = { day: istNow().day, items: next ? items.filter((x) => x.label === next.label) : [] };
  return OPT;
}
async function aoQuotes() {
  if (!AO.jwt || Date.now() > AO.exp) await aoLogin();
  const syms = CFG.watchlist;
  if (syms.some((x) => !TOK[x])) await aoToken(syms.find((x) => !TOK[x]));
  const body = { mode: "LTP", exchangeTokens: { NSE: syms.map((x) => TOK[x]).filter(Boolean) } };
  const atm = LAST.nifty ? Math.round(LAST.nifty / 50) * 50 : null, tk = {};
  let label = null;
  if (atm) {
    try { const o = await aoOptionTokens(); for (const x of o.items) if (x.strike === atm) { tk[x.type] = x.token; label = x.label; } } catch {}
    if (tk.CE || tk.PE) body.exchangeTokens.NFO = Object.values(tk);
  }
  const r = await fetch(AO.base + "/rest/secure/angelbroking/market/v1/quote/", { method: "POST", headers: aoHeaders(true), body: JSON.stringify(body) });
  const j = await r.json();
  const got = j.data?.fetched;
  if (!j.status || !got?.length) throw new Error(j.message || "no quotes");
  const rev = Object.fromEntries(Object.entries(TOK).map(([k, v]) => [v, k]));
  LAST.px = LAST.px || {}; LAST.mism = 0;
  for (const q of got) {
    const sym = q.exchange === "NSE" ? rev[q.symbolToken] : null;
    if (!sym) continue;
    const ref = LAST.stocks.find((x) => x.sym === sym)?.price;
    if (ref && Math.abs(q.ltp / ref - 1) > 0.05) LAST.mism++; // broker vs scan price disagree a lot: warn
    LAST.px[sym] = q.ltp;
  }
  const ltp = (t) => got.find((q) => q.exchange === "NFO" && q.symbolToken === t)?.ltp;
  LAST.opt = { strike: atm, exp: label, ce: tk.CE ? ltp(tk.CE) : undefined, pe: tk.PE ? ltp(tk.PE) : undefined };
  LAST.pxAt = Date.now();
  return true;
}

// ---------- PORTFOLIO ----------
function equity() {
  let v = S.cash;
  for (const [s, p] of Object.entries(S.positions)) {
    const px = LAST.px?.[s] ?? (s === CFG.safeAsset ? LAST.safe : LAST.stocks.find((x) => x.sym === s)?.price) ?? p.avg;
    v += p.qty * px;
  }
  return v;
}

function buy(sym, qty, price, why) {
  const cost = qty * price;
  if (qty < 1 || cost > S.cash) return false;
  if (S.live && sym !== CFG.safeAsset && cost > CFG.liveMaxPerTrade) { say(`Blocked: ${rs(cost)} exceeds live per-trade cap ${rs(CFG.liveMaxPerTrade)}.`); return false; }
  const prev = S.positions[sym] ? { ...S.positions[sym] } : null;
  S.cash -= cost;
  const p = S.positions[sym] || { qty: 0, avg: 0 };
  p.avg = (p.avg * p.qty + cost) / (p.qty + qty);
  p.qty += qty;
  S.positions[sym] = p;
  S.trades.push({ t: new Date().toISOString(), side: "BUY", sym, qty, price, why });
  save();
  if (S.live) liveOrder("BUY", sym, qty).then((r) => {
    if (r.ok) return say(`🔴 LIVE BUY placed: ${qty} ${sym}, order ${r.id}. Confirm the fill in the Angel One app.`);
    S.cash += cost; prev ? (S.positions[sym] = prev) : delete S.positions[sym]; S.trades.pop(); save();
    say(`❌ LIVE BUY FAILED ${sym}: ${r.msg}. Ledger reverted. Nothing was bought.`);
  });
  return true;
}
function sell(sym, price, why) {
  const p = S.positions[sym];
  if (!p) return false;
  S.cash += p.qty * price;
  S.trades.push({ t: new Date().toISOString(), side: "SELL", sym, qty: p.qty, price, why, pnl: (price - p.avg) * p.qty });
  delete S.positions[sym];
  save();
  if (S.live) liveOrder("SELL", sym, p.qty).then((r) => {
    if (r.ok) return say(`🔴 LIVE SELL placed: ${p.qty} ${sym}, order ${r.id}. Confirm the fill in the Angel One app.`);
    S.cash -= p.qty * price; S.positions[sym] = p; S.trades.pop(); save();
    say(`❌ LIVE SELL FAILED ${sym}: ${r.msg}. Position kept in ledger. CHECK ANGEL ONE APP.`);
  });
  return true;
}

// ---------- TELEGRAM ----------
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return r.json();
}
const say = (text, buttons) => {
  S.alerts = [...(S.alerts || []).slice(-19), { t: new Date().toISOString(), m: String(text).split("\n")[0] }];
  return tg("sendMessage", { chat_id: CHAT_ID, text, ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}) })
    .catch((e) => log("telegram error", e.message));
};

function suggestButton(st) {
  const qty = Math.floor((equity() * tradePct()) / st.price);
  return [[
    { text: `✅ Buy ${qty} ${st.sym} (~${rs(qty * st.price)})`, callback_data: `buy:${st.sym}` },
    { text: "❌ Skip", callback_data: "skip" },
  ]];
}

async function handleUpdate(u) {
  const chat = String(u.message?.chat.id ?? u.callback_query?.message.chat.id ?? "");
  if (chat !== CHAT_ID) return log("ignored unknown chat", chat); // SECURITY: only you

  if (u.callback_query) {
    const d = u.callback_query.data;
    await tg("answerCallbackQuery", { callback_query_id: u.callback_query.id });
    if (d.startsWith("buy:")) {
      const sym = d.slice(4);
      const st = LAST.stocks.find((x) => x.sym === sym);
      if (!marketOpen()) return say("Market is closed. Orders only during 9:15-15:30 IST, Mon-Fri.");
      if (!st) return say("No fresh data. Send /scan first.");
      if (LAST.regime === "BEARISH" || S.regime === "BEARISH") return say("Blocked: market is BEARISH. Not investing now.");
      if (Object.keys(S.positions).length >= CFG.maxPositions) return say("Max positions reached.");
      const qty = Math.floor((equity() * tradePct()) / st.price);
      say(buy(sym, qty, st.price, "one-click") ? `✅ Bought ${qty} ${sym} @ ${rs(st.price)} ${S.live ? "(LIVE)" : "(paper)"}` : "Not enough cash.");
    } else if (d.startsWith("sell:")) {
      const sym = d.slice(5);
      const st = LAST.stocks.find((x) => x.sym === sym);
      if (st && sell(sym, st.price, "one-click")) say(`✅ Sold ${sym} @ ${rs(st.price)} ${S.live ? "(LIVE)" : "(paper)"}`);
    }
    return;
  }

  const text = (u.message?.text || "").trim().toLowerCase();
  if (text === "/start" || text === "/help") {
    return say("Commands:\n/status - account\n/scan - research now\n/chart - equity graph\n/portfolio - money split graph\n/dashboard - dashboard link\n/mode auto|approve\n/pause /resume\n/guide - how it works");
  }
  if (text === "/status") return say(statusText());
  if (text === "/chart") return sendEquityChart();
  if (text === "/portfolio") return sendPortfolioChart();
  if (text === "/dashboard") return E.ONCE === "1" ? sendDashboardFile() : say("Dashboard: " + (E.DASH_URL || "http://localhost:" + DASH_PORT));
  if (text === "/scan") { await runCycle(true); return; }
  if (text === "/pause") { S.paused = true; save(); return say("Paused. No new buys."); }
  if (text === "/resume") { S.paused = false; save(); return say("Resumed."); }
  if (text.startsWith("/mode")) {
    const m = text.split(" ")[1];
    if (m === "auto" || m === "approve") { S.mode = m; save(); return say(`Mode: ${m}`); }
    return say("Use /mode auto or /mode approve");
  }
  if (text === "/guide") {
    return say("How it works:\n1) Every 30 min in market hours I scan Nifty, VIX and your watchlist.\n2) If market is BEARISH I tell you not to invest and block buys.\n3) If BULLISH I send top stocks with a Buy button.\n4) Stop-loss at -5% sells automatically.\n5) Daily loss limit -3% stops all trading.\nOutlook is an estimate, not a prediction.");
  }
}

async function pollTelegram() {
  let offset = 0;
  for (;;) {
    try {
      const r = await tg("getUpdates", { timeout: 25, offset });
      for (const u of r.result || []) { offset = u.update_id + 1; await handleUpdate(u); }
    } catch (e) { log("poll error", e.message); await sleep(5000); }
  }
}

function statusText() {
  const eq = equity();
  const lines = Object.entries(S.positions).map(([s, p]) => {
    const px = LAST.stocks.find((x) => x.sym === s)?.price ?? p.avg;
    return `${s}: ${p.qty} @ ${rs(p.avg)} -> ${rs(px)} (${(((px / p.avg) - 1) * 100).toFixed(1)}%)`;
  });
  return `Equity ${rs(eq)} | Cash ${rs(S.cash)}\nP/L vs start: ${rs(eq - (S.live ? CFG.liveCapital : CFG.startingCash))}\nMarket: ${S.regime}\nMode: ${S.mode}${S.paused ? " (PAUSED)" : ""}\n` +
    (lines.join("\n") || "No open positions");
}

// ---------- SAFE MODE ----------
async function moveToSafe() {
  if (!LAST.safe) return say("Safe asset price unavailable right now.");
  const moved = [];
  for (const [sym, p] of Object.entries(S.positions)) {
    if (sym === CFG.safeAsset) continue;
    sell(sym, LAST.stocks.find((x) => x.sym === sym)?.price ?? p.avg, "safe-mode");
    moved.push(sym);
  }
  const qty = S.cash > equity() * 0.03 ? Math.floor((S.cash * 0.99) / LAST.safe) : 0;
  if (qty >= 1) buy(CFG.safeAsset, qty, LAST.safe, "safe-mode");
  if (moved.length || qty >= 1) await say(`🛡️ SAFE MODE: sold ${moved.join(", ") || "nothing"}; parked money in ${qty} ${CFG.safeAsset} (liquid ETF).`);
}

function oneClickBuy(sym) {
  const st = LAST.stocks.find((x) => x.sym === sym), px = LAST.px?.[sym] ?? st?.price;
  if (!marketOpen()) return "Market is closed (9:15-15:30 IST, Mon-Fri).";
  if (Date.now() - (LAST.pxAt || 0) > 45 * 60000) return "Price data is stale (older than 45 minutes). Buying blocked for safety.";
  if (!st) return "No fresh chart data for that stock yet (only top scored stocks can be bought here).";
  if (LAST.regime === "BEARISH" || S.regime === "BEARISH") return "Blocked: market is BEARISH.";
  if (Object.keys(S.positions).length >= CFG.maxPositions) return "Maximum positions reached.";
  return buy(sym, Math.floor((equity() * tradePct()) / px), px, "dashboard") ? "ok" : "Not enough cash, or blocked by the live caps.";
}

// ---------- LIVE TICK (every minute: fresh prices + graph points) ----------
async function tick() {
  if (!marketOpen()) return;
  try {
    LAST.px = LAST.px || {};
    S.tc = (S.tc || 0) + 1;
    const angel = E.ONCE !== "1" && E.ANGEL_API_KEY && E.ANGEL_CLIENT_ID && E.ANGEL_PIN && E.ANGEL_TOTP_SECRET;
    let live = false;
    if (angel) { try { live = await aoQuotes(); } catch (e) { log("angel quotes", e.message); } }
    LAST.src = live ? "Angel One live" : "Yahoo (delayed)";
    if (!live) {
      const i0 = (S.rr || 0) % CFG.watchlist.length; S.rr = i0 + 5;
      const stamps = [];
      for (const sym of new Set([...Object.keys(S.positions), ...CFG.watchlist.slice(i0, i0 + 5)])) {
        try { const q = await yahooQuote(sym + ".NS"); LAST.px[sym] = q.price; stamps.push(q.time); } catch (e) { log("Yahoo quote", sym, e.message); }
      }
      if (stamps.length) LAST.pxAt = Math.min(...stamps);
    }
    if (!live || S.tc % 4 === 0) {
      const nq = live ? null : await yahooQuote("^NSEI");
      const n = live ? (await candles("^NSEI")).close.at(-1) : nq.price;
      if (nq) LAST.pxAt = LAST.pxAt ? Math.min(LAST.pxAt, nq.time) : nq.time;
      LAST.nifty = n;
      const d = LAST.npc ? (n / LAST.npc - 1) * 100 : 0, lvl = d <= -3 ? 3 : d <= -2 ? 2 : d <= -1 ? 1 : 0, day = istNow().day;
      if (S.emDay !== day) { S.emDay = day; S.emLvl = 0; }
      if (lvl > (S.emLvl || 0)) {
        S.emLvl = lvl;
        say(`🚨🚨 EMERGENCY: Nifty is down ${d.toFixed(2)}% today. Do NOT buy. ${CFG.autoSafe && lvl >= 2 ? "Moving money to safe mode." : "Consider safe mode."}`);
        if (CFG.autoSafe && lvl >= 2) moveToSafe();
      }
    }
    if (Date.now() - (S.hAt || 0) > 60000) {
      S.hAt = Date.now();
      S.nh = [...(S.nh || []).slice(-1499), LAST.nifty];
      S.history = [...(S.history || []).slice(-1499), { t: Date.now(), e: equity() }];
      save();
    }
  } catch (e) { log("tick", e.message); }
}

// ---------- TELEGRAM CHARTS (free QuickChart.io images) ----------
const qc = (cfg) => "https://quickchart.io/chart?w=700&h=360&bkg=white&c=" + encodeURIComponent(JSON.stringify(cfg));
async function sendPhoto(cfg, caption) {
  const r = await tg("sendPhoto", { chat_id: CHAT_ID, photo: qc(cfg), caption: caption.slice(0, 1000) }).catch(() => null);
  if (!r || !r.ok) await say("Chart service unavailable right now.\n" + caption);
}
async function sendEquityChart() {
  const h = (S.history || []).slice(-60);
  if (h.length < 2) return say("Not enough data for a graph yet. Try again after a few scans.");
  const time = (t) => new Date(t).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  await sendPhoto({ type: "line", data: { labels: h.map((x) => time(x.t)), datasets: [{ label: "Equity (Rs)", data: h.map((x) => Math.round(x.e)), borderColor: "#26a69a", fill: false, pointRadius: 0 }] }, options: { title: { display: true, text: "Account equity" } } }, statusText());
}
async function sendPortfolioChart() {
  const labels = ["Cash"], data = [Math.round(S.cash)];
  for (const [sym, p] of Object.entries(S.positions)) {
    labels.push(sym);
    data.push(Math.round(p.qty * (LAST.px?.[sym] ?? LAST.stocks.find((x) => x.sym === sym)?.price ?? p.avg)));
  }
  await sendPhoto({ type: "doughnut", data: { labels, datasets: [{ data }] }, options: { title: { display: true, text: "Where your money is" } } }, statusText());
}

// ---------- MAIN CYCLE ----------
async function runCycle(manual = false) {
  if (!manual && !marketOpen()) return;
  try {
    const t = istNow();
    if (S.dayKey !== t.day) { S.dayKey = t.day; S.dayStartEquity = equity(); save(); }

    const m = await analyseMarket();
    const stocks = [];
    for (const sym of CFG.watchlist) {
      try { stocks.push(await analyseStock(sym)); } catch (e) { log(sym, e.message); }
      await sleep(300);
    }
    stocks.sort((a, b) => b.score - a.score);
    const previousQuotes = { px: LAST.px || {}, pxAt: LAST.pxAt || 0, src: LAST.src || "Yahoo (delayed)" };
    LAST = { ...previousQuotes, time: new Date().toISOString(), nifty: m.price, vix: m.vix, regimeNote: m.note, stocks, regime: m.regime, nc: m.nc, npc: m.pc,
      all: stocks.map((x) => ({ sym: x.sym, price: x.price, pc: x.pc, score: x.score, tv: x.tv, rsi: Math.round(x.rsi) })) };
    try { LAST.safe = (await candles(CFG.safeAsset + ".NS")).close.at(-1); } catch {}
    // Keep the quote timestamp from the intraday quote poll; daily research candles
    // must not make old market prices appear newly refreshed.

    // Regime change alerts
    if (m.regime !== S.regime) {
      if (m.regime === "BEARISH") await say(`🔴 MARKET FALLING (BEARISH)\n${m.note}\nDo NOT invest now. New buys are blocked.`);
      else if (m.regime === "BULLISH") await say(`🟢 MARKET STRONG (BULLISH)\n${m.note}\nGood time to look for investments. Top picks coming.`);
      else await say(`🟡 Market NEUTRAL\n${m.note}`);
      S.regime = m.regime; save();
    }

    if (CFG.autoSafe) {
      if (m.regime === "BEARISH") await moveToSafe();
      else if (m.regime === "BULLISH" && S.positions[CFG.safeAsset]) {
        sell(CFG.safeAsset, LAST.safe ?? S.positions[CFG.safeAsset].avg, "back-to-market");
        await say("🟢 Market strong again: safe money moved back to cash, ready for new ideas.");
      }
    }
    const eq = equity();
    S.history = [...(S.history || []).slice(-1499), { t: Date.now(), e: eq }]; save();
    const dayChg = (eq - S.dayStartEquity) / S.dayStartEquity;

    // Stop-loss (always automatic) + trend-break exits
    for (const [sym, p] of Object.entries(S.positions)) {
      const st = stocks.find((x) => x.sym === sym);
      if (!st) continue;
      const pnl = st.price / p.avg - 1;
      if (pnl <= -CFG.stopLossPct) {
        sell(sym, st.price, "stop-loss");
        await say(`🛑 STOP-LOSS: sold ${sym} @ ${rs(st.price)} (${(pnl * 100).toFixed(1)}%)`);
      } else if (st.score <= 1) {
        if (S.mode === "auto") { sell(sym, st.price, "trend-break"); await say(`Sold ${sym} (trend weak) @ ${rs(st.price)}`); }
        else await say(`⚠️ ${sym} trend is weak (${st.outlook}).`, [[{ text: `Sell ${sym}`, callback_data: `sell:${sym}` }]]);
      }
    }

    if (dayChg <= -CFG.dailyLossLimitPct) {
      return say(`⛔ Daily loss limit hit (${(dayChg * 100).toFixed(1)}%). No new trades today.`);
    }

    for (const st of stocks.slice(0, 8)) st.news = await newsScore(st.sym);

    const mnews = await marketNews();

    // Research report
    const top = stocks.slice(0, 5).map((s) => `${s.sym} ${rs(s.price)} score ${s.score}/6 RSI ${s.rsi.toFixed(0)} 1m ${s.mom.toFixed(1)}% -> ${s.outlook}${s.news ? ` | news ${s.news.n}` : ""}`).join("\n");
    await say(`📊 Research (${m.regime})\n${m.note}\n\nTop 5:\n${top}\n\nMarket news mood: ${mnews.n > 0 ? "+" : ""}${mnews.n}\n${mnews.heads.join("\n")}`);
    if (manual) await sendEquityChart();

    // Buy ideas
    if (m.regime === "BEARISH" || S.paused) return;
    let slots = CFG.maxPositions - Object.keys(S.positions).length;
    for (const st of stocks) {
      if (slots <= 0) break;
      if (st.score < 5 || S.positions[st.sym] || (st.news && st.news.n <= -2)) continue;
      if (S.mode === "auto") {
        const qty = Math.floor((eq * tradePct()) / st.price);
        if (buy(st.sym, qty, st.price, "auto")) { slots--; await say(`🤖 Auto-bought ${qty} ${st.sym} @ ${rs(st.price)} ${S.live ? "(LIVE)" : "(paper)"}`); }
      } else {
        slots--;
        await say(`💡 Buy idea: ${st.sym} @ ${rs(st.price)}\nScore ${st.score}/6, ${st.outlook}\nStop-loss will be ${rs(st.price * (1 - CFG.stopLossPct))}`, suggestButton(st));
      }
    }
  } catch (e) {
    log("cycle error", e.message);
    await say("Error: " + e.message);
  }
}

// ---------- DASHBOARD ----------
function apiState(forPages) {
  const eq = equity();
  let h = "";
  const ledger = S.trades.map((t) => { h = crypto.createHash("sha256").update(h + JSON.stringify(t)).digest("hex"); return { ...t, h: h.slice(0, 12) }; });
  const sells = S.trades.filter((t) => t.side === "SELL");
  S.pinSalt = S.pinSalt || crypto.randomBytes(8).toString("hex");
  return {
    equity: eq, cash: S.cash, pnl: eq - (S.live ? CFG.liveCapital : CFG.startingCash), mode: S.mode, paused: S.paused,
    regime: S.regime, live: !!S.live, note: LAST.regimeNote, updated: LAST.time,
    positions: Object.entries(S.positions).map(([sym, p]) => {
      const px = LAST.px?.[sym] ?? (sym === CFG.safeAsset ? LAST.safe : LAST.stocks.find((x) => x.sym === sym)?.price) ?? p.avg;
      return { sym, qty: p.qty, avg: p.avg, px, pnl: (px - p.avg) * p.qty, sl: p.avg * (1 - CFG.stopLossPct) };
    }),
    history: (S.history || []).slice(-300), nc: LAST.nc || [], nifty: LAST.nifty, vix: LAST.vix, base: S.live ? CFG.liveCapital : CFG.startingCash,
    all: (LAST.all || []).map((x) => ({ ...x, price: LAST.px?.[x.sym] ?? x.price })), npc: LAST.npc, pct: tradePct(), slp: CFG.stopLossPct,
    ledger: ledger.slice(-100), head: h.slice(0, 16), ntr: ledger.length,
    stats: { sells: sells.length, wins: sells.filter((t) => t.pnl > 0).length, realized: sells.reduce((a, t) => a + (t.pnl || 0), 0) },
    psalt: forPages ? S.pinSalt : undefined, pin: forPages && E.DASH_PIN ? crypto.createHash("sha256").update(S.pinSalt + E.DASH_PIN).digest("hex") : undefined,
    pinset: !!E.DASH_PIN, src: LAST.src || "Yahoo (delayed)", pxAt: LAST.pxAt || 0, at: Date.now(), mism: LAST.mism || 0, opt: LAST.opt || null, open: marketOpen(), alerts: (S.alerts || []).slice(-10).reverse(),
    stocks: LAST.stocks.slice(0, 10), trades: S.trades.slice(-15).reverse(),
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TradeDesk</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Crect width=%2764%27 height=%2764%27 rx=%2714%27 fill=%27%237c4dff%27/%3E%3Cpath d=%27M12 44 24 30l9 8 19-22%27 fill=%27none%27 stroke=%27%23fff%27 stroke-width=%276%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E"><style>
:root{--fg:#eceaf6;--mut:#9a95b4;--up:#22c58b;--dn:#ff5d6c;--or:#f5a524;--gl:rgba(255,255,255,.06);--bd:rgba(255,255,255,.12)}
*{box-sizing:border-box}body{margin:0;background:#0a0814;color:var(--fg);font-family:Inter,system-ui,sans-serif;padding:12px 14px 30px;min-height:100vh}
body:before{content:"";position:fixed;inset:0;z-index:-1;background:radial-gradient(900px 500px at 70% -5%,rgba(124,77,255,.45),transparent),radial-gradient(700px 500px at 0% 100%,rgba(236,64,122,.25),transparent),radial-gradient(600px 400px at 100% 100%,rgba(34,197,139,.15),transparent)}
.top{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}.brand{font-weight:700;font-size:18px;margin-right:8px}.nav a{color:var(--mut);text-decoration:none;padding:6px 10px;border-radius:8px;font-size:14px}.nav a:hover{background:var(--gl);color:#fff}
.sp{flex:1}.pill{padding:6px 12px;border-radius:99px;background:var(--gl);border:1px solid var(--bd);font-size:13px}
.g{background:var(--gl);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid var(--bd);border-radius:16px;padding:14px;box-shadow:0 12px 40px rgba(0,0,0,.35)}
.st{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:12px;margin-bottom:12px}.k{color:var(--mut);font-size:12px}.v{font-size:22px;font-weight:700;margin-top:3px}
.main{display:grid;grid-template-columns:1fr 340px;gap:12px;margin-bottom:12px}@media(max-width:900px){.main{grid-template-columns:1fr}}
.up{color:var(--up)}.dn{color:var(--dn)}h3{margin:0 0 10px;font-size:15px}
canvas{display:block;width:100%}#ch{height:320px;touch-action:pan-y;cursor:crosshair}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;align-items:center}
button{border:1px solid var(--bd);background:var(--gl);color:var(--fg);padding:8px 12px;border-radius:10px;font-size:13px;cursor:pointer}button:hover,button.on{background:rgba(124,77,255,.5)}
.b2{display:grid;grid-template-columns:1fr 1fr;gap:8px}.red{background:#c62839}.grn{background:#12805a}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;margin-bottom:12px}
.c{cursor:pointer}.c:hover{border-color:var(--or)}.av{display:inline-grid;place-items:center;width:28px;height:28px;border-radius:50%;background:#7c4dff;font-size:13px;margin-right:8px}
.bd{font-size:11px;padding:2px 8px;border-radius:99px;background:rgba(255,255,255,.1)}
.w{overflow-x:auto}table{width:100%;border-collapse:collapse;font-size:13px}th{color:var(--mut);text-align:left;font-weight:500}td,th{padding:7px 6px;border-bottom:1px solid rgba(255,255,255,.06);white-space:nowrap}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--up);margin-right:6px;animation:p 1.2s infinite}@keyframes p{50%{opacity:.2}}
.sh{animation:sk .6s}@keyframes sk{25%{transform:translateX(-7px)}50%{transform:translateX(7px)}75%{transform:translateX(-4px)}}
.tk{overflow:hidden;white-space:nowrap;border:1px solid var(--bd);border-radius:10px;background:var(--gl);padding:7px 0;margin-bottom:12px}.tk>div{display:inline-block;animation:mq 90s linear infinite}.ti{margin:0 18px;font-size:13px}@keyframes mq{to{transform:translateX(-50%)}}
.hm{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px}.tl{padding:10px 6px;border-radius:10px;text-align:center;font-size:13px;cursor:pointer}
.bl{filter:blur(9px)}input{padding:8px 12px;border-radius:10px;border:1px solid var(--bd);background:var(--gl);color:var(--fg)}
#mo{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50;align-items:center;justify-content:center;padding:14px}.md{max-width:600px;width:100%;max-height:88vh;overflow:auto;background:rgba(20,16,40,.97)}
#em{position:fixed;inset:0;z-index:99;background:rgba(190,0,20,.93);animation:emf 1s infinite alternate;display:none;place-items:center;text-align:center;padding:20px}@keyframes emf{to{background:rgba(120,0,10,.96)}}.emg h1{font-size:34px;margin:0 0 10px}
/* Premium glass terminal + persistent left navigation */
body{padding:0 24px 44px 246px;scroll-behavior:smooth;background:#080a0d}body:before{background:radial-gradient(900px 500px at 85% -5%,rgba(205,160,74,.13),transparent),radial-gradient(700px 500px at 0% 100%,rgba(30,80,80,.12),transparent)}
.sidebar{position:fixed;z-index:30;left:0;top:0;bottom:0;width:220px;padding:22px 14px;display:flex;flex-direction:column;gap:8px;background:rgba(10,13,17,.82);border-right:1px solid rgba(218,180,100,.18);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px)}
.sbbrand{font-size:18px;font-weight:800;letter-spacing:.4px;padding:8px 10px 22px;color:#f3d48c}.sbcap{font-size:10px;letter-spacing:1.8px;color:#8d8a80;padding:14px 10px 5px}.sidebar a,.sidebar button{display:flex;align-items:center;gap:10px;width:100%;text-align:left;text-decoration:none;color:#c4c1b8;background:transparent;border:1px solid transparent;padding:11px 12px;border-radius:11px;font-size:13px}.sidebar a:hover,.sidebar button:hover{background:rgba(218,180,100,.1);border-color:rgba(218,180,100,.2);color:#ffe2a1}.sidebar .sbfoot{margin-top:auto}.top{position:sticky;top:0;z-index:20;margin:0 -24px 16px;padding:14px 24px;background:rgba(8,10,13,.82);backdrop-filter:blur(22px);border-bottom:1px solid rgba(218,180,100,.12)}.brand{color:#f3d48c}.g{background:linear-gradient(145deg,rgba(255,255,255,.075),rgba(255,255,255,.025));border:1px solid rgba(218,180,100,.15);box-shadow:0 16px 44px rgba(0,0,0,.24)}button:hover,button.on{background:rgba(218,180,100,.18);border-color:rgba(218,180,100,.35)}.av{background:linear-gradient(135deg,#e7c77f,#8d682e);color:#17130a}.pill{border-color:rgba(218,180,100,.2)}
#mo{background:rgba(2,5,8,.72);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}.md{background:linear-gradient(145deg,rgba(30,34,39,.96),rgba(13,17,21,.96));border:1px solid rgba(232,194,112,.32);box-shadow:0 24px 90px rgba(0,0,0,.6),0 0 45px rgba(218,180,100,.08);border-radius:22px}
.pinbox{max-width:390px;text-align:center;padding:28px}.pinbox .pinmark{width:54px;height:54px;margin:0 auto 14px;border-radius:18px;display:grid;place-items:center;color:#f3d48c;background:rgba(218,180,100,.13);font-size:24px}.pinbox input{width:100%;margin:14px 0 8px;text-align:center;font-size:22px;letter-spacing:9px;padding:14px;border-color:rgba(232,194,112,.3)}.pinbox .pinerr{min-height:20px;color:#ff7b83;font-size:12px}
.mapwrap{position:relative;overflow:hidden;border-radius:14px;background:radial-gradient(ellipse at 50% 45%,rgba(210,166,76,.11),transparent 70%)}#im{width:100%;height:440px;max-height:none;cursor:grab;touch-action:none}#im:active{cursor:grabbing}.maptools{position:absolute;right:10px;top:10px;display:flex;gap:6px}.maptools button{background:rgba(14,16,18,.85);border-color:rgba(232,194,112,.35);color:#f1d18c}.maphint{font-size:11px;color:var(--mut);padding:5px 2px 0}
#im .india-shape{fill:rgba(218,180,100,.17);stroke:#e4c276;stroke-width:2.2;filter:drop-shadow(0 0 8px rgba(218,180,100,.42))}#im .city-dot{stroke:#f7e3b3;stroke-width:1.2;filter:drop-shadow(0 0 6px rgba(245,201,112,.8))}
@media(max-width:900px){body{padding:0 12px 30px}.sidebar{position:sticky;top:0;width:auto;height:auto;bottom:auto;flex-direction:row;overflow-x:auto;padding:8px;background:rgba(10,13,17,.95)}.sbbrand,.sbcap,.sbfoot{display:none}.sidebar a,.sidebar button{white-space:nowrap;width:auto;padding:9px 11px}.top{margin:0 -12px 14px;padding:12px}.top .nav{display:none}}
</style></head><body>
<aside class="sidebar"><div class="sbbrand">✦ TRADEDESK <small style="display:block;color:#8d8a80;font-size:10px;font-weight:500;margin-top:4px;letter-spacing:1.5px">INDIA MARKETS</small></div><div class="sbcap">WORKSPACE</div><a href="#ov">◫ &nbsp; Overview</a><a href="#pk">⌁ &nbsp; Top picks</a><a href="#india">◎ &nbsp; India map</a><a href="#heat">▦ &nbsp; Market heatmap</a><a href="#companies">⌕ &nbsp; Companies</a><div class="sbcap">PORTFOLIO</div><a href="#hd">▤ &nbsp; Holdings</a><a href="#tr">⇄ &nbsp; Trades</a><a href="#al">◉ &nbsp; Alerts</a><div class="sbcap">ACCOUNT</div><button data-x="acct">◉ &nbsp; Account details</button><button id="lk" data-x="lock">♙ &nbsp; Lock balance</button><div class="sbfoot"><button data-x="out">↪ &nbsp; Log out</button></div></aside><div class="top"><span class="brand"><span class="dot"></span>TradeDesk</span><span class="sp"></span><span class="pill" id="rg"></span><span class="pill" id="md"></span><span class="pill" id="ds"></span><span class="pill" id="ck"></span></div><div class="tk"><div id="tkr"></div></div>
<div class="st" id="t"></div>
<div class="main" id="ov"><div class="g"><div class="tabs" id="tb"></div><canvas id="ch"></canvas><div id="sub" style="color:var(--mut);font-size:12px;margin-top:6px"></div></div>
<div style="display:grid;gap:12px;align-content:start"><div class="g"><h3>Controls</h3><div id="ct"></div></div><div class="g"><h3>Where your money is</h3><canvas id="a" style="height:170px"></canvas><div id="lg" style="font-size:12px;margin-top:6px"></div></div></div></div>
<h3 id="pk" style="margin:6px 2px">Top picks (tap a card for its chart)</h3><div class="cards" id="cd"></div>
<div class="main" id="india"><div class="g"><h3>India market footprint <span style="color:#e4c276;font-weight:400">· Gold map</span></h3><div class="mapwrap"><svg id="im" viewBox="0 0 400 440" preserveAspectRatio="xMidYMid meet"></svg><div class="maptools"><button data-map="in">＋</button><button data-map="out">−</button><button data-map="reset">Reset</button></div></div><div class="maphint">Scroll to zoom · Drag to move · Use controls to zoom in and out</div></div><div class="g"><h3>Nifty options view (CE / PE)</h3><div id="op"></div></div></div>
<h3 id="heat" style="margin:6px 2px">India market map (live heatmap, tap a tile for its chart)</h3><div class="g" style="margin-bottom:12px"><div class="hm" id="hm"></div></div><div class="g w" id="companies" style="margin-bottom:12px"><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px"><h3 style="margin:0">All companies (live)</h3><input id="q" placeholder="Search company..."></div><div id="ls"></div></div>
<div class="g w" id="hd" style="margin-bottom:12px"><h3>Holdings</h3><div id="p"></div></div>
<div class="main"><div class="g w" id="tr"><h3>Recent trades</h3><div id="trd"></div></div><div class="g" id="al"><h3>Alerts</h3><div id="alt"></div></div></div>
<div class="g w" style="margin-top:12px"><h3>Most valuable stocks trading now (by traded value)</h3><div id="mv"></div></div><div id="em"></div><div id="mo" style="display:none"></div>
<script>
const f=n=>"₹"+Number(n).toLocaleString("en-IN",{maximumFractionDigits:0}),$=id=>document.getElementById(id),cl=n=>n>=0?"up":"dn";
const COLS=["#7c4dff","#22c58b","#f5a524","#26c6da","#ff5d6c","#ec407a","#9ccc65","#8d6e63"];
let LK=false,UNL=0,tkN=0,EMX=0,D=null,V="acct",SY="NIFTY",RG="all",MX=-1,prev=null,sig="";
function setup(c){const d=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*d;c.height=h*d;const x=c.getContext("2d");x.setTransform(d,0,0,d,0,0);return[x,w,h]}
const tm=t=>new Date(t).toLocaleString("en-IN",{timeZone:"Asia/Kolkata",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"});
function frame(x,h,mn,mx,L,Rr){x.font="11px system-ui";for(let k=0;k<4;k++){const y=14+k*(h-34)/3;x.strokeStyle="rgba(255,255,255,.07)";x.setLineDash([3,4]);x.beginPath();x.moveTo(L,y);x.lineTo(Rr,y);x.stroke();x.setLineDash([]);x.fillStyle="#9a95b4";x.fillText(Math.round(mx-k*(mx-mn)/3).toLocaleString("en-IN"),Rr+6,y+4)}}
function crossh(x,h,cx,cy,Rr){x.strokeStyle="rgba(255,255,255,.35)";x.setLineDash([4,4]);x.beginPath();x.moveTo(cx,10);x.lineTo(cx,h-20);x.moveTo(6,cy);x.lineTo(Rr,cy);x.stroke();x.setLineDash([]);x.beginPath();x.arc(cx,cy,5,0,7);x.fillStyle="#fff";x.fill()}
function tip(x,w,px,py,ls){const bw=165,bh=15*ls.length+10,bx=Math.min(Math.max(px+10,4),w-bw-70),by=Math.max(py-bh-8,4);x.fillStyle="rgba(15,12,30,.93)";x.strokeStyle="rgba(255,255,255,.2)";x.beginPath();x.rect(bx,by,bw,bh);x.fill();x.stroke();x.fillStyle="#eceaf6";ls.forEach((l,i)=>x.fillText(l,bx+8,by+17+i*15))}
function cand(){if(SY==="NIFTY")return D.nc||[];const s=D.stocks.find(p=>p.sym===SY);return s&&s.c?s.c:[]}
function chart(){const[x,w,h]=setup($("ch")),L=6,Rr=w-62;
if(V==="acct"){if(D.locked){x.fillStyle="#9a95b4";x.fillText("🔒 Balance locked. Tap Unlock balance.",14,30);$("sub").textContent="";return}let a=D.history||[];const n=Date.now();if(RG==="1d")a=a.filter(p=>p.t>n-864e5);if(RG==="1w")a=a.filter(p=>p.t>n-6048e5);
if(a.length<2){x.fillStyle="#9a95b4";x.fillText("Collecting live data... (updates every few minutes in market hours)",14,30);$("sub").textContent="";return}
const v=a.map(p=>p.e),mn=Math.min(...v),mx=Math.max(...v),r=(mx-mn)||1,X=i=>L+i*(Rr-L)/(v.length-1),Y=y=>h-20-(y-mn)/r*(h-34);
frame(x,h,mn,mx,L,Rr);const g=x.createLinearGradient(0,0,0,h);g.addColorStop(0,"rgba(245,165,36,.35)");g.addColorStop(1,"rgba(245,165,36,0)");
x.beginPath();v.forEach((y,i)=>i?x.lineTo(X(i),Y(y)):x.moveTo(X(i),Y(y)));x.strokeStyle="#f5a524";x.lineWidth=2;x.stroke();x.lineTo(X(v.length-1),h-20);x.lineTo(L,h-20);x.fillStyle=g;x.fill();
const st=Math.ceil(v.length/14);v.forEach((y,i)=>{if(i%st==0){x.beginPath();x.arc(X(i),Y(y),3.5,0,7);x.fillStyle="#0a0814";x.fill();x.strokeStyle="#f5a524";x.stroke()}});
if(MX>=0){const i=Math.min(v.length-1,Math.max(0,Math.round((MX-L)/((Rr-L)/(v.length-1)))));crossh(x,h,X(i),Y(v[i]),Rr);tip(x,w,X(i),Y(v[i]),[tm(a[i].t),"Value: "+f(v[i]),"P/L: "+f(v[i]-v[0])+" vs start"])}
$("sub").textContent="Account value: "+a.length+" points"}
else{const k=cand();if(!k.length){x.fillStyle="#9a95b4";x.fillText("Waiting for the next market scan...",14,30);$("sub").textContent="";return}
const mn=Math.min(...k.map(c=>c[2])),mx=Math.max(...k.map(c=>c[1])),r=(mx-mn)||1,bw=(Rr-L)/k.length,Y=y=>h-20-(y-mn)/r*(h-34);
frame(x,h,mn,mx,L,Rr);k.forEach((c,i)=>{const cx=L+i*bw+bw/2,up=c[3]>=c[0];x.strokeStyle=x.fillStyle=up?"#22c58b":"#ff5d6c";x.lineWidth=1;x.beginPath();x.moveTo(cx,Y(c[1]));x.lineTo(cx,Y(c[2]));x.stroke();const t=Y(Math.max(c[0],c[3])),b=Y(Math.min(c[0],c[3]));x.fillRect(cx-bw*.35,t,bw*.7,Math.max(1.5,b-t))});
const mk2=marks(k);mk2.forEach(([i,d])=>{const cx=L+i*bw+bw/2,u=d==="up",lab=SY==="NIFTY"?(u?"CE":"PE"):(u?"B":"S"),y=u?Y(k[i][2])+16:Y(k[i][1])-8;x.fillStyle=u?"#22c58b":"#ff5d6c";x.font="bold 11px system-ui";x.fillText((u?"▲":"▼")+lab,cx-12,y)});
if(MX>=0){const i=Math.min(k.length-1,Math.max(0,Math.floor((MX-L)/bw))),c=k[i];crossh(x,h,L+i*bw+bw/2,Y(c[3]),Rr);tip(x,w,L+i*bw,Y(c[3]),["Open "+c[0]+"   High "+c[1],"Low "+c[2]+"   Close "+c[3]])}
const lm=mk2.length?mk2[mk2.length-1][1]:null;$("sub").textContent=SY+" daily candles | latest signal: "+(lm?(SY==="NIFTY"?(lm==="up"?"CE (call) bias":"PE (put) bias"):(lm==="up"?"BUY":"SELL")):"none")+" | indicator crossover, not advice"}}
function spark(c,a,col){const[x,w,h]=setup(c);if(!a||a.length<2)return;const mn=Math.min(...a),mx=Math.max(...a),r=(mx-mn)||1;x.beginPath();a.forEach((v,i)=>{const X=i*(w-2)/(a.length-1)+1,Y=h-3-(v-mn)/r*(h-6);i?x.lineTo(X,Y):x.moveTo(X,Y)});x.strokeStyle=col;x.lineWidth=1.8;x.stroke()}
function donut(parts){const[x,w,h]=setup($("a")),tot=parts.reduce((a,b)=>a+b.v,0)||1,cx=w/2,cy=h/2,R=Math.min(w,h)/2-6;let a0=-Math.PI/2;
parts.forEach((p,i)=>{const a=p.v/tot*Math.PI*2;x.beginPath();x.arc(cx,cy,R,a0,a0+a);x.arc(cx,cy,R*.62,a0+a,a0,true);x.closePath();x.fillStyle=COLS[i%8];x.fill();a0+=a});
x.fillStyle="#eceaf6";x.textAlign="center";x.font="600 15px system-ui";x.fillText(f(tot),cx,cy+5);x.textAlign="left"}
const tbl=(h,rows)=>'<table><tr>'+h.map(a=>'<th>'+a+'</th>').join("")+'</tr>'+rows.map(r=>'<tr>'+r.map(a=>'<td>'+a+'</td>').join("")+'</tr>').join("")+'</table>';
function render(){const s=D,inv=s.positions.reduce((a,p)=>a+p.qty*p.avg,0),pp=s.base?s.pnl/s.base*100:0;
const tl=[["Account value",f(s.equity),""],["Cash",f(s.cash),""],["Invested",f(inv),""],["Total P/L",f(s.pnl)+" ("+pp.toFixed(1)+"%)",cl(s.pnl)],["Nifty 50",s.nifty?Math.round(s.nifty).toLocaleString("en-IN"):"-",""],["India VIX",s.vix?s.vix.toFixed(1):"-",""]];
$("t").innerHTML=tl.map((a,i)=>'<div class="g"><div class="k">'+a[0]+'</div><div class="v '+a[2]+(LK&&i<4?" bl":"")+'" style="font-size:'+(a[1].length>14?17:22)+'px">'+a[1]+'</div></div>').join("");
if(prev!==null&&s.equity<prev)$("t").firstChild.classList.add("sh");prev=s.equity;
$("rg").innerHTML=(s.regime=="BULLISH"?"🟢 ":s.regime=="BEARISH"?"🔴 ":"🟡 ")+"Market "+s.regime;$("md").textContent=(s.live?"🔴 LIVE":"Paper")+" | "+s.mode+(s.paused?" (PAUSED)":"");
const tp=s.stocks.slice(0,6);
$("tb").innerHTML='<button data-v="acct" class="'+(V==="acct"?"on":"")+'">Account value</button><button data-v="candle" data-s="NIFTY" class="'+(V==="candle"&&SY==="NIFTY"?"on":"")+'">NIFTY</button>'+tp.map(p=>'<button data-v="candle" data-s="'+p.sym+'" class="'+(V==="candle"&&SY===p.sym?"on":"")+'">'+p.sym+'</button>').join("")+'<span class="sp" style="flex:1"></span>'+["1d","1w","all"].map(r=>'<button data-r="'+r+'" class="'+(RG===r?"on":"")+'">'+r.toUpperCase()+'</button>').join("");
chart();
const parts=[{n:"Cash",v:s.cash}].concat(s.positions.map(p=>({n:p.sym,v:p.qty*p.px})));donut(parts);
$("lg").innerHTML=parts.map((p,i)=>'<span style="margin-right:10px"><span style="color:'+COLS[i%8]+'">●</span> '+p.n+' '+f(p.v)+'</span>').join("");
const sg=s.mode+s.paused+s.live;if(sg!==sig){sig=sg;const b=(a,t,c)=>'<button data-a="'+a+'" class="'+(c||"")+'">'+t+'</button>';
$("ct").innerHTML='<div class="b2">'+b("approve","Approve mode",s.mode==="approve"?"on":"")+b("auto","Auto mode",s.mode==="auto"?"on":"")+b("pause","Pause",s.paused?"on":"")+b("resume","Resume")+b("safe","Move to Safe")+b("killswitch","KILL SWITCH","red")+b("golive","Go Live","grn")+b("paper","Back to Paper")+'</div><p style="color:var(--mut);font-size:12px;margin:10px 0 0">Mode: <b>'+(s.live?"LIVE (real money)":"Paper (virtual money)")+'</b></p>'}
$("cd").innerHTML=tp.map((p,i)=>'<div class="g c" data-v="candle" data-s="'+p.sym+'"><div style="display:flex;align-items:center"><span class="av">'+p.sym[0]+'</span><b>'+p.sym+'</b><span class="sp" style="flex:1"></span><span class="bd">'+p.score+'/6</span></div><div style="margin:8px 0 2px;font-size:20px;font-weight:700">'+f(p.price)+' <small class="'+cl(p.mom)+'">'+p.mom.toFixed(1)+'% 1m</small></div><canvas id="sp'+i+'" style="height:38px"></canvas><div class="k" style="margin-top:6px">'+p.outlook+' | RSI '+p.rsi.toFixed(0)+' | news '+(p.news?p.news.n:"-")+'</div></div>').join("");
tp.forEach((p,i)=>spark($("sp"+i),(p.c||[]).map(c=>c[3]),p.mom>=0?"#22c58b":"#ff5d6c"));
$("p").innerHTML=s.positions.length?tbl(["Stock","Qty","Avg buy","Now","Invested","Value","P/L","P/L %","Stop-loss",""],s.positions.map(p=>[p.sym,p.qty,f(p.avg),f(p.px),f(p.qty*p.avg),f(p.qty*p.px),'<span class="'+cl(p.pnl)+'">'+f(p.pnl)+'</span>','<span class="'+cl(p.pnl)+'">'+((p.px/p.avg-1)*100).toFixed(1)+'%</span>',f(p.sl),'<button data-sell="'+p.sym+'">Sell</button>'])):"No open positions yet.";
$("trd").innerHTML=tbl(["Time","Side","Stock","Qty","Price","Why"],s.trades.map(t=>[t.t.slice(5,16).replace("T"," "),t.side,t.sym,t.qty,f(t.price),t.why]));
$("alt").innerHTML=s.alerts.map(a=>'<div style="padding:3px 0;font-size:13px">'+new Date(a.t).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"})+" "+a.m.replace(/</g,"&lt;")+'</div>').join("")}
function marks(k){const cl=k.map(c=>c[3]),sm=(i,n)=>cl.slice(i-n+1,i+1).reduce((a,b)=>a+b,0)/n,m=[];for(let i=10;i<k.length;i++){const a=sm(i,5),b=sm(i,10),a0=sm(i-1,5),b0=sm(i-1,10);if(a0<=b0&&a>b)m.push([i,"up"]);if(a0>=b0&&a<b)m.push([i,"dn"])}return m}
const chg=(p,pc)=>pc?(p/pc-1)*100:0,sgn=n=>(n>=0?"+":"")+n.toFixed(2)+"%",sgl=s=>s.score>=5?"BUY":s.score<=1?"SELL":"HOLD";
function modal(h){$("mo").style.display="flex";$("mo").innerHTML='<div class="md g">'+h+'<p><button data-x="close">Close</button></p></div>'}
async function post(b){const r=await fetch("/api/control",{method:"POST",headers:{"X-Requested-With":"dashboard"},body:JSON.stringify(b)});alert(r.ok?"Done: "+b.action+(b.sym?" "+b.sym:""):await r.text());load()}
let bad=0;async function pin(){if(bad>=3){alert("Too many wrong PINs. Please wait before trying again.");return false}return new Promise(resolve=>{modal('<div class="pinbox"><div class="pinmark">♙</div><h3>Secure account access</h3><p style="color:var(--mut);font-size:13px">Enter your PIN to view protected account information</p><input id="pinentry" type="password" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="••••"/><div class="pinerr" id="pinerr"></div><button id="pinsubmit" class="grn" style="width:100%;padding:11px">Unlock securely</button><button id="pincancel" style="width:100%;margin-top:8px">Cancel</button></div>');const input=$("pinentry"),err=$("pinerr");input.focus();const finish=ok=>{$("mo").style.display="none";resolve(ok)};const submit=async()=>{const p=input.value.trim();if(!p){err.textContent="Please enter your PIN.";return}const r=await fetch("/api/pin",{method:"POST",headers:{"X-Requested-With":"dashboard"},body:JSON.stringify({pin:p})});if(!D.pin){if(r.ok){bad=0;await load();finish(true);return}bad++;err.textContent=await r.text();return}const h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(D.psalt+p)),x=[...new Uint8Array(h)].map(b=>b.toString(16).padStart(2,"0")).join("");if(x===D.pin&&r.ok){UNL=Date.now()+3e5;bad=0;finish(true);return}bad++;err.textContent=bad>=3?"Too many attempts. Please wait.":"Incorrect PIN. Please try again."};$("pinsubmit").onclick=submit;$("pincancel").onclick=()=>finish(false);input.addEventListener("keydown",e=>{if(e.key==="Enter")submit();if(e.key==="Escape")finish(false)});});}
function buyModal(sym){const s=(D.all||[]).find(z=>z.sym===sym);if(!s)return;const pr=s.price,pct=D.pct||.05,qty=Math.floor(D.equity*pct/pr),sl=pr*(1-(D.slp||.05));
modal('<h3>Buy '+sym+'</h3><p>Signal: <b>'+sgl(s)+'</b> | Price '+f(pr)+' | Day '+sgn(chg(pr,s.pc))+'</p>'+(qty<1?'<p class="dn">Budget per trade is too small for 1 share.</p>':'<table><tr><td>Quantity to buy</td><td><b>'+qty+' shares</b></td></tr><tr><td>Total cost</td><td>'+f(qty*pr)+' ('+(pct*100).toFixed(0)+'% of account)</td></tr><tr><td>Stop-loss</td><td>'+f(sl)+'</td></tr><tr><td>Target (+10%)</td><td>'+f(pr*1.1)+'</td></tr><tr><td>Max loss at stop-loss</td><td class="dn">'+f(qty*(pr-sl))+'</td></tr></table>')+(D.regime==="BEARISH"?'<p class="dn">Market is BEARISH: the bot will block this buy.</p>':'')+'<p style="color:var(--mut);font-size:12px">'+(D.live?"REAL MONEY order.":"Paper trade (virtual money).")+' Not advice; you can lose money.</p>'+(qty>=1?'<button class="grn" data-cb="'+sym+'">Confirm buy</button>':''))}
async function acct(){if((D.pin||D.pinset)&&LK&&!(await pin()))return;LK=false;render();const un=D.positions.reduce((a,p)=>a+p.pnl,0),st=D.stats||{},row=(a,b)=>'<tr><td>'+a+'</td><td>'+b+'</td></tr>';
modal('<h3>Account details</h3><table>'+row("Account value",f(D.equity))+row("Starting capital",f(D.base))+row(D.pnl>=0?"Total profit":"Total LOSS",'<b class="'+cl(D.pnl)+'">'+f(D.pnl)+'</b>')+row("Realized (closed trades)",f(st.realized||0))+row("Unrealized (open)",f(un))+row("Cash",f(D.cash))+row("Closed trades / win rate",(st.sells||0)+" / "+(st.sells?Math.round(st.wins/st.sells*100):0)+"%")+row("Mode",D.live?"LIVE (real money)":"Paper")+'</table><h3 style="margin-top:14px">Trade proof ledger</h3><p style="font-size:12px;color:var(--mut)">Each row is chained to the previous one (SHA-256). Chain head <b>'+D.head+'</b> over '+D.ntr+' trades. Editing any old trade changes every later hash. For live trades also check Angel One contract notes.</p>'+tbl(["Time","Side","Stock","Qty","Price","P/L","Hash"],(D.ledger||[]).slice(-30).reverse().map(t=>[t.t.slice(5,16).replace("T"," "),t.side,t.sym,t.qty,f(t.price),t.pnl==null?"-":f(t.pnl),t.h]))+'<p><button data-x="csv">Download CSV</button></p>')}
function extras(){const all=D.all||[],nch=chg(D.nifty,D.npc),items=[{sym:"NIFTY 50",price:D.nifty||0,c:nch}].concat(all.map(s=>({sym:s.sym,price:s.price,c:chg(s.price,s.pc)})));
if(tkN!==items.length){tkN=items.length;const h=items.map(i=>'<span class="ti" data-t="'+i.sym+'"></span>').join("");$("tkr").innerHTML=h+h}
document.querySelectorAll("[data-t]").forEach(e=>{const i=items.find(z=>z.sym===e.dataset.t);if(i)e.innerHTML=i.sym+" "+Math.round(i.price*100)/100+' <b class="'+cl(i.c)+'">'+(i.c>=0?"▲":"▼")+Math.abs(i.c).toFixed(2)+"%</b>"});
$("hm").innerHTML=all.slice().sort((a,b)=>chg(b.price,b.pc)-chg(a.price,a.pc)).map(s=>{const c=chg(s.price,s.pc);return '<div class="tl" data-v="candle" data-s="'+s.sym+'" style="background:'+(c>=0?"rgba(34,197,139,":"rgba(255,93,108,")+Math.min(.9,.25+Math.abs(c)/4)+')"><b>'+s.sym+"</b><br>"+sgn(c)+"</div>"}).join("");
const q=($("q").value||"").toUpperCase();
$("ls").innerHTML=tbl(["Company","Price","Day","Score","Signal",""],all.filter(s=>s.sym.includes(q)).map(s=>{const c=chg(s.price,s.pc),g=sgl(s);return [s.sym,f(s.price),'<span class="'+cl(c)+'">'+sgn(c)+"</span>",s.score+"/6",'<span class="bd '+(g==="BUY"?"up":g==="SELL"?"dn":"")+'">'+g+"</span>",'<button data-b="'+s.sym+'">Buy</button>']}));
$("mv").innerHTML=tbl(["#","Stock","Price","Traded value","Day"],all.slice().sort((a,b)=>b.tv-a.tv).slice(0,8).map((s,i)=>{const c=chg(s.price,s.pc);return [i+1,s.sym,f(s.price),"₹"+Math.round(s.tv/1e7).toLocaleString("en-IN")+" Cr",'<span class="'+cl(c)+'">'+sgn(c)+"</span>"]}));
const em=D.regime==="BEARISH"||nch<=-1;
if(em&&Date.now()>EMX){if($("em").style.display!=="grid"){$("em").style.display="grid";$("em").innerHTML='<div class="emg"><h1>🚨 EMERGENCY: MARKET FALLING</h1><p>Nifty '+sgn(nch)+" today | Market "+D.regime+'</p><p>Do NOT buy now. New buys are blocked.</p><button data-a="safe">Move to Safe</button> <button data-x="dis">Dismiss 10 min</button></div>'}}else if(!em)$("em").style.display="none";
$("lk").textContent=(D.pin||D.pinset)?(LK?"🔒 Unlock balance":"🔓 Lock"):"🔓 Balance"}
function csv(){const rows=[["time","side","stock","qty","price","pnl","hash"]].concat((D.ledger||[]).map(t=>[t.t,t.side,t.sym,t.qty,t.price,t.pnl==null?"":t.pnl,t.h])),a=document.createElement("a");a.href=URL.createObjectURL(new Blob([rows.map(r=>r.join(",")).join("\\n")],{type:"text/csv"}));a.download="trades.csv";a.click()}
const HQ="RELIANCE:M,TCS:M,HDFCBANK:M,INFY:B,ICICIBANK:M,SBIN:M,BHARTIARTL:D,ITC:K,LT:M,HINDUNILVR:M,KOTAKBANK:M,AXISBANK:M,MARUTI:D,SUNPHARMA:M,BAJFINANCE:P,TITAN:B,NTPC:D,ASIANPAINT:M,ULTRACEMCO:M,WIPRO:B,HCLTECH:D,POWERGRID:D,ONGC:D,COALINDIA:K,TATASTEEL:M,JSWSTEEL:M,ADANIENT:A,ADANIPORTS:A,NESTLEIND:D,TECHM:P,BAJAJFINSV:P,GRASIM:M,CIPLA:M,DRREDDY:H,EICHERMOT:D,HEROMOTOCO:D,BRITANNIA:B,INDUSINDBK:M,APOLLOHOSP:C,HDFCLIFE:M,SBILIFE:M,TATACONSUM:M,BPCL:M,DIVISLAB:H,HINDALCO:M,SHRIRAMFIN:M,TRENT:M,BEL:B".split(",").reduce((o,s)=>{const[a,b]=s.split(":");o[a]=b;return o},{});
const CITY={M:["Mumbai",72.88,19.07],D:["Delhi NCR",77.2,28.6],B:["Bengaluru",77.6,12.97],K:["Kolkata",88.36,22.57],C:["Chennai",80.27,13.08],H:["Hyderabad",78.47,17.38],A:["Ahmedabad",72.57,23.03],P:["Pune",73.86,18.52]};
const OUT=[[74.5,36.9],[77.8,35.5],[79.5,32.5],[78.8,30.5],[81,30.2],[80.2,28.8],[84,27.4],[88,27.3],[88.1,26.5],[89.8,26.7],[92,27],[95.5,28.2],[97.3,28.3],[96,27],[94.8,25.2],[93.5,23.8],[92.5,22.5],[92.1,24.8],[90.5,25.2],[89.8,26],[88.8,26.2],[88.1,25.2],[88.6,22.3],[87,21.5],[86.5,20.2],[85,19.3],[83.5,18],[82.2,16.8],[80.5,15.5],[80.2,13.2],[79.8,10.3],[78.2,8.9],[77.5,8.1],[76.5,9.5],[75.5,11.8],[74.8,13.5],[73.8,16],[72.8,19],[72.8,21],[72.5,21.8],[70.2,21],[69,22.3],[70.5,23],[68.5,23.5],[70.2,25],[71,27.5],[72.5,29.5],[74.5,31],[74,32.5],[74.5,34],[73.5,35]];
const PX=(lo,la)=>[((lo-68)/30*400).toFixed(1),((37-la)/31*440).toFixed(1)];
function extras2(){const all=D.all||[],agg={};all.forEach(s=>{const c=HQ[s.sym];if(!c)return;(agg[c]=agg[c]||{n:0,t:0}).n++;agg[c].t+=chg(s.price,s.pc)});
let h='<polygon points="'+OUT.map(p=>PX(p[0],p[1]).join(",")).join(" ")+'" class="india-shape"/>';
Object.keys(agg).forEach(k=>{const a=agg[k],v=a.t/a.n,c=CITY[k],xy=PX(c[1],c[2]),x=+xy[0],y=+xy[1];h+='<circle cx="'+x+'" cy="'+y+'" r="'+(9+a.n*1.6)+'" class="city-dot" fill="'+(v>=0?"#d9b66e":"#9b7950")+'"/><text x="'+x+'" y="'+(y+4)+'" text-anchor="middle" font-size="10" fill="#fff">'+a.n+'</text><text x="'+(x+14+a.n*1.4)+'" y="'+(y+4)+'" font-size="11" fill="#eceaf6">'+c[0]+" "+sgn(v)+"</text>"});
$("im").innerHTML=h;
const mm=marks(D.nc||[]),lm=mm.length?mm[mm.length-1][1]:null,o=D.opt||{},atm=o.strike||(D.nifty?Math.round(D.nifty/50)*50:0),pr=v=>v!=null?"₹"+v:"needs Angel One live feed";
$("op").innerHTML='<p>Bias: <b class="'+(lm==="up"?"up":lm==="dn"?"dn":"")+'">'+(lm==="up"?"CE (call) - bullish":lm==="dn"?"PE (put) - bearish":"no clear signal")+'</b><br>Market: '+D.regime+'</p><table><tr><td>Nifty spot</td><td>'+(D.nifty?Math.round(D.nifty).toLocaleString("en-IN"):"-")+'</td></tr><tr><td>ATM strike</td><td><b>'+atm+'</b>'+(o.exp?" ("+o.exp+")":"")+'</td></tr><tr><td>ATM CE premium</td><td>'+pr(o.ce)+'</td></tr><tr><td>ATM PE premium</td><td>'+pr(o.pe)+'</td></tr></table><p style="color:var(--mut);font-size:12px">Options can lose 100% of the money in minutes. The bot never trades options. Information only, not advice.</p>';
const age=D.pxAt?Math.round((Date.now()-D.pxAt)/1000):null,stale=D.open&&age!==null&&age>(D.src==="Angel One live"?30:1200);
$("ds").innerHTML='<span class="'+(stale?"dn":"up")+'">●</span> '+D.src+(age!==null?" | "+(age<120?age+"s":Math.round(age/60)+"m")+" since quote":"")+(stale?' | <b class="dn">STALE</b>':"")+(D.mism?' | <b class="dn">'+D.mism+" price mismatch</b>":"")}
let mapView={x:0,y:0,w:400,h:440},mapDrag=null;function applyMap(){const el=$("im");el.setAttribute("viewBox",[mapView.x,mapView.y,mapView.w,mapView.h].join(" "))}function zoomMap(factor,cx=200,cy=220){const nw=Math.max(120,Math.min(400,mapView.w*factor)),nh=nw*1.1,rx=(cx-mapView.x)/mapView.w,ry=(cy-mapView.y)/mapView.h;mapView={x:Math.max(0,Math.min(400-nw,cx-rx*nw)),y:Math.max(0,Math.min(440-nh,cy-ry*nh)),w:nw,h:nh};applyMap()}$("im").addEventListener("wheel",e=>{e.preventDefault();const r=$("im").getBoundingClientRect(),x=(e.clientX-r.left)/r.width*mapView.w+mapView.x,y=(e.clientY-r.top)/r.height*mapView.h+mapView.y;zoomMap(e.deltaY<0?.85:1.18,x,y)},{passive:false});$("im").addEventListener("pointerdown",e=>{mapDrag={x:e.clientX,y:e.clientY,view:{...mapView}};$("im").setPointerCapture(e.pointerId)});$("im").addEventListener("pointermove",e=>{if(!mapDrag)return;const r=$("im").getBoundingClientRect(),dx=(e.clientX-mapDrag.x)/r.width*mapDrag.view.w,dy=(e.clientY-mapDrag.y)/r.height*mapDrag.view.h;mapView={...mapDrag.view,x:Math.max(0,Math.min(400-mapDrag.view.w,mapDrag.view.x-dx)),y:Math.max(0,Math.min(440-mapDrag.view.h,mapDrag.view.y-dy))};applyMap()});["pointerup","pointercancel","lostpointercapture"].forEach(ev=>$("im").addEventListener(ev,()=>mapDrag=null));document.addEventListener("click",e=>{const b=e.target.closest("[data-map]");if(!b)return;if(b.dataset.map==="reset"){mapView={x:0,y:0,w:400,h:440};applyMap()}else zoomMap(b.dataset.map==="in"?.78:1.28)});
async function load(){const r=await fetch("/api/state");if(r.status===401){location="/login";return}D=await r.json();LK=D.locked||(!!D.pin&&Date.now()>UNL);render();extras();extras2()}
async function ctl(a){const b={action:a};if(a==="golive"){const t=prompt("REAL MONEY. Type GO LIVE to confirm:");if(t!=="GO LIVE")return;b.confirm=t}const r=await fetch("/api/control",{method:"POST",headers:{"X-Requested-With":"dashboard"},body:JSON.stringify(b)});if(!r.ok)alert(await r.text());load()}
const C=$("ch");["mousemove","touchmove"].forEach(ev=>C.addEventListener(ev,e=>{const p=e.touches?e.touches[0]:e;MX=p.clientX-C.getBoundingClientRect().left;if(D)chart()},{passive:true}));C.onmouseleave=()=>{MX=-1;if(D)chart()};
document.addEventListener("click",async e=>{const b=e.target.closest("[data-a],[data-v],[data-r],[data-x],[data-b],[data-cb],[data-sell]");if(!b)return;const d=b.dataset;
if(d.a)return ctl(d.a);if(d.b)return buyModal(d.b);if(d.cb){$("mo").style.display="none";return post({action:"buy",sym:d.cb})}
if(d.sell){if(confirm("Sell all "+d.sell+" now?"))post({action:"sell",sym:d.sell});return}
if(d.x){if(d.x==="close")$("mo").style.display="none";else if(d.x==="dis"){EMX=Date.now()+6e5;$("em").style.display="none"}else if(d.x==="acct")acct();else if(d.x==="csv")csv();else if(d.x==="lock"){if(!D.pin&&!D.pinset)return;if(LK){if(await pin())LK=false}else if(D.pinset&&!D.pin){await fetch("/api/pin",{method:"POST",headers:{"X-Requested-With":"dashboard"},body:JSON.stringify({lock:1})});await load();return}else{UNL=0;LK=true}render();extras()}else if(d.x==="out"){if(location.pathname.endsWith("dash.html")){sessionStorage.clear();location="./"}else location="/logout"}return}
if(d.v){V=d.v;if(d.s)SY=d.s;if(b.classList.contains("c")||b.classList.contains("tl"))$("ov").scrollIntoView({behavior:"smooth"})}if(d.r)RG=d.r;render()});
setInterval(()=>{$("ck").textContent=new Date().toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"})+" IST"},1000);
load();setInterval(load,location.pathname.endsWith("dash.html")?60000:1000);
</script></body></html>
`;

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 viewBox=%270 0 64 64%27%3E%3Crect width=%2764%27 height=%2764%27 rx=%2714%27 fill=%27%237c4dff%27/%3E%3Cpath d=%27M12 44 24 30l9 8 19-22%27 fill=%27none%27 stroke=%27%23fff%27 stroke-width=%276%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27/%3E%3C/svg%3E"><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#05060d;color:#eef;overflow:hidden}
#v,#c{position:fixed;inset:0;width:100%;height:100%;object-fit:cover}
.s{position:fixed;inset:0;background:radial-gradient(circle at 50% 45%,rgba(5,6,13,.25),rgba(5,6,13,.9))}
.card{position:relative;width:min(370px,90vw);padding:30px 26px;border-radius:18px;background:rgba(14,18,34,.55);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.14);box-shadow:0 0 60px rgba(255,60,60,.18),0 20px 60px rgba(0,0,0,.6);animation:fl 6s ease-in-out infinite alternate}
@keyframes fl{to{transform:translateY(-6px)}}.card.sk{animation:shake .5s}@keyframes shake{20%{transform:translateX(-10px)}40%{transform:translateX(10px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}
h1{margin:0 0 4px;font-size:24px}p{margin:0 0 20px;color:#9aa6bd;font-size:14px}
input{width:100%;padding:13px 14px;margin-bottom:12px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.07);color:inherit;font-size:16px;outline:none}input:focus{border-color:#ff5d6c}
button{width:100%;padding:13px;border:0;border-radius:10px;background:linear-gradient(135deg,#ff3d54,#3d7bff);color:#fff;font-size:16px;font-weight:600}
#m{min-height:20px;margin-top:12px;color:#ff8a95;font-size:14px;text-align:center}
</style></head><body>
<video id="v" autoplay muted loop playsinline src="/bg.mp4"></video><canvas id="c"></canvas><div class="s"></div>
<div class="card"><h1>📈 Trading Console</h1><p>Secure access to your trading desk.</p>
<input id="u" placeholder="Username" autocomplete="username"><input id="p" type="password" placeholder="Password" autocomplete="current-password">
<button id="b">Sign in</button><div id="m"></div><p style="margin:14px 0 0;text-align:center;font-size:13px"><a href="#" id="fp" style="color:#9aa6bd">Forgot password?</a></p><div id="rs" style="display:none;margin-top:12px"><input id="o" placeholder="6-digit code from email" inputmode="numeric"><input id="np" type="password" placeholder="New password (12+ characters)"><button id="rb">Reset password</button></div></div>
<script>
const v=document.getElementById("v"),cv=document.getElementById("c"),x=cv.getContext("2d");
v.onerror=()=>v.remove();v.onplaying=()=>{cv.style.display="none"};
let W,H,T=0;function rz(){W=cv.width=innerWidth;H=cv.height=innerHeight}rz();onresize=rz;
const N=(a,b)=>Math.sin(a*1.7+1)*Math.cos(b*1.3)+Math.sin(a*.6+b*.8)*.8+Math.cos(a*2.3-b*1.9)*.4;
function scr(cx,cy,sw,sh,sk,fn){x.save();x.translate(cx,cy);x.transform(1,sk,0,1,0,0);x.fillStyle="rgba(8,12,28,.78)";x.strokeStyle="rgba(120,160,255,.55)";x.lineWidth=2;x.shadowColor="rgba(90,130,255,.7)";x.shadowBlur=26;x.fillRect(-sw/2,-sh/2,sw,sh);x.strokeRect(-sw/2,-sh/2,sw,sh);x.shadowBlur=0;x.beginPath();x.rect(-sw/2+8,-sh/2+8,sw-16,sh-16);x.clip();x.translate(-sw/2+8,-sh/2+8);fn(sw-16,sh-16);x.restore()}
function map(w,h){for(let i=0;i<w;i+=9)for(let j=0;j<h;j+=9)if(N(i*.03,j*.04)>.15){x.fillStyle="rgba(255,"+(90+60*Math.sin(T+i))+",90,.75)";x.fillRect(i,j,3,3)}
for(let k=0;k<7;k++){const px=(k*97%w),py=(k*53%h),r=4+4*Math.abs(Math.sin(T*2+k));x.strokeStyle="rgba(255,70,70,.9)";x.beginPath();x.arc(px,py,r,0,7);x.stroke()}
for(let i=0;i<40;i++){const hh=10+30*Math.abs(Math.sin(i*.7+T));x.fillStyle="rgba(255,80,80,.5)";x.fillRect(i*(w/40),h-hh,w/60,hh)}}
function lines(w,h){x.strokeStyle="#4d8dff";x.lineWidth=2;x.beginPath();for(let i=0;i<w;i+=4){const y=h*.5+Math.sin(i*.04+T)*h*.2+Math.sin(i*.11-T*2)*h*.1;i?x.lineTo(i,y):x.moveTo(i,y)}x.stroke();
for(let i=0;i<24;i++){const hh=8+h*.3*Math.abs(Math.sin(i*.5+T*.7));x.fillStyle="rgba(77,141,255,.5)";x.fillRect(i*(w/24)+2,h-hh,w/30,hh)}}
function candles(w,h){let p=h/2;for(let i=0;i<w/10;i++){const o=p,c=h/2+Math.sin(i*.35+T)*h*.25+Math.sin(i*1.3)*h*.08,up=c<o;p=c;x.strokeStyle=x.fillStyle=up?"#26d9a0":"#ff4d5e";x.beginPath();x.moveTo(i*10+4,Math.min(o,c)-8);x.lineTo(i*10+4,Math.max(o,c)+8);x.stroke();x.fillRect(i*10,Math.min(o,c),8,Math.max(3,Math.abs(o-c)))}}
(function f(){T+=.02;x.clearRect(0,0,W,H);const g=x.createRadialGradient(W*.15,H*.4,0,W*.15,H*.4,W*.5);g.addColorStop(0,"rgba(255,50,60,.22)");g.addColorStop(1,"rgba(0,0,0,0)");x.fillStyle=g;x.fillRect(0,0,W,H);
const g2=x.createRadialGradient(W*.85,H*.4,0,W*.85,H*.4,W*.5);g2.addColorStop(0,"rgba(50,100,255,.25)");g2.addColorStop(1,"rgba(0,0,0,0)");x.fillStyle=g2;x.fillRect(0,0,W,H);
const u=Math.min(W,1100)/1100;scr(W*.5,H*.36,560*u,300*u,0,map);scr(W*.5-420*u,H*.4,260*u,230*u,.14,lines);scr(W*.5+420*u,H*.4,260*u,230*u,-.14,candles);
for(let r=0;r<3;r++)for(let i=0;i<26;i++){const a=.35+.5*Math.abs(Math.sin(T*2+i*.7+r));x.fillStyle="rgba(255,60,60,"+a+")";x.shadowColor="red";x.shadowBlur=12;x.fillRect(W*.5-330*u+i*26*u,H*.72+r*34*u,16*u,10*u)}x.shadowBlur=0;requestAnimationFrame(f)})();
async function go(){const m=document.getElementById("m");m.textContent="";
const r=await fetch("/login",{method:"POST",body:JSON.stringify({u:document.getElementById("u").value,p:document.getElementById("p").value})});
if(r.ok)location="/";else{m.textContent=await r.text();const cd=document.querySelector(".card");cd.classList.remove("sk");void cd.offsetWidth;cd.classList.add("sk")}}
document.getElementById("fp").onclick=async e=>{e.preventDefault();const m=document.getElementById("m"),r=await fetch("/forgot",{method:"POST"}).catch(()=>null);if(!r||![200,429,501].includes(r.status)){alert("On this web page, reset the login by changing DASH_USER / DASH_PASS in your GitHub Secrets, then run the workflow again.");return}m.textContent=await r.text();if(r.ok)document.getElementById("rs").style.display="block"};
document.getElementById("rb").onclick=async()=>{const m=document.getElementById("m"),r=await fetch("/reset",{method:"POST",body:JSON.stringify({otp:document.getElementById("o").value,pass:document.getElementById("np").value})});m.textContent=await r.text();if(r.ok)document.getElementById("rs").style.display="none"};
document.getElementById("b").onclick=go;document.getElementById("p").onkeydown=e=>{if(e.key==="Enter")go()};
</script></body></html>
`;

const sessions = new Map();
const SEC = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "X-Frame-Options": "DENY", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'" };
// ---------- SECURITY HELPERS ----------
const otp = { hash: null, exp: 0, tries: 0, sent: [] };
const sha = (v) => crypto.createHash("sha256").update(String(v)).digest("hex");
const unlocked = new Map(), pinFails = new Map();
const redact = (o) => ({ ...o, equity: 0, cash: 0, pnl: 0, positions: [], trades: [], ledger: [], history: [], stats: {}, head: "", ntr: 0, locked: true });
async function sendOtp() {
  otp.sent = otp.sent.filter((t) => Date.now() - t < 3600e3);
  if (otp.sent.length >= 3) return false;
  S.pinSalt = S.pinSalt || crypto.randomBytes(8).toString("hex");
  const code = String(crypto.randomInt(100000, 1000000));
  otp.hash = sha(code + S.pinSalt); otp.exp = Date.now() + 600000; otp.tries = 0; otp.sent.push(Date.now());
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: "Bearer " + E.RESEND_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: "Trading Bot <onboarding@resend.dev>", to: [E.OWNER_EMAIL], subject: "Your dashboard reset code",
        text: `Your code is ${code}. It expires in 10 minutes. If you did not ask for it, ignore this email and change your password.` }),
    });
    return r.ok;
  } catch { return false; }
}
const fails = new Map();
const hash = (v) => crypto.createHash("sha256").update(String(v)).digest();
const sameCreds = (u, p) => {
  const okU = crypto.timingSafeEqual(hash(u), hash(DASH_USER));
  if (S.auth) return okU && crypto.timingSafeEqual(crypto.scryptSync(String(p), S.auth.salt, 32), Buffer.from(S.auth.hash, "hex"));
  return okU && crypto.timingSafeEqual(hash(p), hash(DASH_PASS));
};

function startDashboard() {
  if (!DASH_PASS || DASH_PASS.length < 12) { log("DASH_PASS missing or under 12 chars -> dashboard disabled"); return; }
  http.createServer((req, res) => {
    const ip = req.socket.remoteAddress;
    const sid = (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === "sid")?.[1];
    const authed = sid && sessions.get(sid) > Date.now();
    const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type, ...SEC }); res.end(body); };
    const readBody = (cb) => {
      let body = "";
      req.on("data", (d) => { if (body.length < 1000) body += d; });
      req.on("end", () => { let c = {}; try { c = JSON.parse(body); } catch {} cb(c); });
    };

    if (req.url === "/login" && req.method === "GET") return send(200, "text/html; charset=utf-8", LOGIN);
    if (req.url === "/bg.mp4") {
      if (!fs.existsSync("bg.mp4")) return send(404, "text/plain", "no video");
      res.writeHead(200, { "Content-Type": "video/mp4" });
      return fs.createReadStream("bg.mp4").pipe(res);
    }
    if (req.url === "/login" && req.method === "POST") {
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (Date.now() < f.until) return send(429, "text/plain", "Too many attempts. Try in 15 minutes.");
      return readBody((c) => {
        if (sameCreds(c.u || "", c.p || "")) {
          fails.delete(ip);
          const t = crypto.randomBytes(32).toString("hex");
          sessions.set(t, Date.now() + 12 * 3600e3);
          res.writeHead(200, { "Set-Cookie": `sid=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${req.headers["x-forwarded-proto"] === "https" ? "; Secure" : ""}` });
          return res.end("ok");
        }
        f.n++; if (f.n >= 5) { f.until = Date.now() + 15 * 60000; f.n = 0; }
        fails.set(ip, f);
        send(401, "text/plain", "Wrong username or password");
      });
    }

    if (req.url === "/forgot" && req.method === "POST") {
      if (!E.RESEND_KEY || !E.OWNER_EMAIL) return send(501, "text/plain", "Email reset is not set up (needs RESEND_KEY and OWNER_EMAIL).");
      return readBody(async () => { const ok = await sendOtp(); say("🔐 Password reset code requested."); send(ok ? 200 : 429, "text/plain", ok ? "Code sent to your registered email." : "Too many requests, or the email failed. Try later."); });
    }
    if (req.url === "/reset" && req.method === "POST") {
      return readBody((c) => {
        const f = fails.get("otp:" + ip) || { n: 0, until: 0 };
        if (Date.now() < f.until) return send(429, "text/plain", "Too many attempts. Try later.");
        const good = otp.hash && Date.now() < otp.exp && otp.tries < 5 && String(c.pass || "").length >= 12 && sha(String(c.otp || "") + S.pinSalt) === otp.hash;
        otp.tries++;
        if (!good) { f.n++; if (f.n >= 5) { f.until = Date.now() + 900000; f.n = 0; } fails.set("otp:" + ip, f); return send(400, "text/plain", "Invalid or expired code, or new password shorter than 12 characters."); }
        const salt = crypto.randomBytes(16).toString("hex");
        S.auth = { salt, hash: crypto.scryptSync(String(c.pass), salt, 32).toString("hex") };
        otp.hash = null; sessions.clear(); unlocked.clear(); save();
        say("🔐 Dashboard password was reset using the email code.");
        send(200, "text/plain", "Password changed. Sign in now.");
      });
    }
    if (req.url === "/logout") { sessions.delete(sid); res.writeHead(302, { "Set-Cookie": "sid=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict", Location: "/login" }); return res.end(); }
    if (!authed) {
      if (req.url.startsWith("/api/")) return send(401, "text/plain", "login required");
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }
    if (req.method === "POST" && req.url === "/api/control") {
      if (req.headers["x-requested-with"] !== "dashboard") return send(403, "text/plain", "blocked");
      return readBody(async (c) => {
        if (["golive", "buy", "sell"].includes(c.action) && E.DASH_PIN && !(unlocked.get(sid) > Date.now())) return send(403, "text/plain", "Unlock with your PIN first.");
        if (c.action === "pause") S.paused = true;
        else if (c.action === "resume") S.paused = false;
        else if (c.action === "auto" || c.action === "approve") S.mode = c.action;
        else if (c.action === "safe") await moveToSafe();
        else if (c.action === "buy") { const m = oneClickBuy(String(c.sym || "")); if (m !== "ok") return send(400, "text/plain", m); }
        else if (c.action === "sell") {
          const p = S.positions[String(c.sym || "")];
          if (!p) return send(400, "text/plain", "No such position.");
          sell(c.sym, LAST.px?.[c.sym] ?? p.avg, "dashboard");
        }
        else if (c.action === "golive") {
          if (E.LIVE_ENABLED !== "1") return send(400, "text/plain", "Set LIVE_ENABLED=1 in .env and restart first.");
          if (c.confirm !== "GO LIVE") return send(400, "text/plain", "Confirmation missing.");
          try { await aoLogin(); } catch (e) { return send(400, "text/plain", "Angel One login failed: " + e.message); }
          goLive(); say(`🔴 LIVE MODE ON. Bot capital ${rs(CFG.liveCapital)}, max ${rs(CFG.liveMaxPerTrade)} per trade. Approve mode.`);
        }
        else if (c.action === "paper") { goPaper(); say("Back to paper mode."); }
        else if (c.action === "killswitch") { S.paused = true; S.mode = "approve"; await moveToSafe(); }
        else return send(400, "text/plain", "bad action");
        save(); say("Dashboard action: " + c.action);
        send(200, "text/plain", "ok");
      });
    }
    if (req.method === "POST" && req.url === "/api/pin") {
      if (req.headers["x-requested-with"] !== "dashboard") return send(403, "text/plain", "blocked");
      return readBody((c) => {
        if (!E.DASH_PIN) return send(400, "text/plain", "No PIN is set.");
        if (c.lock) { unlocked.delete(sid); return send(200, "text/plain", "locked"); }
        const f = pinFails.get(sid) || { n: 0, until: 0 };
        if (Date.now() < f.until) return send(429, "text/plain", "Too many wrong PINs. Wait 10 minutes.");
        if (crypto.timingSafeEqual(hash(c.pin || ""), hash(E.DASH_PIN))) { pinFails.delete(sid); unlocked.set(sid, Date.now() + 300000); return send(200, "text/plain", "ok"); }
        f.n++; if (f.n >= 3) { f.until = Date.now() + 600000; f.n = 0; }
        pinFails.set(sid, f); log("wrong PIN attempt");
        send(401, "text/plain", "Wrong PIN");
      });
    }
    if (req.url === "/api/state") {
      const st = apiState(), open = !E.DASH_PIN || unlocked.get(sid) > Date.now();
      return send(200, "application/json", JSON.stringify(open ? st : redact(st)));
    }
    send(200, "text/html; charset=utf-8", PAGE);
  }).listen(DASH_PORT, DASH_HOST, () => log(`Dashboard: http://${DASH_HOST}:${DASH_PORT}`));
}

// ---------- GITHUB ACTIONS MODE (ONCE=1): one short run, state kept in Actions cache ----------
async function sendDashboardFile() {
  const state = JSON.stringify(apiState()).replace(/</g, "\\u003c");
  const stub = `<script>const STATE=${state};const _f=window.fetch;window.fetch=(u,o)=>u==="/api/state"?Promise.resolve({status:200,json:()=>Promise.resolve(STATE)}):_f(u,o);</script>`;
  const fd = new FormData();
  fd.append("chat_id", CHAT_ID);
  fd.append("caption", "Dashboard snapshot - open this file in your browser. " + statusText().split("\n")[0]);
  fd.append("document", new Blob([PAGE.replace("<body>", () => "<body>" + stub)], { type: "text/html" }), "dashboard.html");
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: "POST", body: fd }).then((x) => x.json()).catch(() => null);
  if (!r || !r.ok) await say("Could not send the dashboard file.");
}

async function once() {
  if (S.snap) LAST = { ...LAST, ...S.snap };
  const due = !S.lastCycle || Date.now() - S.lastCycle > (CFG.scanEveryMin - 2) * 60000;
  if (due && marketOpen()) { await runCycle(); S.lastCycle = Date.now(); }
  await tick();
  S.snap = { stocks: LAST.stocks.slice(0, 10), regimeNote: LAST.regimeNote, time: LAST.time, regime: LAST.regime, safe: LAST.safe, px: LAST.px, nc: LAST.nc, nifty: LAST.nifty, vix: LAST.vix, npc: LAST.npc, all: LAST.all, pxAt: LAST.pxAt, src: LAST.src };
  const r = await tg("getUpdates", { timeout: 0, offset: S.tgOffset || 0 });
  for (const u of r.result || []) { S.tgOffset = u.update_id + 1; await handleUpdate(u); }
  writeSite();
  save();
}

// ---------- GITHUB PAGES SITE (encrypted data + password login, all in the browser) ----------
const STUB = `const u8=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));let K;
async function st(){const j=sessionStorage.getItem("k");if(!j)throw 0;
K=K||await crypto.subtle.importKey("jwk",JSON.parse(j),{name:"AES-GCM"},false,["decrypt"]);
const d=await(await fetch("data.json?t="+Date.now())).json();
return JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:"AES-GCM",iv:u8(d.i)},K,u8(d.c))))}
const _f=window.fetch;window.fetch=(u,o)=>u==="/api/state"?st().then(s=>({status:200,json:()=>s})).catch(()=>({status:401})):u==="/api/control"?Promise.resolve({ok:false,status:403,text:()=>Promise.resolve("Controls work in Telegram only on this web page.")}):_f(u,o);`;
const STATIC_LOGIN_JS = `const u8=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
window.staticLogin=async(us,pw)=>{try{const d=await(await fetch("data.json?t="+Date.now())).json();
const m=await crypto.subtle.importKey("raw",new TextEncoder().encode(us+":"+pw),"PBKDF2",false,["deriveKey"]);
const k=await crypto.subtle.deriveKey({name:"PBKDF2",salt:u8(d.s),iterations:200000,hash:"SHA-256"},m,{name:"AES-GCM",length:256},true,["decrypt"]);
await crypto.subtle.decrypt({name:"AES-GCM",iv:u8(d.i)},k,u8(d.c));
sessionStorage.setItem("k",JSON.stringify(await crypto.subtle.exportKey("jwk",k)));location="dash.html";return{ok:true}}
catch(e){return{ok:false,text:async()=>"Wrong password, or no data yet. Wait for the first bot run."}}};`;
const LOGIN_STATIC = LOGIN
  .replace('fetch("/login",{method:"POST",body:JSON.stringify({u:document.getElementById("u").value,p:document.getElementById("p").value})})', 'window.staticLogin(document.getElementById("u").value.trim(),document.getElementById("p").value)')
  .replace('if(r.ok)location="/";', "if(r.ok){}")
  .replace("</body>", () => "<script>" + STATIC_LOGIN_JS + "</script></body>");

function writeSite() {
  if (!E.DASH_PASS || E.DASH_PASS.length < 12) return log("DASH_PASS (12+ chars) missing: web page skipped");
  S.siteSalt = S.siteSalt || crypto.randomBytes(16).toString("base64");
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync((E.DASH_USER || "admin") + ":" + E.DASH_PASS, Buffer.from(S.siteSalt, "base64"), 200000, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(apiState(true)), "utf8"), c.final(), c.getAuthTag()]);
  fs.mkdirSync("site", { recursive: true });
  fs.writeFileSync("site/data.json", JSON.stringify({ s: S.siteSalt, i: iv.toString("base64"), c: ct.toString("base64") }));
  fs.writeFileSync("site/dash.html", PAGE.replace('location="/login"', 'location="./"').replace("<body>", () => "<body><script>" + STUB + "</script>"));
  fs.writeFileSync("site/index.html", LOGIN_STATIC);
  fs.writeFileSync("site/.nojekyll", "");
}

// ---------- START ----------
(async function main() {
  if (!TG_TOKEN || !CHAT_ID) { console.error("Set TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in .env"); process.exit(1); }
  if (S.live && E.LIVE_ENABLED !== "1") goPaper(); // safety: never resume live by accident
  if (E.ONCE === "1") {
    try { await once(); } catch (e) { log("once error", e.message); save(); }
    await sleep(3000);
    process.exit(0);
  }
  startDashboard();
  await say(`🚀 Trading assistant started. Dashboard: ${E.DASH_URL || "http://localhost:" + DASH_PORT}\nSend /help`);
  pollTelegram();
  await runCycle();
  setInterval(runCycle, CFG.scanEveryMin * 60 * 1000);
  setInterval(tick, E.ANGEL_API_KEY && E.ONCE !== "1" ? 5000 : 20000);
})();
