const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");

const app = express();

const PORT = process.env.PORT || 3000;

// ===============================
// SOCKET SETUP
// ===============================
const socket = io("https://blaze.stream", {
  path: "/ws",
  transports: ["websocket"]
});

socket.on("eventsub", (message) => {
  const { metadata, payload } = message;

  // SESSION WELCOME
  if (metadata.messageType === "session_welcome") {
    const sessionId = payload.sessionId;

    console.log("SESSION ID:", sessionId);

    global.SESSION_ID = sessionId;

    return;
  }

  console.log("EVENT:");
  console.log(JSON.stringify(message, null, 2));
});

socket.on("connect", () => {
  console.log("Socket verbunden");
});

socket.on("connect_error", (err) => {
  console.log("Socket Fehler:", err.message);
});

// ===============================
// EVENT SUBSCRIBE FUNCTION
// ===============================
async function subscribe(type, channelId) {
  try {
    const res = await axios.post(
      "https://api.blaze.stream/v1/events/subscriptions",
      {
        type,
        version: "1",
        sessionId: global.SESSION_ID,
        condition: {
          channelId
        }
      },
      {
        headers: {
          authorization: `Bearer ${process.env.BLAZE_ACCESS_TOKEN}`,
          "client-id": process.env.BLAZE_CLIENT_ID
        }
      }
    );

    console.log("Subscribed:", type, res.data);
  } catch (e) {
    console.log("Subscribe error:", e.response?.data || e.message);
  }
}

// ===============================
// ROUTES
// ===============================
app.get("/", (req, res) => {
  res.send("BlazeianBot läuft ✅");
});

app.get("/login", async (req, res) => {
  try {
    const response = await axios.post(
      "https://blaze.stream/bapi/oauth2/generate-auth-url",
      {
        clientId: process.env.BLAZE_CLIENT_ID,
        clientSecret: process.env.BLAZE_CLIENT_SECRET,
        redirectUri: "https://blazeian-bot.onrender.com/callback",
        scopes: ["users.read", "channel.moderate"]
      }
    );

    process.env.CODE_VERIFIER = response.data.codeVerifier;
    return res.redirect(response.data.url);

  } catch (e) {
    return res.json({
      error: true,
      details: e.response?.data || e.message
    });
  }
});

app.get("/callback", async (req, res) => {
  try {
    const tokenResponse = await axios.post(
      "https://blaze.stream/bapi/oauth2/token",
      {
        clientId: process.env.BLAZE_CLIENT_ID,
        clientSecret: process.env.BLAZE_CLIENT_SECRET,
        code: req.query.code,
        codeVerifier: process.env.CODE_VERIFIER,
        redirectUri: "https://blazeian-bot.onrender.com/callback",
        grantType: "authorization_code"
      }
    );

    res.json(tokenResponse.data);

  } catch (e) {
    res.json({
      error: true,
      details: e.response?.data || e.message
    });
  }
});

app.get("/profile", async (req, res) => {
  try {
    const response = await axios.get(
      "https://api.blaze.stream/v1/users/achievement-stats",
      {
        headers: {
          authorization: `Bearer ${process.env.BLAZE_ACCESS_TOKEN}`,
          "client-id": process.env.BLAZE_CLIENT_ID
        }
      }
    );

    res.json(response.data);

  } catch (e) {
    res.json({
      error: true,
      details: e.response?.data || e.message
    });
  }
});

app.get("/sendtest", async (req, res) => {
  try {
    const response = await axios.post(
      "https://api.blaze.stream/v1/chats/messages",
      {
        channelId: "514160a7-fd05-4d7b-9932-a0143aa40d1c",
        message: "BlazeianBot ist online 🚀"
      },
      {
        headers: {
          authorization: `Bearer ${process.env.BLAZE_ACCESS_TOKEN}`,
          "client-id": process.env.BLAZE_CLIENT_ID
        }
      }
    );

    res.json(response.data);

  } catch (e) {
    res.json({
      error: true,
      details: e.response?.data || e.message
    });
  }
});

// ===============================
// START SERVER
// ===============================
app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
