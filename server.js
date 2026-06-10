const express = require("express");
const axios = require("axios");

const app = express();

const PORT = process.env.PORT || 3000;

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

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
