const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// CHANNEL CONFIG
// ===============================
const CHANNEL_ID = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_NAME = "blazeian_bot";

const CLIENT_ID     = process.env.BLAZE_CLIENT_ID;
const CLIENT_SECRET = process.env.BLAZE_CLIENT_SECRET;
const REDIRECT_URI  = "https://blazeian-bot.onrender.com/callback";

// ===============================
// TOKEN MANAGEMENT
// ===============================
let ACCESS_TOKEN  = process.env.BLAZE_ACCESS_TOKEN || null;
let REFRESH_TOKEN = process.env.BLAZE_REFRESH_TOKEN || null;

async function refreshAccessToken() {
  if (!REFRESH_TOKEN) {
    console.log("No refresh token available – manual re-auth needed.");
    return false;
  }
  try {
    const res = await axios.post("https://api.blaze.stream/oauth/token", {
      grant_type:    "refresh_token",
      refresh_token: REFRESH_TOKEN,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET
    });
    ACCESS_TOKEN  = res.data.access_token;
    REFRESH_TOKEN = res.data.refresh_token || REFRESH_TOKEN;
    console.log("Token refreshed ✅");
    return true;
  } catch (e) {
    console.log("Token refresh failed:", e.response?.data || e.message);
    return false;
  }
}

// Auto-refresh every 3 hours
setInterval(refreshAccessToken, 3 * 60 * 60 * 1000);

// ===============================
// STATS PERSISTENCE
// ===============================
const STATS_FILE = path.join(__dirname, "stats.json");

function loadStats() {
  try {
    if (fs.existsSync(STATS_FILE)) {
      return JSON.parse(fs.readFileSync(STATS_FILE, "utf8"));
    }
  } catch (e) {
    console.log("Stats load error:", e.message);
  }
  return {
    totalVotes: 0,
    totalSubs: 0,
    totalChatMessages: 0,
    totalStreamMinutes: 0,
    emotes: {},
    emoteNames: {},
    streamStartTime: null
  };
}

function saveStats(stats) {
  try {
    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (e) {
    console.log("Stats save error:", e.message);
  }
}

let stats = loadStats();

function startStreamTimer() {
  if (stats._timerRunning) return;
  stats._timerRunning = true;
  setInterval(() => {
    stats.totalStreamMinutes += 1;
    saveStats(stats);
  }, 60 * 1000);
}

function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} Min` : `${h}h ${m}m`;
}

function getTopEmote() {
  const entries = Object.entries(stats.emotes);
  if (entries.length === 0) return "Noch keins";
  entries.sort((a, b) => b[1] - a[1]);
  const [topId, topCount] = entries[0];
  return `${stats.emoteNames[topId] || topId} (${topCount}x)`;
}

// ===============================
// CHAT MEMORY
// ===============================
const chatMemory = [];

// ===============================
// LANGUAGE DETECTION
// ===============================
function detectLanguage(text = "") {
  const t = text.toLowerCase();
  if (/[äöüß]/.test(t) || t.includes("hallo") || t.includes("wie geht")) return "de";
  if (t.includes("hola") || t.includes("gracias")) return "es";
  if (t.includes("bonjour") || t.includes("merci")) return "fr";
  return "en";
}

// ===============================
// SOCKET
// ===============================
let socket;

function connectSocket() {
  if (socket) {
    socket.disconnect();
  }

  socket = io("https://blaze.stream", {
    path: "/ws",
    transports: ["websocket"]
  });

  socket.on("connect", () => console.log("Socket connected ✅"));
  socket.on("connect_error", err => console.log("Socket error:", err.message));
  socket.on("eventsub", handleEvent);
}

// ===============================
// SUBSCRIBE
// ===============================
async function subscribe(type, channelId) {
  try {
    await axios.post(
      "https://api.blaze.stream/v1/events/subscriptions",
      {
        type,
        version: "1",
        sessionId: global.SESSION_ID,
        condition: { channelId }
      },
      {
        headers: {
          authorization: `Bearer ${ACCESS_TOKEN}`,
          "client-id": CLIENT_ID
        }
      }
    );
    console.log("Subscribed:", type);
  } catch (e) {
    console.log("Subscribe error:", e.response?.data || e.message);
  }
}

// ===============================
// SEND CHAT
// ===============================
async function sendChat(message) {
  try {
    await axios.post(
      "https://api.blaze.stream/v1/chats/messages",
      { channelId: CHANNEL_ID, message },
      {
        headers: {
          authorization: `Bearer ${ACCESS_TOKEN}`,
          "client-id": CLIENT_ID
        }
      }
    );
    console.log("BOT:", message);
  } catch (e) {
    // If unauthorized, try refresh once
    if (e.response?.status === 401) {
      console.log("Token expired, refreshing...");
      const ok = await refreshAccessToken();
      if (ok) await sendChat(message); // retry once
    } else {
      console.log("Send error:", e.response?.data || e.message);
    }
  }
}

// ===============================
// EVENT HANDLER
// ===============================
async function handleEvent(message) {
  const { metadata, payload } = message;

  // SESSION START
  if (metadata.messageType === "session_welcome") {
    global.SESSION_ID = payload.sessionId;
    console.log("SESSION READY:", global.SESSION_ID);

    await sendChat("🤖 BlazeianBot ist online und trackt deine Stats!");
    startStreamTimer();

    setTimeout(() => {
      subscribe("channel.chat.message", CHANNEL_ID);
      subscribe("channel.follow", CHANNEL_ID);
      subscribe("channel.subscription", CHANNEL_ID);
      subscribe("channel.vote", CHANNEL_ID);
      subscribe("channel.stream.online", CHANNEL_ID);
      subscribe("channel.stream.offline", CHANNEL_ID);
    }, 2000);
    return;
  }

  // CHAT MESSAGE
  if (metadata.subscriptionType === "channel.chat.message") {
    const user = payload.sender?.username;
    if (!user || user.toLowerCase() === BOT_NAME.toLowerCase()) return;

    const msg = typeof payload.message === "string"
      ? payload.message
      : payload.message?.text || "";

    if (!msg) return;
    console.log(`${user}: ${msg}`);

    stats.totalChatMessages += 1;
    saveStats(stats);

    // Emotes tracken
    const emotes = payload.message?.emotes || payload.emotes || [];
    if (Array.isArray(emotes) && emotes.length > 0) {
      emotes.forEach(emote => {
        const id = emote.id || emote.emoteId;
        const name = emote.name || emote.emoteName || id;
        if (id) {
          stats.emotes[id] = (stats.emotes[id] || 0) + 1;
          stats.emoteNames[id] = name;
        }
      });
      saveStats(stats);
    }

    if (!msg.startsWith("!")) {
      chatMemory.push({ user, msg });
      if (chatMemory.length > 10) chatMemory.shift();
    }

    const msgLow = msg.toLowerCase().trim();
    const lang   = detectLanguage(msg);

    // COMMANDS
    if (msgLow === "!stats") {
      await sendChat(
        `📊 Stats | 🗳️ Votes: ${stats.totalVotes} | ⭐ Subs: ${stats.totalSubs} | ` +
        `💬 Msgs: ${stats.totalChatMessages} | 🕐 Zeit: ${formatMinutes(stats.totalStreamMinutes)} | ` +
        `🏆 Top Emote: ${getTopEmote()}`
      );
      return;
    }
    if (msgLow === "!votes") { await sendChat(`🗳️ Votes gesamt: ${stats.totalVotes}`); return; }
    if (msgLow === "!subs")  { await sendChat(`⭐ Subs gesamt: ${stats.totalSubs}`); return; }
    if (msgLow === "!chat")  { await sendChat(`💬 Chat-Nachrichten gesamt: ${stats.totalChatMessages}`); return; }
    if (msgLow === "!time")  { await sendChat(`🕐 Stream-Zeit gesamt: ${formatMinutes(stats.totalStreamMinutes)}`); return; }
    if (msgLow === "!emote") { await sendChat(`🏆 Top Emote: ${getTopEmote()}`); return; }

    if (msgLow === "!commands" || msgLow === "!help") {
      await sendChat(`🤖 Commands: !stats | !votes | !subs | !chat | !time | !emote | !translate`);
      return;
    }

    if (msgLow === "!join") {
      await sendChat(`👋 Hey ${user}, ich bin bereits verbunden!`);
      return;
    }

    if (msgLow.startsWith("!translate")) {
      const last = chatMemory.slice(-3);
      const text = last.length > 0 ? last.map(m => `${m.user}: ${m.msg}`).join(" | ") : "Noch keine Nachrichten.";
      await sendChat(`🌍 Letzte 3 Msgs: ${text}`);
      return;
    }

    if (msgLow.includes("hi") || msgLow.includes("hello") || msgLow.includes("hallo")) {
      const reply = lang === "de" ? `Hallo ${user} 👋` : lang === "es" ? `¡Hola ${user} 👋` : lang === "fr" ? `Salut ${user} 👋` : `Hello ${user} 👋`;
      await sendChat(reply);
      return;
    }
    return;
  }

  // SUB EVENT
  if (metadata.subscriptionType === "channel.subscription") {
    const user = payload.user?.username || payload.subscriber?.username || "Someone";
    stats.totalSubs += 1;
    saveStats(stats);
    await sendChat(`⭐ ${user} hat gerade gesubs! Danke! (Gesamt: ${stats.totalSubs})`);
    return;
  }

  // VOTE EVENT
  if (metadata.subscriptionType === "channel.vote") {
    const user = payload.user?.username || payload.voter?.username || "Someone";
    stats.totalVotes += 1;
    saveStats(stats);
    await sendChat(`🗳️ ${user} hat gevoted! Danke! (Gesamt: ${stats.totalVotes})`);
    return;
  }

  // STREAM ON/OFF
  if (metadata.subscriptionType === "channel.stream.online")  { startStreamTimer(); return; }
  if (metadata.subscriptionType === "channel.stream.offline") { stats.streamStartTime = null; saveStats(stats); return; }

  console.log("EVENT:", JSON.stringify(message, null, 2));
}

// ===============================
// OAUTH ROUTES
// ===============================

// Step 1: Login-Seite – öffne diese URL im Browser um neuen Token zu holen
app.get("/login", (req, res) => {
  const url = `https://api.blaze.stream/oauth/authorize?` +
    `client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&response_type=code` +
    `&scope=chat:read+chat:write+channel:read`;

  res.send(`
    <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff;">
      <h1>🤖 BlazeianBot – Token erneuern</h1>
      <p>Klicke den Button um dich bei Blaze einzuloggen und einen neuen Token zu holen:</p>
      <a href="${url}" style="background:#f5a623;color:#000;padding:16px 32px;border-radius:8px;text-decoration:none;font-size:18px;font-weight:bold;">
        🔑 Mit Blaze einloggen
      </a>
    </body></html>
  `);
});

// Step 2: Callback – Blaze leitet hier hin nach Login
app.get("/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Fehler: Kein Code erhalten.");

  try {
    const tokenRes = await axios.post("https://api.blaze.stream/oauth/token", {
      grant_type:    "authorization_code",
      code,
      redirect_uri:  REDIRECT_URI,
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET
    });

    ACCESS_TOKEN  = tokenRes.data.access_token;
    REFRESH_TOKEN = tokenRes.data.refresh_token;

    console.log("New token received ✅");
    console.log("ACCESS_TOKEN:", ACCESS_TOKEN);
    console.log("REFRESH_TOKEN:", REFRESH_TOKEN);

    // Reconnect socket with new token
    connectSocket();

    res.send(`
      <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff;">
        <h1>✅ Token erfolgreich!</h1>
        <p>BlazeianBot ist jetzt neu verbunden.</p>
        <p style="color:#aaa;">Kopiere diese Tokens in deine Render Environment Variables:</p>
        <p><strong>BLAZE_ACCESS_TOKEN:</strong><br><code style="color:#f5a623;word-break:break-all;">${ACCESS_TOKEN}</code></p>
        <p><strong>BLAZE_REFRESH_TOKEN:</strong><br><code style="color:#f5a623;word-break:break-all;">${REFRESH_TOKEN}</code></p>
        <p style="color:#aaa;font-size:14px;">Der Bot läuft bereits – aber speichere die Tokens in Render damit sie nach einem Neustart noch da sind.</p>
      </body></html>
    `);
  } catch (e) {
    console.log("Token exchange error:", e.response?.data || e.message);
    res.send("Fehler beim Token-Austausch: " + JSON.stringify(e.response?.data || e.message));
  }
});

// Status-Seite
app.get("/", (req, res) => {
  res.send(`
    <html><body style="font-family:sans-serif;padding:40px;background:#111;color:#fff;">
      <h1>🤖 BlazeianBot</h1>
      <p>Status: <strong style="color:#4caf50;">Running ✅</strong></p>
      <p>Token vorhanden: <strong>${ACCESS_TOKEN ? "✅ Ja" : "❌ Nein – <a href='/login'>jetzt einloggen</a>"}</strong></p>
      <pre style="background:#222;padding:16px;border-radius:8px;">${JSON.stringify({...stats, _timerRunning: undefined}, null, 2)}</pre>
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
