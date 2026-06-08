const express = require("express");

const app = express();

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`
    <h1>BlazeianBot</h1>
    <p>Bot ist online.</p>
    <a href="/login">Mit Blaze verbinden</a>
  `);
});

app.get("/login", (req, res) => {
  res.send("OAuth kommt als nächstes.");
});

app.get("/callback", (req, res) => {
  const code = req.query.code;
  const state = req.query.state;

  res.json({
    success: true,
    code: code || null,
    state: state || null
  });
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
