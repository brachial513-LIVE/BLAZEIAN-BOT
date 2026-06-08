const express = require("express");
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.BLAZE_CLIENT_ID;
const CLIENT_SECRET = process.env.BLAZE_CLIENT_SECRET;
const REDIRECT_URI = "https://blazeian-bot.onrender.com/callback";

// Startseite
app.get("/", (req, res) => {
  res.send(`
    <h1>BlazeianBot</h1>
    <a href="/login">Mit Blaze verbinden</a>
  `);
});

// OAuth Start
app.get("/login", async (req, res) => {
  try {
    const response = await axios.post(
      "https://blaze.stream/bapi/oauth2/generate-auth-url",
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        redirectUri: REDIRECT_URI,
        scopes: [
          "users.read",
          "offline.access",
          "channel.moderate",
          "users.bot"
        ]
      }
    );

    const url = response.data.url;

    // User direkt zu Blaze weiterleiten
    res.redirect(url);

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("Fehler beim OAuth Start");
  }
});

// Callback nach Login
app.get("/callback", async (req, res) => {
  const { code } = req.query;

  if (!code) {
    return res.send("Kein Code erhalten");
  }

  try {
    const tokenResponse = await axios.post(
      "https://blaze.stream/bapi/oauth2/token",
      {
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        code: code,
        codeVerifier: "TEMP", // später ersetzen
        redirectUri: REDIRECT_URI,
        grantType: "authorization_code"
      }
    );

    const tokenData = tokenResponse.data;

    res.json({
      success: true,
      message: "OAuth erfolgreich!",
      accessToken: tokenData.accessToken,
      userId: tokenData.userId,
      scopes: tokenData.scopes
    });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.send("Token Austausch fehlgeschlagen");
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
