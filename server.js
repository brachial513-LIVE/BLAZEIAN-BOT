const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ===============================
// CONFIG
// ===============================
const CHANNEL_ID    = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_NAME      = "blazeian_bot";
const CLIENT_ID     = process.env.BLAZE_CLIENT_ID;
const CLIENT_SECRET = process.env.BLAZE_CLIENT_SECRET;
const REDIRECT_URI  = "https://blazeian-bot.onrender.com/callback";

// ===============================
// TOKEN STATE
// ===============================
let ACCESS_TOKEN  = process.env.BLAZE_ACCESS_TOKEN  || null;
let REFRESH_TOKEN = process.env.BLAZE_REFRESH_TOKEN || null;

// PKCE state (nur für Login-Flow nötig)
let pendingState        = null;
let pendingCodeVerifier = null;

// ===============================
// TOKEN REFRESH
// ===============================
async function refreshAccessToken() {
  if (!REFRESH_TOKEN) {
    console.log("Kein Refresh Token – manueller Login nötig unter /login");
    return false;
  }
  try {
    const res = await axios.post("https://blaze.stream/bapi/oauth2/refresh", {
      clientId:     CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN
    });
    ACCESS_TOKEN  = res.data.accessToken;
    REFRESH_TOKEN = res.data.refreshToken || REFRESH_TOKEN;
    console.log("Token refreshed ✅");
    return true;
  } catch (e) {
    console.log("Token refresh error:", e.response?.data || e.message);
    return false;
  }
}

// Alle 20 Stunden Token erneuern (läuft 24h)
setInterval(refreshAccessToken, 20 * 60 * 60 * 1000);

// ===============================
// STATS
// ===============================
const STATS_FILE = path.join(__dirname, "stats.json");

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE))
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
  } catch (e) { console.log("Stats load error:", e.message); }
  return { totalVotes: 0, totalSubs: 0, totalChatMessages: 0, totalStreamMinutes: 0, emotes: {}, emoteNames: {} };
}

function saveStats() {
  try { fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2)); }
  catch (e) { console.log("Stats save error:", e.message); }
}

let stats = loadStats();
let timerRunning = false;

function startStreamTimer() {
  if (timerRunning) return;
  timerRunning = true;
  setInterval(() => { stats.totalStreamMinutes += 1; saveStats(); }, 60000);
}

function formatTime(m) {
  const h = Math.floor(m / 60), min = m % 60;
  return h === 0 ? `${min} Min` : `${h}h ${min}m`;
}

function getTopEmote() {
  const e = Object.entries(stats.emotes);
  if (!e.length) return "Noch keins";
  e.sort((a, b) => b[1] - a[1]);
  return `${stats.emoteNames[e[0][0]] || e[0][0]} (${e[0][1]}x)`;
}

// ===============================
// CHAT MEMORY
// ===============================
const chatMemory = [];

function detectLang(t = "") {
  t = t.toLowerCase();
  if (/[äöüß]/.test(t) || t.includes("hallo")) return "de";
  if (t.includes("hola") || t.includes("gracias")) return "es";
  if (t.includes("bonjour") || t.includes("merci")) return "fr";
  return "en";
}

// ===============================
// SEND CHAT
// ===============================
async function sendChat(message) {
  try {
    await axios.post(
      "https://api.blaze.stream/v1/chats/messages",
      { channelId: CHANNEL_ID, message },
      { headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "client-id": CLIENT_ID } }
    );
    console.log("BOT:", message);
  } catch (e) {
    if (e.response?.status === 401) {
      console.log("Token abgelaufen – refreshe...");
      const ok = await refreshAccessToken();
      if (ok) await sendChat(message);
    } else {
      console.log("Send error:", e.response?.data || e.message);
    }
  }
}

// ===============================
// SUBSCRIBE
// ===============================
async function subscribe(type) {
  try {
    await axios.post(
      "https://api.blaze.stream/v1/events/subscriptions",
      { type, version: "1", sessionId: global.SESSION_ID, condition: { channelId: CHANNEL_ID } },
      { headers: { authorization: `Bearer ${ACCESS_TOKEN}`, "client-id": CLIENT_ID } }
    );
    console.log("Subscribed:", type);
  } catch (e) {
    console.log("Subscribe error:", type, e.response?.data || e.message);
  }
}

// ===============================
// SOCKET
// ===============================
let socket = null;

function connectSocket() {
  if (socket) { try { socket.disconnect(); } catch(_) {} }

  socket = io("https://blaze.stream", { path: "/ws", transports: ["websocket"] });
  socket.on("connect", () => console.log("Socket connected ✅"));
  socket.on("connect_error", err => console.log("Socket error:", err.message));
  socket.on("eventsub", handleEvent);
}

// ===============================
// EVENT HANDLER
// ===============================
async function handleEvent(message) {
  const { metadata, payload } = message;

  // SESSION START
  if (metadata.messageType === "session_welcome") {
    global.SESSION_ID = payload.sessionId;
    console.log("SESSION:", global.SESSION_ID);
    if (ACCESS_TOKEN) {
      await sendChat("🤖 BlazeianBot ist online und trackt deine Stats!");
      startStreamTimer();
      setTimeout(() => {
        ["channel.chat.message","channel.follow","channel.subscription",
         "channel.vote","channel.stream.online","channel.stream.offline"]
          .forEach(t => subscribe(t));
      }, 2000);
    } else {
      console.log("Kein Token – bitte /login aufrufen");
    }
    return;
  }

  // CHAT
  if (metadata.subscriptionType === "channel.chat.message") {
    const user = payload.sender?.username;
    if (!user || user.toLowerCase() === BOT_NAME.toLowerCase()) return;

    const msg = typeof payload.message === "string" ? payload.message : payload.message?.text || "";
    if (!msg) return;

    console.log(`${user}: ${msg}`);
    stats.totalChatMessages++;
    saveStats();

    const emotes = payload.message?.emotes || payload.emotes || [];
    if (Array.isArray(emotes) && emotes.length) {
      emotes.forEach(em => {
        const id = em.id || em.emoteId, name = em.name || em.emoteName || id;
        if (id) { stats.emotes[id] = (stats.emotes[id] || 0) + 1; stats.emoteNames[id] = name; }
      });
      saveStats();
    }

    if (!msg.startsWith("!")) { chatMemory.push({ user, msg }); if (chatMemory.length > 10) chatMemory.shift(); }

    const m = msg.toLowerCase().trim();
    const lang = detectLang(msg);

    if (m === "!stats") {
      await sendChat(`📊 Stats | 🗳️ Votes: ${stats.totalVotes} | ⭐ Subs: ${stats.totalSubs} | 💬 Msgs: ${stats.totalChatMessages} | 🕐 Zeit: ${formatTime(stats.totalStreamMinutes)} | 🏆 Top Emote: ${getTopEmote()}`);
      return;
    }
    if (m === "!votes")  { await sendChat(`🗳️ Votes gesamt: ${stats.totalVotes}`); return; }
    if (m === "!subs")   { await sendChat(`⭐ Subs gesamt: ${stats.totalSubs}`); return; }
    if (m === "!chat")   { await sendChat(`💬 Chat-Msgs gesamt: ${stats.totalChatMessages}`); return; }
    if (m === "!time")   { await sendChat(`🕐 Stream-Zeit gesamt: ${formatTime(stats.totalStreamMinutes)}`); return; }
    if (m === "!emote")  { await sendChat(`🏆 Top Emote: ${getTopEmote()}`); return; }
    if (m === "!commands" || m === "!help") { await sendChat(`🤖 Commands: !stats | !votes | !subs | !chat | !time | !emote | !translate`); return; }
    if (m === "!join")   { await sendChat(`👋 Hey ${user}, ich bin bereits verbunden!`); return; }
    if (m.startsWith("!translate")) {
      const last = chatMemory.slice(-3);
      await sendChat(`🌍 Letzte Msgs: ${last.length ? last.map(x => `${x.user}: ${x.msg}`).join(" | ") : "Noch keine."}`);
      return;
    }
    if (m.includes("hi") || m.includes("hello") || m.includes("hallo")) {
      await sendChat(lang === "de" ? `Hallo ${user} 👋` : lang === "es" ? `¡Hola ${user} 👋` : lang === "fr" ? `Salut ${user} 👋` : `Hello ${user} 👋`);
      return;
    }
    return;
  }

  // SUB
  if (metadata.subscriptionType === "channel.subscription") {
    const user = payload.user?.username || payload.subscriber?.username || "jemand";
    stats.totalSubs++; saveStats();
    await sendChat(`⭐ ${user} hat gesubs! Danke! (Gesamt: ${stats.totalSubs})`);
    return;
  }

  // VOTE
  if (metadata.subscriptionType === "channel.vote") {
    const user = payload.user?.username || payload.voter?.username || "jemand";
    stats.totalVotes++; saveStats();
    await sendChat(`🗳️ ${user} hat gevoted! Danke! (Gesamt: ${stats.totalVotes})`);
    return;
  }

  if (metadata.subscriptionType === "channel.stream.online")  { startStreamTimer(); return; }
  if (metadata.subscriptionType === "channel.stream.offline") { saveStats(); return; }

  console.log("EVENT:", JSON.stringify(message, null, 2));
}

// ===============================
// OAUTH ROUTES – korrekter Blaze Flow
// ===============================

// SCHRITT 1: Auth-URL von Blaze generieren lassen
app.get("/login", async (req, res) => {
  try {
    const response = await axios.post("https://blaze.stream/bapi/oauth2/generate-auth-url", {
      clientId:     CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      redirectUri:  REDIRECT_URI,
      scopes: ["users.read", "offline.access", "channel.moderate", "users.bot"]
    });

    const { url, state, codeVerifier } = response.data;

    // Speichern für Callback-Validierung
    pendingState        = state;
    pendingCodeVerifier = codeVerifier;

    console.log("Auth URL generiert, leite weiter...");
    res.redirect(url);

  } catch (e) {
    console.log("Login error:", e.response?.data || e.message);
    res.send(`
      <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
        <h1>❌ Fehler beim Login</h1>
        <pre>${JSON.stringify(e.response?.data || e.message, null, 2)}</pre>
        <p>Prüfe ob BLAZE_CLIENT_ID und BLAZE_CLIENT_SECRET in Render korrekt gesetzt sind.</p>
        <p><a href="/login" style="color:#f5a623;">Nochmal versuchen</a></p>
      </body></html>
    `);
  }
});

// SCHRITT 2: Blaze leitet nach Login hierher zurück
app.get("/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code) return res.send("Fehler: Kein Code erhalten.");

  // State validieren
  if (state && pendingState && state !== pendingState) {
    return res.send("Fehler: State mismatch – bitte /login nochmal aufrufen.");
  }

  try {
    const tokenRes = await axios.post("https://blaze.stream/bapi/oauth2/token", {
      clientId:     CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      code,
      codeVerifier: pendingCodeVerifier,
      redirectUri:  REDIRECT_URI,
      grantType:    "authorization_code"
    });

    ACCESS_TOKEN  = tokenRes.data.accessToken;
    REFRESH_TOKEN = tokenRes.data.refreshToken;

    pendingState        = null;
    pendingCodeVerifier = null;

    console.log("✅ Neuer Token erhalten!");
    console.log("ACCESS_TOKEN:", ACCESS_TOKEN);
    console.log("REFRESH_TOKEN:", REFRESH_TOKEN);

    // Socket neu verbinden mit neuem Token
    connectSocket();

    res.send(`
      <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
        <h1>✅ Login erfolgreich!</h1>
        <p>BlazeianBot ist jetzt verbunden. Kopiere diese Werte in deine <strong>Render Environment Variables</strong>:</p>
        <hr style="border-color:#333;">
        <p><strong>BLAZE_ACCESS_TOKEN:</strong></p>
        <textarea style="width:100%;height:80px;background:#222;color:#f5a623;border:1px solid #444;padding:8px;border-radius:4px;">${ACCESS_TOKEN}</textarea>
        <p><strong>BLAZE_REFRESH_TOKEN:</strong></p>
        <textarea style="width:100%;height:80px;background:#222;color:#f5a623;border:1px solid #444;padding:8px;border-radius:4px;">${REFRESH_TOKEN}</textarea>
        <hr style="border-color:#333;">
        <p style="color:#aaa;font-size:14px;">Der Bot läuft bereits mit dem neuen Token. Speichere die Tokens in Render damit sie nach einem Neustart erhalten bleiben.</p>
        <p><a href="/" style="color:#f5a623;">→ Zurück zur Status-Seite</a></p>
      </body></html>
    `);
  } catch (e) {
    console.log("Token exchange error:", e.response?.data || e.message);
    res.send(`
      <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
        <h1>❌ Token-Austausch fehlgeschlagen</h1>
        <pre>${JSON.stringify(e.response?.data || e.message, null, 2)}</pre>
        <p><a href="/login" style="color:#f5a623;">Nochmal versuchen</a></p>
      </body></html>
    `);
  }
});

// Status-Seite
app.get("/", (req, res) => {
  res.send(`
    <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
      <h1>🤖 BlazeianBot</h1>
      <p>Status: <strong style="color:#4caf50;">Running ✅</strong></p>
      <p>Access Token: <strong>${ACCESS_TOKEN ? "✅ Vorhanden" : '❌ Fehlt – <a href="/login" style="color:#f5a623;">jetzt einloggen</a>'}</strong></p>
      <p>Refresh Token: <strong>${REFRESH_TOKEN ? "✅ Vorhanden" : "❌ Fehlt"}</strong></p>
      <h2>📊 Stats</h2>
      <pre style="background:#222;padding:16px;border-radius:8px;">${JSON.stringify(stats, null, 2)}</pre>
      <p><a href="/login" style="color:#f5a623;">🔑 Token erneuern</a></p>
    </body></html>
  `);
});

app.get("/stats", (req, res) => res.json(stats));

// ===============================
// START
// ===============================
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
  connectSocket();
});
