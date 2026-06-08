const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("BlazeianBot läuft wieder stabil ✅");
});

app.get("/login", (req, res) => {
  res.send("OAuth wird gleich wieder eingebaut.");
});

app.get("/callback", (req, res) => {
  res.json({
    ok: true,
    message: "Callback aktiv",
    code: req.query.code || null,
    state: req.query.state || null
  });
});

app.listen(PORT, () => {
  console.log("Server läuft auf Port", PORT);
});
