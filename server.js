const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    status: "online",
    clientId: process.env.BLAZE_CLIENT_ID ? "gefunden" : "fehlt",
    clientSecret: process.env.BLAZE_CLIENT_SECRET ? "gefunden" : "fehlt"
  });
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
