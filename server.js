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
        scopes: ["users.read"]
      }
    );

    return res.json(response.data);

  } catch (e) {
  return res.json({
    error: true,
    details: e.response?.data || e.message
  });
}
});

app.get("/callback", (req, res) => {
  res.json({
    ok: true,
    code: req.query.code || null,
    state: req.query.state || null
  });
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
