const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// MEMORY (letzte Chatnachrichten)
// ===============================
const chatMemory = [];

// Bot Username (gegen Self-Loop)
const BOT_NAME = "blazeian_bot";

// ===============================
// SPRACHE ERKENNUNG
// ===============================
function detectLanguage(text = "") {
  const t = text.toLowerCase();

  if (/[äöüß]/.test(t) || t.includes("hallo") || t.includes("wie geht")) return "de";
  if (t.includes("hola") || t.includes("gracias") || t.includes("cómo")) return "es";
  if (t.includes("bonjour") || t.includes("merci")) return "fr";

  return "en";
}

// ===============================
// SOCKET SETUP
// ===============================
const socket = io("https://blaze.stream", {
  path: "/ws",
  transports: ["websocket"]
});

// ===============================
// SUBSCRIBE FUNCTION
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
      {
        channelId: "514160a7-fd05-4d7b-9932-a0143aa40d1c",
        message
      },
      {
        headers: {
          authorization: `Bearer ${process.env.BLAZE_ACCESS_TOKEN}`,
          "client-id": process.env.BLAZE_CLIENT_ID
        }
      }
    );

    console.log("Bot:", message);
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

    console.log("SESSION ID:", global.SESSION_ID);

    setTimeout(() => {
      subscribe("channel.chat.message", "514160a7-fd05-4d7b-9932-a0143aa40d1c");
      subscribe("channel.follow", "514160a7-fd05-4d7b-9932-a0143aa40d1c");
    }, 2000);

    return;
  }

  // ===============================
  // CHAT MESSAGE
  // ===============================
  if (metadata.subscriptionType === "channel.chat.message") {
    const user = payload.sender?.username;
    if (!user) return;

    // Self-loop fix
    if (user.toLowerCase() === BOT_NAME.toLowerCase()) return;

    const msg =
      typeof payload.message === "string"
        ? payload.message
        : payload.message?.text || "";

    if (!msg) return;

    console.log(`${user}: ${msg}`);

    // Memory
    chatMemory.push({ user, msg });
    if (chatMemory.length > 10) chatMemory.shift();

    const lang = detectLanguage(msg);

    // ===============================
    // !join (FIX — DAS FEHLTE BEI DIR)
    // ===============================
    if (msg.toLowerCase() === "!join") {
      await sendChat("👋 I’m already in the chat!");
      return;
    }

    // ===============================
    // !translate
    // ===============================
    if (msg.toLowerCase().startsWith("!translate")) {
      const last = chatMemory.slice(-3);

      const text = last
        .map(m => `${m.user}: ${m.msg}`)
        .join("\n");

      await sendChat(`🌍 Last 3 messages:\n\n${text}`);
      return;
    }

    // ===============================
    // GREETING
    // ===============================
    if (msg.toLowerCase().includes("hi")) {
      const reply =
        lang === "de"
          ? "Hallo 👋"
          : lang === "es"
          ? "¡Hola 👋"
          : lang === "fr"
          ? "Salut 👋"
          : "Hello 👋";

      await sendChat(reply);
      return;
    }

    return;
  }

  console.log("EVENT:");
  console.log(JSON.stringify(message, null, 2));
});

// ===============================
// SOCKET STATUS
// ===============================
socket.on("connect", () => console.log("Socket verbunden"));
socket.on("connect_error", err => console.log("Socket Fehler:", err.message));

// ===============================
// ROUTES
// ===============================
app.get("/", (req, res) => {
  res.send("BlazeianBot läuft ✅");
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, "0.0.0.0", () => {
  console.log("Server läuft auf Port", PORT);
});
