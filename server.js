const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");

const app = express();
const PORT = process.env.PORT || 3000;

// ===============================
// MEMORY (letzte Chatnachrichten)
// ===============================
const chatMemory = [];

// ===============================
// SPRACHE ERKENNUNG
// ===============================
function detectLanguage(text = "") {
  const t = text.toLowerCase();

  if (/[äöüß]/.test(t) || t.includes("hallo") || t.includes("wie geht")) return "de";
  if (t.includes("hola") || t.includes("gracias") || t.includes("cómo")) return "es";
  if (t.includes("bonjour") || t.includes("merci")) return "fr";

  return "en"; // default
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
    const res = await axios.post(
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
// EVENT HANDLER
// ===============================
socket.on("eventsub", async (message) => {
  const { metadata, payload } = message;

  // -------------------------------
  // SESSION START
  // -------------------------------
  if (metadata.messageType === "session_welcome") {
    global.SESSION_ID = payload.sessionId;

    console.log("SESSION ID:", global.SESSION_ID);

    setTimeout(() => {
      subscribe("channel.chat.message", "514160a7-fd05-4d7b-9932-a0143aa40d1c");
    }, 2000);

    return;
  }

  // -------------------------------
  // CHAT MESSAGE
  // -------------------------------
  if (metadata.subscriptionType === "channel.chat.message") {
    const user = payload.sender.username;
    const msg = payload.message;

    console.log(`${user}: ${msg}`);

    // Memory speichern
    chatMemory.push({ user, msg });
    if (chatMemory.length > 10) chatMemory.shift();

    const lang = detectLanguage(msg);

    // -----------------------
    // COMMAND: !translate
    // -----------------------
    if (msg.toLowerCase().startsWith("!translate")) {
      const lastMessages = chatMemory.slice(-3);

      let textToSend = lastMessages
        .map(m => `${m.user}: ${m.msg}`)
        .join("\n");

      console.log("TRANSLATE REQUEST →", lang);

      await sendChat(
        `🌍 Translation (${lang}):\n\n${textToSend}`,
        lang
      );

      return;
    }

    // -----------------------
    // DIRECT MENTION / GREETING LOGIC
    // -----------------------
    if (msg.toLowerCase().includes("hi")) {
      await sendChat(
        lang === "de"
          ? "Hallo 👋"
          : lang === "es"
          ? "¡Hola 👋"
          : "Hello 👋",
        lang
      );
    }

    return;
  }

  console.log("EVENT:");
  console.log(JSON.stringify(message, null, 2));
});

socket.on("connect", () => console.log("Socket verbunden"));
socket.on("connect_error", err => console.log("Socket Fehler:", err.message));

// ===============================
// SEND CHAT FUNCTION
// ===============================
async function sendChat(message, lang = "en") {
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

    console.log(`Bot (${lang}):`, message);
  } catch (e) {
    console.log("Send error:", e.response?.data || e.message);
  }
}

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
