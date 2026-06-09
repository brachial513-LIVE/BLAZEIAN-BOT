const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("BlazeianBot läuft wieder stabil ✅");
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

    return res.redirect(response.data.url);

  } catch (e) {
    console.log("ERROR:", e.response?.data || e.message);
    return res.send("OAuth error");
  }
});

    return res.redirect(response.data.url);
  } catch (e) {
    return res.send("OAuth error");
  }
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
