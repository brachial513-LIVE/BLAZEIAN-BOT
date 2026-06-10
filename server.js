const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// MEMORY
// ===============================
const chatMemory = [];

// Bot Name
const BOT_NAME = "blazeian_bot";

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

    // 👉 EINMALIGER START MESSAGE (WIE DU ES WOLLTEST)
    await sendChat("🤖 BlazeianBot is now online and ready in your chat!");

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

    // self-loop protection
    if (user.toLowerCase() === BOT_NAME.toLowerCase()) return;

    const msg =
      typeof payload.message === "string"
        ? payload.message
        : payload.message?.text || "";

    if (!msg) return;

    console.log(`${user}: ${msg}`);

    // ===============================
    // MEMORY (nur echte Messages)
    // ===============================
    if (!msg.startsWith("!")) {
      chatMemory.push({ user, msg });
      if (chatMemory.length > 10) chatMemory.shift();
    }

    const lang = detectLanguage(msg);

    // ===============================
    // !join (JETZT SINNVOLL)
    // ===============================
    if (msg.toLowerCase() === "!join") {
      await sendChat(`👋 Hey ${user}, I'm already connected and listening to your chat.`);
      return;
    }

    // ===============================
    // !translate
    // ===============================
    if (msg.toLowerCase().startsWith("!translate")) {
      const last = chatMemory.slice(-3);

      const text =
        last.length > 0
          ? last.map(m => `${m.user}: ${m.msg}`).join("\n")
          : "No messages yet.";

      await sendChat(`🌍 Last 3 messages:\n\n${text}`);
      return;
    }

    // ===============================
    // GREETING
    // ===============================
    if (msg.toLowerCase().includes("hi") || msg.toLowerCase().includes("hello")) {
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
// STATUS
// ===============================
socket.on("connect", () => console.log("Socket connected"));
socket.on("connect_error", err => console.log("Socket error:", err.message));

// ===============================
// SERVER
// ===============================
app.get("/", (req, res) => {
  res.send("BlazeianBot running ✅");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});
