const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

const CLIENT_ID = process.env.BLAZE_CLIENT_ID;

app.get("/", (req, res) => {
  res.send(`
    <h1>BlazeianBot</h1>
    <a href="/login">Mit Blaze anmelden</a>
  `);
});

app.get("/login", (req, res) => {
  res.json({
    status: "oauth-test",
    clientId: CLIENT_ID ? "gefunden" : "fehlt"
  });
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
