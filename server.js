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

// ===============================
// STATS PERSISTENCE
// Speichert in stats.json damit Zahlen
// nach einem Render-Restart nicht verloren gehen
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
    emotes: {},           // { "emoteId": count }
    emoteNames: {},       // { "emoteId": "emoteName" }
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

// Streamzeit-Tracker
function startStreamTimer() {
  if (stats.streamStartTime) return; // läuft schon
  stats.streamStartTime = Date.now();
  saveStats(stats);

  // Jede Minute +1 speichern
  setInterval(() => {
    stats.totalStreamMinutes += 1;
    saveStats(stats);
  }, 60 * 1000);
}

function formatMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} Min`;
  return `${h}h ${m}m`;
}

function getTopEmote() {
  const entries = Object.entries(stats.emotes);
  if (entries.length === 0) return "Noch keins";
  entries.sort((a, b) => b[1] - a[1]);
  const [topId, topCount] = entries[0];
  const name = stats.emoteNames[topId] || topId;
  return `${name} (${topCount}x)`;
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
  if (t.includes("hola") || t.includes("gracias") || t.includes("cómo")) return "es";
  if (t.includes("bonjour") || t.includes("merci")) return "fr";
  return "en";
}

// ===============================
// SOCKET
// ===============================
const socket = io("https://blaze.stream", {
  path: "/ws",
  transports: ["websocket"]
});

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
          authorization: `Bearer ${process.env.BLAZE_ACCESS_TOKEN}`,
          "client-id": process.env.BLAZE_CLIENT_ID
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
          authorization: `Bearer ${process.env.BLAZE_ACCESS_TOKEN}`,
          "client-id": process.env.BLAZE_CLIENT_ID
        }
      }
    );
    console.log("BOT:", message);
  } catch (e) {
    console.log("Send error:", e.response?.data || e.message);
  }
}

// ===============================
// EVENT HANDLER
// ===============================
socket.on("eventsub", async (message) => {
  const { metadata, payload } = message;

  // ===============================
  // SESSION START
  // ===============================
  if (metadata.messageType === "session_welcome") {
    global.SESSION_ID = payload.sessionId;
    console.log("SESSION READY:", global.SESSION_ID);

    await sendChat("🤖 BlazeianBot ist online und trackt ab jetzt deine Stats!");

    // Streamzeit starten
    startStreamTimer();

    setTimeout(() => {
      subscribe("channel.chat.message", CHANNEL_ID);
      subscribe("channel.follow", CHANNEL_ID);
      subscribe("channel.subscription", CHANNEL_ID);   // Subs
      subscribe("channel.vote", CHANNEL_ID);           // Votes (falls verfügbar)
      subscribe("channel.stream.online", CHANNEL_ID);  // Stream Start
      subscribe("channel.stream.offline", CHANNEL_ID); // Stream Ende
    }, 2000);

    return;
  }

  // ===============================
  // CHAT MESSAGE
  // ===============================
  if (metadata.subscriptionType === "channel.chat.message") {
    const user = payload.sender?.username;
    if (!user) return;
    if (user.toLowerCase() === BOT_NAME.toLowerCase()) return;

    const msg =
      typeof payload.message === "string"
        ? payload.message
        : payload.message?.text || "";

    if (!msg) return;

    console.log(`${user}: ${msg}`);

    // Chat-Counter erhöhen
    stats.totalChatMessages += 1;
    saveStats(stats);

    // Emotes tracken
    const emotes = payload.message?.emotes || payload.emotes || [];
    if (Array.isArray(emotes)) {
      emotes.forEach(emote => {
        const id = emote.id || emote.emoteId;
        const name = emote.name || emote.emoteName || id;
        if (id) {
          stats.emotes[id] = (stats.emotes[id] || 0) + 1;
          stats.emoteNames[id] = name;
        }
      });
      if (emotes.length > 0) saveStats(stats);
    }

    // Memory (nur echte Messages)
    if (!msg.startsWith("!")) {
      chatMemory.push({ user, msg });
      if (chatMemory.length > 10) chatMemory.shift();
    }

    const lang = detectLanguage(msg);
    const msgLow = msg.toLowerCase().trim();

    // ===============================
    // !stats – HAUPTFEATURE
    // ===============================
    if (msgLow === "!stats") {
      const topEmote = getTopEmote();
      const streamTime = formatMinutes(stats.totalStreamMinutes);

      await sendChat(
        `📊 BlazeianBot Stats | ` +
        `🗳️ Votes: ${stats.totalVotes} | ` +
        `⭐ Subs: ${stats.totalSubs} | ` +
        `💬 Chat-Msgs: ${stats.totalChatMessages} | ` +
        `🕐 Stream-Zeit: ${streamTime} | ` +
        `🏆 Top Emote: ${topEmote}`
      );
      return;
    }

    // ===============================
    // !votes
    // ===============================
    if (msgLow === "!votes") {
      await sendChat(`🗳️ Bisher erhaltene Votes: ${stats.totalVotes}`);
      return;
    }

    // ===============================
    // !subs
    // ===============================
    if (msgLow === "!subs") {
      await sendChat(`⭐ Bisher erhaltene Subs: ${stats.totalSubs}`);
      return;
    }

    // ===============================
    // !chat
    // ===============================
    if (msgLow === "!chat") {
      await sendChat(`💬 Bisher erhaltene Chat-Nachrichten: ${stats.totalChatMessages}`);
      return;
    }

    // ===============================
    // !time
    // ===============================
    if (msgLow === "!time") {
      await sendChat(`🕐 Bisher gestreamt: ${formatMinutes(stats.totalStreamMinutes)}`);
      return;
    }

    // ===============================
    // !emote
    // ===============================
    if (msgLow === "!emote") {
      await sendChat(`🏆 Meistgenutztes Emote: ${getTopEmote()}`);
      return;
    }

    // ===============================
    // !commands – Hilfe
    // ===============================
    if (msgLow === "!commands" || msgLow === "!help") {
      await sendChat(
        `🤖 Commands: !stats | !votes | !subs | !chat | !time | !emote | !translate`
      );
      return;
    }

    // ===============================
    // !join
    // ===============================
    if (msgLow === "!join") {
      await sendChat(`👋 Hey ${user}, ich bin bereits verbunden und höre zu!`);
      return;
    }

    // ===============================
    // !translate
    // ===============================
    if (msgLow.startsWith("!translate")) {
      const last = chatMemory.slice(-3);
      const text =
        last.length > 0
          ? last.map(m => `${m.user}: ${m.msg}`).join(" | ")
          : "Noch keine Nachrichten.";
      await sendChat(`🌍 Letzte 3 Msgs: ${text}`);
      return;
    }

    // ===============================
    // GREETING
    // ===============================
    if (msgLow.includes("hi") || msgLow.includes("hello") || msgLow.includes("hallo")) {
      const reply =
        lang === "de" ? `Hallo ${user} 👋` :
        lang === "es" ? `¡Hola ${user} 👋` :
        lang === "fr" ? `Salut ${user} 👋` :
        `Hello ${user} 👋`;
      await sendChat(reply);
      return;
    }

    return;
  }

  // ===============================
  // SUBSCRIPTION EVENT (neuer Sub)
  // ===============================
  if (metadata.subscriptionType === "channel.subscription") {
    const user = payload.user?.username || payload.subscriber?.username || "Someone";
    stats.totalSubs += 1;
    saveStats(stats);
    console.log("New Sub:", user);
    await sendChat(`⭐ ${user} hat gerade gesubs! Danke! (Gesamt: ${stats.totalSubs})`);
    return;
  }

  // ===============================
  // VOTE EVENT
  // ===============================
  if (metadata.subscriptionType === "channel.vote") {
    const user = payload.user?.username || payload.voter?.username || "Someone";
    stats.totalVotes += 1;
    saveStats(stats);
    console.log("New Vote:", user);
    await sendChat(`🗳️ ${user} hat gevoted! Danke! (Gesamt: ${stats.totalVotes})`);
    return;
  }

  // ===============================
  // STREAM ONLINE / OFFLINE
  // ===============================
  if (metadata.subscriptionType === "channel.stream.online") {
    console.log("Stream ist live!");
    startStreamTimer();
    return;
  }

  if (metadata.subscriptionType === "channel.stream.offline") {
    console.log("Stream offline.");
    stats.streamStartTime = null;
    saveStats(stats);
    return;
  }

  // Alle anderen Events loggen
  console.log("EVENT:", JSON.stringify(message, null, 2));
});

// ===============================
// STATUS
// ===============================
socket.on("connect", () => console.log("Socket connected ✅"));
socket.on("connect_error", err => console.log("Socket error:", err.message));

// ===============================
// WEB SERVER
// ===============================
app.get("/", (req, res) => {
  res.send(`
    <h1>BlazeianBot ✅</h1>
    <p>Stats:</p>
    <pre>${JSON.stringify(stats, null, 2)}</pre>
  `);
});

// Stats API endpoint (optional nützlich)
app.get("/stats", (req, res) => {
  res.json(stats);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
