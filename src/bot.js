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
  watchlist: ["RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK", "SBIN", "BHARTIARTL",
    "ITC", "LT", "HINDUNILVR", "KOTAKBANK", "AXISBANK", "MARUTI", "SUNPHARMA",
    "BAJFINANCE", "TITAN", "NTPC"],
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
  const close = [], vol = [];
  q.close.forEach((c, i) => { if (c != null) { close.push(c); vol.push(q.volume[i] || 0); } });
  return { close, vol };
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
  return { regime, price, vix, note };
}

async function analyseStock(sym) {
  const { close, vol } = await candles(sym + ".NS");
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
  return { sym, price, s20, s50, rsi: r, mom, score, outlook };
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

// ---------- LIVE TICK (every minute: fresh prices + graph points) ----------
async function tick() {
  if (!marketOpen()) return;
  try {
    LAST.px = LAST.px || {};
    for (const sym of Object.keys(S.positions)) LAST.px[sym] = (await candles(sym + ".NS")).close.at(-1);
    const n = (await candles("^NSEI")).close.at(-1);
    S.nh = [...(S.nh || []).slice(-1499), n];
    S.history = [...(S.history || []).slice(-1499), { t: Date.now(), e: equity() }];
    save();
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
    LAST = { time: new Date().toISOString(), nifty: m.price, vix: m.vix, regimeNote: m.note, stocks, regime: m.regime };
    try { LAST.safe = (await candles(CFG.safeAsset + ".NS")).close.at(-1); } catch {}

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
function apiState() {
  const eq = equity();
  return {
    equity: eq, cash: S.cash, pnl: eq - (S.live ? CFG.liveCapital : CFG.startingCash), mode: S.mode, paused: S.paused,
    regime: S.regime, live: !!S.live, note: LAST.regimeNote, updated: LAST.time,
    positions: Object.entries(S.positions).map(([sym, p]) => {
      const px = LAST.px?.[sym] ?? (sym === CFG.safeAsset ? LAST.safe : LAST.stocks.find((x) => x.sym === sym)?.price) ?? p.avg;
      return { sym, qty: p.qty, avg: p.avg, px, pnl: (px - p.avg) * p.qty, sl: p.avg * (1 - CFG.stopLossPct) };
    }),
    history: (S.history || []).slice(-300).map((x) => x.e), nh: (S.nh || []).slice(-300), alerts: (S.alerts || []).slice(-10).reverse(),
    stocks: LAST.stocks.slice(0, 10), trades: S.trades.slice(-15).reverse(),
  };
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trading Console</title><style>
:root{--fg:#e8ecf4;--mut:#9aa6bd;--up:#26a69a;--down:#ef5350}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#070b14;color:var(--fg);font-family:system-ui,sans-serif;padding:14px;overflow-x:hidden}
.o{position:fixed;border-radius:50%;filter:blur(90px);opacity:.45;z-index:-1;animation:dr 14s ease-in-out infinite alternate}
.o1{width:380px;height:380px;background:#1e88e5;top:-80px;left:-80px}.o2{width:340px;height:340px;background:#26a69a;bottom:-60px;right:-60px;animation-delay:-6s}
@keyframes dr{to{transform:translate(60px,40px) scale(1.15)}}
.g{background:rgba(255,255,255,.07);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.14);border-radius:18px;padding:14px;box-shadow:0 10px 40px rgba(0,0,0,.35);transition:transform .25s}
.g:hover{transform:translateY(-3px)}
.grid{display:grid;gap:12px;margin-bottom:12px}.tiles{grid-template-columns:repeat(auto-fit,minmax(140px,1fr))}.two{grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.08em}.v{font-size:22px;font-weight:700;margin-top:4px}
canvas{width:100%;height:190px;display:block}.up{color:var(--up)}.down{color:var(--down)}h3{margin:0 0 10px;font-size:15px}
table{width:100%;border-collapse:collapse;font-size:13px}th{color:var(--mut);font-weight:500;text-align:left}td,th{padding:6px;border-bottom:1px solid rgba(255,255,255,.07);white-space:nowrap}
.w{overflow-x:auto}button{padding:9px 14px;border:0;border-radius:10px;background:rgba(255,255,255,.14);color:#fff;font-size:14px;margin:2px}button:hover{background:rgba(255,255,255,.25)}
.live{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--up);margin-right:6px;animation:p 1.2s infinite}@keyframes p{50%{opacity:.25;transform:scale(1.5)}}
.sh{animation:sk .6s}@keyframes sk{20%{transform:translateX(-8px)}40%{transform:translateX(8px)}60%{transform:translateX(-5px)}80%{transform:translateX(5px)}}
</style></head><body><div class="o o1"></div><div class="o o2"></div>
<h2 style="margin:4px 0 12px"><span class="live"></span>Trading Console <small id="md" style="color:var(--mut);font-weight:400"></small></h2>
<div class="grid tiles" id="t"></div>
<div class="grid two"><div class="g"><h3>Account equity (live)</h3><canvas id="e"></canvas></div><div class="g"><h3>Nifty 50 (live)</h3><canvas id="n"></canvas></div></div>
<div class="grid two"><div class="g"><h3>Where your money is</h3><canvas id="a"></canvas><div id="lg" style="font-size:12px;margin-top:8px"></div></div><div class="g"><h3>Controls</h3><div id="c"></div><p id="ml"></p></div></div>
<div class="g w" style="margin-bottom:12px"><h3>Holdings</h3><div id="p"></div></div>
<div class="grid two"><div class="g w"><h3>Top stocks and outlook</h3><div id="s"></div></div><div class="g w"><h3>Recent trades</h3><div id="tr"></div></div></div>
<div class="g"><h3>Alerts</h3><div id="al"></div></div>
<script>
const f=n=>"₹"+Number(n).toLocaleString("en-IN",{maximumFractionDigits:0}),cl=n=>n>=0?"up":"down",$=id=>document.getElementById(id);
const COLS=["#26a69a","#1e88e5","#ffb300","#ab47bc","#ef5350","#8d6e63","#26c6da","#9ccc65"];let prev=null;
function setup(c){const d=devicePixelRatio||1,w=c.clientWidth,h=c.clientHeight;c.width=w*d;c.height=h*d;const x=c.getContext("2d");x.scale(d,d);return[x,w,h]}
function line(id,pts,col){const[x,w,h]=setup($(id));if(pts.length<2){x.fillStyle="#9aa6bd";x.fillText("Collecting live data...",12,24);return}
const mn=Math.min(...pts),mx=Math.max(...pts),r=(mx-mn)||1,X=i=>i*(w-8)/(pts.length-1)+4,Y=v=>h-14-(v-mn)/r*(h-28);
const g=x.createLinearGradient(0,0,0,h);g.addColorStop(0,col+"66");g.addColorStop(1,col+"00");
x.beginPath();pts.forEach((v,i)=>i?x.lineTo(X(i),Y(v)):x.moveTo(X(i),Y(v)));x.strokeStyle=col;x.lineWidth=2.5;x.stroke();
x.lineTo(X(pts.length-1),h);x.lineTo(X(0),h);x.fillStyle=g;x.fill();
x.beginPath();x.arc(X(pts.length-1),Y(pts[pts.length-1]),4,0,7);x.fillStyle=col;x.fill();
x.fillStyle="#9aa6bd";x.font="11px system-ui";x.fillText(Math.round(mx).toLocaleString("en-IN"),6,12);x.fillText(Math.round(mn).toLocaleString("en-IN"),6,h-2)}
function donut(id,parts){const[x,w,h]=setup($(id)),tot=parts.reduce((a,b)=>a+b.v,0)||1,cx=w/2,cy=h/2,R=Math.min(w,h)/2-8;let a0=-Math.PI/2;
parts.forEach((p,i)=>{const a=p.v/tot*Math.PI*2;x.beginPath();x.arc(cx,cy,R,a0,a0+a);x.arc(cx,cy,R*.6,a0+a,a0,true);x.closePath();x.fillStyle=COLS[i%8];x.fill();a0+=a});
x.fillStyle="#e8ecf4";x.textAlign="center";x.font="600 15px system-ui";x.fillText(f(tot),cx,cy+5)}
const tbl=(h,rows)=>'<table><tr>'+h.map(a=>'<th>'+a+'</th>').join("")+'</tr>'+rows.map(r=>'<tr>'+r.map(a=>'<td>'+a+'</td>').join("")+'</tr>').join("")+'</table>';
async function load(){const r=await fetch("/api/state");if(r.status===401){location="/login";return}const s=await r.json();
const inv=s.positions.reduce((a,p)=>a+p.qty*p.avg,0),rc=s.regime=="BULLISH"?"up":s.regime=="BEARISH"?"down":"";
const tl=[["Equity",f(s.equity),""],["Cash",f(s.cash),""],["Invested",f(inv),""],["Total P/L",f(s.pnl),cl(s.pnl)],["Market",s.regime,rc],["Mode",s.live?"🔴 LIVE":"Paper",""]];
$("t").innerHTML=tl.map(a=>'<div class="g"><div class="k">'+a[0]+'</div><div class="v '+a[2]+'">'+a[1]+'</div></div>').join("");
if(prev!==null&&s.equity<prev)$("t").firstChild.classList.add("sh");prev=s.equity;
$("md").textContent=s.note+" | updated "+(s.updated?new Date(s.updated).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata"}):"-");
line("e",s.history,s.pnl>=0?"#26a69a":"#ef5350");line("n",s.nh,"#1e88e5");
const parts=[{n:"Cash",v:s.cash}].concat(s.positions.map(p=>({n:p.sym,v:p.qty*p.px})));donut("a",parts);
$("lg").innerHTML=parts.map((p,i)=>'<span style="margin-right:10px"><span style="color:'+COLS[i%8]+'">●</span> '+p.n+' '+f(p.v)+'</span>').join("");
$("p").innerHTML=s.positions.length?tbl(["Stock","Qty","Avg buy","Now","Invested","Value","P/L","P/L %","Stop-loss"],s.positions.map(p=>[p.sym,p.qty,f(p.avg),f(p.px),f(p.qty*p.avg),f(p.qty*p.px),'<span class="'+cl(p.pnl)+'">'+f(p.pnl)+'</span>','<span class="'+cl(p.pnl)+'">'+((p.px/p.avg-1)*100).toFixed(1)+'%</span>',f(p.sl)])):"No open positions yet.";
$("s").innerHTML=tbl(["Stock","Price","Score","Outlook","News"],s.stocks.map(p=>[p.sym,f(p.price),p.score+"/6",p.outlook,p.news?p.news.n:"-"]));
$("tr").innerHTML=tbl(["Time","Side","Stock","Qty","Price","Why"],s.trades.map(t=>[t.t.slice(5,16).replace("T"," "),t.side,t.sym,t.qty,f(t.price),t.why]));
$("al").innerHTML=s.alerts.map(a=>'<div style="padding:3px 0">'+new Date(a.t).toLocaleTimeString("en-IN",{timeZone:"Asia/Kolkata",hour:"2-digit",minute:"2-digit"})+" "+a.m.replace(/</g,"&lt;")+'</div>').join("");
$("ml").innerHTML="Mode: <b>"+(s.live?"🔴 LIVE (real money)":"Paper")+"</b> | "+s.mode+(s.paused?" (PAUSED)":"")}
$("c").innerHTML='<button data-a="pause">Pause</button><button data-a="resume">Resume</button><button data-a="auto">Auto</button><button data-a="approve">Approve</button><button data-a="safe">Move to Safe</button><button data-a="killswitch" style="background:#c62828">KILL SWITCH</button><br><button data-a="golive">Go Live</button><button data-a="paper">Back to Paper</button>';
async function ctl(a){const b={action:a};if(a==="golive"){const t=prompt("REAL MONEY. Type GO LIVE to confirm:");if(t!=="GO LIVE")return;b.confirm=t}const r=await fetch("/api/control",{method:"POST",headers:{"X-Requested-With":"dashboard"},body:JSON.stringify(b)});if(!r.ok)alert(await r.text());load()}
document.addEventListener("click",e=>{const a=e.target.dataset.a;if(a)ctl(a)});
load();setInterval(load,5000);
</script></body></html>`;

const LOGIN = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><style>
*{box-sizing:border-box}body{margin:0;height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#070b14;color:#e8ecf4;overflow:hidden}
#v,#c{position:fixed;inset:0;width:100%;height:100%;object-fit:cover}#c{opacity:.55}
.s{position:fixed;inset:0;background:radial-gradient(circle at 50% 40%,rgba(7,11,20,.2),rgba(7,11,20,.9))}
.card{position:relative;width:min(380px,90vw);padding:32px 28px;border-radius:18px;background:rgba(18,24,38,.6);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px);border:1px solid rgba(255,255,255,.12);box-shadow:0 20px 60px rgba(0,0,0,.5)}
h1{margin:0 0 4px;font-size:24px}p{margin:0 0 22px;color:#9aa6bd;font-size:14px}
input{width:100%;padding:13px 14px;margin-bottom:12px;border-radius:10px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.07);color:inherit;font-size:16px;outline:none}
input:focus{border-color:#26a69a}
button{width:100%;padding:13px;border:0;border-radius:10px;background:linear-gradient(135deg,#26a69a,#1e88e5);color:#fff;font-size:16px;font-weight:600}
.card{animation:fl 6s ease-in-out infinite alternate}@keyframes fl{to{transform:translateY(-6px)}}
.card.sk{animation:shake .5s}@keyframes shake{20%{transform:translateX(-10px)}40%{transform:translateX(10px)}60%{transform:translateX(-6px)}80%{transform:translateX(6px)}}
#m{min-height:20px;margin-top:12px;color:#ef5350;font-size:14px;text-align:center}
</style></head><body>
<video id="v" autoplay muted loop playsinline src="/bg.mp4"></video><canvas id="c"></canvas><div class="s"></div>
<div class="card"><h1>📈 Trading Console</h1><p>Private access. Paper trading mode.</p>
<input id="u" placeholder="Username" autocomplete="username"><input id="p" type="password" placeholder="Password" autocomplete="current-password">
<button id="b">Sign in</button><div id="m"></div></div>
<script>
const v=document.getElementById("v"),cv=document.getElementById("c"),x=cv.getContext("2d");
v.onerror=()=>v.remove();v.onplaying=()=>{cv.style.display="none"};
let W,H;function rz(){W=cv.width=innerWidth;H=cv.height=innerHeight}rz();onresize=rz;
let pr=H/2;function mk(){const o=pr,c=o+(Math.random()-.5)*30;pr=Math.min(H*.8,Math.max(H*.2,c));return{o:o,c:c,h:Math.max(o,c)+Math.random()*12,l:Math.min(o,c)-Math.random()*12}}
const cs=[];for(let i=0;i<Math.ceil(W/14)+2;i++)cs.push(mk());
let off=0;(function f(){x.clearRect(0,0,W,H);off+=.6;if(off>=14){off=0;cs.shift();cs.push(mk())}
cs.forEach((k,i)=>{const px=i*14-off;x.strokeStyle=x.fillStyle=k.c<=k.o?"#26a69a":"#ef5350";x.beginPath();x.moveTo(px+4,k.h);x.lineTo(px+4,k.l);x.stroke();x.fillRect(px,Math.min(k.o,k.c),8,Math.max(2,Math.abs(k.c-k.o)))});requestAnimationFrame(f)})();
async function go(){const m=document.getElementById("m");m.textContent="";
const r=await fetch("/login",{method:"POST",body:JSON.stringify({u:document.getElementById("u").value,p:document.getElementById("p").value})});
if(r.ok)location="/";else{m.textContent=await r.text();const cd=document.querySelector(".card");cd.classList.remove("sk");void cd.offsetWidth;cd.classList.add("sk")}}
document.getElementById("b").onclick=go;document.getElementById("p").onkeydown=e=>{if(e.key==="Enter")go()};
</script></body></html>`;

const sessions = new Map();
const fails = new Map();
const hash = (v) => crypto.createHash("sha256").update(String(v)).digest();
const sameCreds = (u, p) => crypto.timingSafeEqual(hash(u), hash(DASH_USER)) & crypto.timingSafeEqual(hash(p), hash(DASH_PASS));

function startDashboard() {
  if (!DASH_PASS || DASH_PASS.length < 12) { log("DASH_PASS missing or under 12 chars -> dashboard disabled"); return; }
  http.createServer((req, res) => {
    const ip = req.socket.remoteAddress;
    const sid = (req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).find(([k]) => k === "sid")?.[1];
    const authed = sid && sessions.get(sid) > Date.now();
    const send = (code, type, body) => { res.writeHead(code, { "Content-Type": type }); res.end(body); };
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

    if (!authed) {
      if (req.url.startsWith("/api/")) return send(401, "text/plain", "login required");
      res.writeHead(302, { Location: "/login" });
      return res.end();
    }
    if (req.method === "POST" && req.url === "/api/control") {
      if (req.headers["x-requested-with"] !== "dashboard") return send(403, "text/plain", "blocked");
      return readBody(async (c) => {
        if (c.action === "pause") S.paused = true;
        else if (c.action === "resume") S.paused = false;
        else if (c.action === "auto" || c.action === "approve") S.mode = c.action;
        else if (c.action === "safe") await moveToSafe();
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
    if (req.url === "/api/state") return send(200, "application/json", JSON.stringify(apiState()));
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
  S.snap = { stocks: LAST.stocks.slice(0, 10), regimeNote: LAST.regimeNote, time: LAST.time, regime: LAST.regime, safe: LAST.safe, px: LAST.px };
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
window.staticLogin=async pw=>{try{const d=await(await fetch("data.json?t="+Date.now())).json();
const m=await crypto.subtle.importKey("raw",new TextEncoder().encode(pw),"PBKDF2",false,["deriveKey"]);
const k=await crypto.subtle.deriveKey({name:"PBKDF2",salt:u8(d.s),iterations:200000,hash:"SHA-256"},m,{name:"AES-GCM",length:256},true,["decrypt"]);
await crypto.subtle.decrypt({name:"AES-GCM",iv:u8(d.i)},k,u8(d.c));
sessionStorage.setItem("k",JSON.stringify(await crypto.subtle.exportKey("jwk",k)));location="dash.html";return{ok:true}}
catch(e){return{ok:false,text:async()=>"Wrong password, or no data yet. Wait for the first bot run."}}};`;
const LOGIN_STATIC = LOGIN
  .replace('fetch("/login",{method:"POST",body:JSON.stringify({u:document.getElementById("u").value,p:document.getElementById("p").value})})', 'window.staticLogin(document.getElementById("p").value)')
  .replace('if(r.ok)location="/";', "if(r.ok){}")
  .replace('<input id="u" placeholder="Username" autocomplete="username">', '<input id="u" type="hidden">')
  .replace("</body>", () => "<script>" + STATIC_LOGIN_JS + "</script></body>");

function writeSite() {
  if (!E.DASH_PASS || E.DASH_PASS.length < 12) return log("DASH_PASS (12+ chars) missing: web page skipped");
  S.siteSalt = S.siteSalt || crypto.randomBytes(16).toString("base64");
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(E.DASH_PASS, Buffer.from(S.siteSalt, "base64"), 200000, 32, "sha256");
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(JSON.stringify(apiState()), "utf8"), c.final(), c.getAuthTag()]);
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
  setInterval(tick, 60000);
})();
