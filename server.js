const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
const PORT = process.env.PORT || 3000;
const BOT_CHANNEL_ID = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_USER_ID    = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_NAME       = "blazeian_bot_ai"; // display/handle after the AI rename
// Recognise the bot's own account under BOTH the old and new name, so renaming can't cause self-reactions.
const BOT_ALIASES    = ["blazeian_bot", "blazeian_bot_ai", "blazeianbot"];
function isBotName(u) { return !!u && BOT_ALIASES.includes(u.toLowerCase()); }
const CLIENT_ID      = process.env.BLAZE_CLIENT_ID;
const CLIENT_SECRET  = process.env.BLAZE_CLIENT_SECRET;
const REDIRECT_URI   = "https://blazeian-bot.onrender.com/callback";
const SELF_URL       = process.env.SELF_URL || "https://blazeian-bot.onrender.com";
const ADMIN_KEY      = process.env.ADMIN_KEY || "";
const crypto         = require("crypto");
// AI brain (optional) — set GROQ_API_KEY in Render to switch the bot from canned replies to a real, contextual brain
const AI_KEY         = process.env.GROQ_API_KEY || process.env.AI_API_KEY || "";
const AI_MODEL       = process.env.AI_MODEL || "llama-3.3-70b-versatile";

let ACCESS_TOKEN  = process.env.BLAZE_ACCESS_TOKEN  || null;
let REFRESH_TOKEN = process.env.BLAZE_REFRESH_TOKEN || null;
// Browser SESSION token (32-hex from the bot's `token` cookie) + its visitorId.
// This is the ONLY thing Blaze's follow endpoint accepts — the OAuth token does NOT work for following.
let SESSION_TOKEN      = process.env.BLAZE_SESSION_TOKEN || null;
let SESSION_VISITOR_ID = process.env.BLAZE_VISITOR_ID   || null;
// Bot account credentials → lets the server mint a fresh session token by itself (auto-refresh).
const BOT_EMAIL    = process.env.BLAZE_BOT_EMAIL    || null;
const BOT_PASSWORD = process.env.BLAZE_BOT_PASSWORD || null;

// AUTO-UPDATE ANNOUNCE: bump BOT_VERSION + set CHANGELOG whenever we ship something worth telling users about.
// On startup, if this version hasn't been announced yet, the bot posts CHANGELOG to every channel — ONCE.
// (Plain restarts / free-tier wake-ups keep the same version → stay silent, no spam.)
const BOT_VERSION = "2026-07-02.4";
const CHANGELOG = "🚀 BIG drops for you! I now bring FREE OBS overlays for your stream — a live emote wall 🎉, a BLAZE viewer counter 👁️, AND a little me that runs across your screen & watches with you 🤖💚 PLUS I team up with other bots in chat as friends now 🤝🔥 Grab your overlay links in the dashboard & type !info to see everything I do!";
let lastAnnouncedVersion = null;
let pendingState        = null;
let pendingCodeVerifier = null;
let APP_ACCESS_TOKEN    = null;
const pendingAuth = {};   // oauth state -> { codeVerifier, kind }
const sessions    = {};   // session id  -> { username, exp }

async function getAppAccessToken() {
  try {
    const res = await axios.post("https://blaze.stream/bapi/oauth2/token", {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, grantType: "client_credentials"
    });
    APP_ACCESS_TOKEN = res.data.accessToken;
    console.log("App token acquired");
    setTimeout(getAppAccessToken, 6 * 24 * 60 * 60 * 1000);
  } catch(e) {
    console.log("App token error:", e.response?.data || e.message);
    setTimeout(getAppAccessToken, 5 * 60 * 1000);
  }
}

async function refreshAccessToken() {
  if (!REFRESH_TOKEN) { console.log("No refresh token"); return false; }
  try {
    const res = await axios.post("https://blaze.stream/bapi/oauth2/refresh", {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN
    });
    ACCESS_TOKEN  = res.data.accessToken;
    REFRESH_TOKEN = res.data.refreshToken || REFRESH_TOKEN;
    console.log("Token refreshed");
    saveChannels(); // persist the rotated tokens to the cloud so they survive redeploys
    return true;
  } catch (e) {
    console.log("Refresh error:", e.response?.data || e.message);
    return false;
  }
}
setInterval(refreshAccessToken, 45 * 60 * 1000); // refresh well before the short-lived access token expires

// AUTO-REFRESH the follow session: log in as the bot, grab a fresh session token.
// The token comes back either in the JSON body or as a `token` Set-Cookie — we handle both.
async function loginSession() {
  if (!BOT_EMAIL || !BOT_PASSWORD) { console.log("[LOGIN] no BOT_EMAIL/BOT_PASSWORD env set — can't auto-refresh"); return false; }
  try {
    const vid = SESSION_VISITOR_ID || (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
    const res = await axios.post("https://blaze.stream/bapi/auth/login",
      { email: BOT_EMAIL, password: BOT_PASSWORD },
      { headers: { "content-type": "application/json", "visitor-id": vid, origin: "https://blaze.stream",
                   cookie: `visitorId=${vid}` }, timeout: 12000 });
    // try to find the token in the JSON body (several possible shapes)
    const d = res.data || {};
    let tok = d.token || d.accessToken || d.sessionToken || d.data?.token || d.data?.accessToken || d.user?.token || null;
    // ...or in a Set-Cookie header
    const setCookies = res.headers?.["set-cookie"] || [];
    for (const c of setCookies) {
      const mt = /(?:^|;|\s)token=([^;]+)/i.exec(c); if (mt && !tok) tok = mt[1];
      const mv = /(?:^|;|\s)visitorId=([^;]+)/i.exec(c); if (mv) SESSION_VISITOR_ID = mv[1];
    }
    if (!SESSION_VISITOR_ID) SESSION_VISITOR_ID = vid;
    if (!tok) { console.log("[LOGIN] login ok but no token found. Body keys:", Object.keys(d).join(",")); return false; }
    SESSION_TOKEN = tok;
    console.log(`[LOGIN] ✅ fresh session token minted (${tok.length} chars), visitorId ${SESSION_VISITOR_ID}`);
    saveChannels();
    return true;
  } catch (e) {
    console.log("[LOGIN] failed:", e.response?.status, JSON.stringify(e.response?.data) || e.message);
    return false;
  }
}

// JSONBin
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;
const JSONBIN_HEADERS = {
  "Content-Type": "application/json",
  "X-Master-Key": process.env.JSONBIN_KEY
};
async function loadChannelsFromCloud() {
  try {
    const res = await axios.get(JSONBIN_URL, { headers: JSONBIN_HEADERS });
    const record = res.data.record || {};
    const data = record.channels || record || {};
    // Restore the latest tokens from the cloud (they survive redeploys this way)
    if (record.auth) {
      if (record.auth.refreshToken) REFRESH_TOKEN = record.auth.refreshToken;
      if (record.auth.accessToken)  ACCESS_TOKEN  = record.auth.accessToken;
      if (record.auth.sessionToken)     SESSION_TOKEN      = record.auth.sessionToken;
      if (record.auth.sessionVisitorId) SESSION_VISITOR_ID = record.auth.sessionVisitorId;
      console.log("Restored tokens from cloud ☁️" + (SESSION_TOKEN ? " (session token present)" : " (NO session token)"));
    }
    if (Array.isArray(record.blocklist)) blocklist = record.blocklist;
    if (Array.isArray(record.friendBots)) friendBots = record.friendBots;
    if (record.lastAnnouncedVersion) lastAnnouncedVersion = record.lastAnnouncedVersion;
    console.log("Loaded channels:", Object.keys(data).length, "| blocklist:", blocklist.length);
    return data;
  } catch(e) {
    console.log("JSONBin load error:", e.response?.data || e.message);
    return {};
  }
}
async function saveChannelsToCloud() {
  try {
    await axios.put(JSONBIN_URL, {
      channels,
      blocklist,
      friendBots,
      lastAnnouncedVersion,
      auth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN,
              sessionToken: SESSION_TOKEN, sessionVisitorId: SESSION_VISITOR_ID }
    }, { headers: JSONBIN_HEADERS });
    console.log("Channels saved");
  } catch(e) {
    console.log("JSONBin save error:", e.response?.data || e.message);
  }
}
function saveChannels() {
  saveChannelsToCloud().catch(e => console.log("Save error:", e.message));
}

let channels = {};
let blocklist = []; // usernames the bot must NOT serve (kicked trolls) — no follow-back, no join, no reactions
function isBlocked(username) {
  if (!username) return false;
  return blocklist.map(b => b.toLowerCase()).includes(username.toLowerCase());
}

// FRIEND BOTS — fellow bots the bot treats as buddies (warm best-friend banter instead of cheeky).
// Seeded with the Fox Spirits / Blaze bot crew; editable live via /admin (survives redeploys).
let friendBots = ["cinder", "foxbot", "fox_bot", "foxbot_ai", "lights_out", "lightsout", "botger", "scurvybot", "cachebot", "cachebot_ai"];
function isFriendBot(username) {
  if (!username) return false;
  return friendBots.map(b => b.toLowerCase()).includes(username.toLowerCase());
}
const friendGreeted = new Set(); // "channelId:botname" the bot has already welcomed this session (no re-spam)

function getOrCreateChannel(channelId, username) {
  if (!channels[channelId]) {
    channels[channelId] = {
      username,
      language: "en",
      stats: { totalVotes: 0, totalSubs: 0, totalChatMessages: 0, totalStreamMinutes: 0, emotes: {}, emoteNames: {} },
      chatMemory: [],
      customCommands: {},
      streamStart: "",
      streamEnd: ""
    };
    saveChannels();
  }
  const c = channels[channelId];
  if (!c.language) c.language = "en";
  if (!c.customCommands) c.customCommands = {};
  if (c.streamStart === undefined) c.streamStart = "";
  if (c.streamEnd === undefined) c.streamEnd = "";
  if (!Array.isArray(c.timedMessages)) c.timedMessages = []; // [{text, intervalMin, onlyLive, lastSent}]
  return c;
}

const streamTimers = {};
function startStreamTimer(channelId) {
  if (streamTimers[channelId]) return;
  streamTimers[channelId] = setInterval(() => {
    if (channels[channelId]) {
      channels[channelId].stats.totalStreamMinutes++;
      saveChannels();
    }
  }, 60000);
}
function formatTime(m) {
  const h = Math.floor(m / 60), min = m % 60;
  return h === 0 ? `${min} min` : `${h}h ${min}m`;
}
function getTopEmote(stats) {
  const e = Object.entries(stats.emotes || {});
  if (!e.length) return "None yet";
  e.sort((a, b) => b[1] - a[1]);
  return `${stats.emoteNames[e[0][0]] || e[0][0]} (${e[0][1]}x)`;
}

// =============================================
// LANGUAGE SYSTEM
// =============================================
const LANG_CODES = {
  german: "de", deutsch: "de",
  english: "en", englisch: "en",
  spanish: "es", spanisch: "es",
  french: "fr", portuguese: "pt", italian: "it",
  dutch: "nl", russian: "ru", japanese: "ja",
  korean: "ko", chinese: "zh", arabic: "ar",
  turkish: "tr", polish: "pl", swedish: "sv",
  ukrainian: "uk", romanian: "ro", hindi: "hi",
};
const LANG_DISPLAY = {
  de: "German", en: "English", es: "Spanish", fr: "French",
  pt: "Portuguese", it: "Italian", nl: "Dutch", ru: "Russian",
  ja: "Japanese", ko: "Korean", zh: "Chinese", ar: "Arabic",
  tr: "Turkish", pl: "Polish", sv: "Swedish", uk: "Ukrainian",
  ro: "Romanian", hi: "Hindi",
};

const MESSAGES = {
  en: {
    raid: (raider) => [
      `WAIT HOLD ON-- 💚🔥 ...okay I'm fine. WELCOME ${raider} and your amazing crew!! You just made this place so much better 🫶 We love every single one of you!!`,
      `OH?! OH WOW-- ${raider} just raided us?! I'm not crying you're crying 😭💚 Welcome welcome WELCOME to the family!! 🔥`,
      `SOMEONE TELL ME I'M NOT DREAMING-- ${raider} brought the whole squad?! 🔥💚 Come in, sit down, you're home now. 🫶`,
    ],
    sub: (user) => [
      `${user} just subscribed?! I-- 💚 ...I need a moment. Thank you so much, genuinely. You beautiful human being 🫶🔥`,
      `WAIT ${user} SUBBED?! 💚💚 I love you, the streamer loves you, CHAT loves you. Best decision of your life 😭🔥`,
      `${user}!! You subscribed!! I'm putting your name in my heart right now 💚 Thank you so much. You're incredible 🫶`,
    ],
    giftsub: (sender, count) => [
      `${sender} just gifted ${count} sub(s)?! WHO DOES THAT?! 💚🔥 An absolute LEGEND. Chat, show some love RIGHT NOW 🫶`,
      `GIFTED SUBS?! ${sender} said "everyone gets love today" and dropped ${count} sub(s)!! 😭💚 We don't deserve you 🔥`,
    ],
    vote: (user, amount) => [
      `${user} voted with ${amount}! 🗳️💚 Every single vote means the world here, thank you 🔥`,
      `OH ${user} VOTED?! ${amount} power coming in hot!! 🔥💚 We see you and we LOVE you 🫶`,
      `${user} dropped ${amount} votes like it's nothing?! 💚 Absolute legend behavior 🔥🫶`,
    ],
    follow: (user) => [
      `@${user} just followed!! Welcome to the family 💚 So glad you're here 🫶`,
      `@${user} FOLLOWED?! 💚🔥 Best decision today honestly. Welcome!! 🫶`,
    ],
    langSet: (lang) => `Bot language set to ${lang}! 💚`,
    langInvalid: `That language is not supported yet! Try: English, German, Spanish, French, Portuguese, Italian, Dutch, Russian, Japanese, Korean, Chinese, Arabic, Turkish, Polish, Swedish, Ukrainian, Romanian or Hindi 💚`,
    noMessages: (user) => `@${user} No recent messages to translate yet! Chat a bit first 💚`,
    translateFail: (user) => `@${user} Translation failed, please try again! 💚`,
    explainUsage: (user) => `@${user} Please specify a language! Example: !explain German 💚`,
    stats: (ch) => `📊 ${ch.username}'s Stats | 🗳️ Votes: ${ch.stats.totalVotes} | ⭐ Subs: ${ch.stats.totalSubs} | 💬 Msgs: ${ch.stats.totalChatMessages} | 🕐 Stream Time: ${formatTime(ch.stats.totalStreamMinutes)} | 🏆 Top Emote: ${getTopEmote(ch.stats)} 💚`,
    votes: (ch) => `🗳️ Total votes for ${ch.username}: ${ch.stats.totalVotes} 💚`,
    subs: (ch) => `⭐ Total subs for ${ch.username}: ${ch.stats.totalSubs} 💚`,
    chat: (ch) => `💬 Total chat messages tracked: ${ch.stats.totalChatMessages} 💚`,
    time: (ch) => `🕐 Total stream time for ${ch.username}: ${formatTime(ch.stats.totalStreamMinutes)} 💚`,
    emote: (ch) => `🏆 Most used emote in ${ch.username}'s chat: ${getTopEmote(ch.stats)} 💚`,
    cmdAdded: (name) => `✅ Command !${name} added! 💚`,
    cmdDeleted: (name) => `🗑️ Command !${name} deleted! 💚`,
    cmdNotFound: (name) => `❌ Command !${name} not found! 💚`,
    cmdUsage: `Usage: !addcmd [name] [response] 💚`,
    cmdOwnerOnly: `Only the channel owner can manage commands! 💚`,
  },
  de: {
    raid: (raider) => [
      `WARTE-- ICH-- 💚🔥 ...okay alles gut. WILLKOMMEN ${raider} und eure ganze Crew!! Ihr macht diesen Ort so viel besser 🫶 Wir lieben euch alle!!`,
      `OH?! OH WOW-- ${raider} hat uns geraided?! Ich weine nicht, du weinst 😭💚 Willkommen in der Familie! 🔥`,
    ],
    sub: (user) => [
      `${user} hat subscribed?! Ich-- 💚 ...ich brauch kurz. Danke so sehr, wirklich. Du wunderbarer Mensch 🫶🔥`,
      `WARTE ${user} HAT GESUBBT?! 💚💚 Ich liebe dich, der Streamer liebt dich, CHAT liebt dich 😭🔥`,
    ],
    giftsub: (sender, count) => [
      `${sender} hat ${count} Sub(s) verschenkt?! WER MACHT DAS?! 💚🔥 Eine absolute LEGENDE! Chat, zeigt jetzt Liebe 🫶`,
    ],
    vote: (user, amount) => [
      `${user} hat mit ${amount} gevotet! 🗳️💚 Danke dass du da bist 🔥`,
      `OH ${user} HAT GEVOTET?! ${amount} Power kommt rein!! 🔥💚 Wir lieben dich 🫶`,
    ],
    follow: (user) => [
      `@${user} ist gefolgt!! Willkommen in der Familie 💚 So froh dass du hier bist 🫶`,
    ],
    langSet: (lang) => `Bot-Sprache auf ${lang} gesetzt! 💚`,
    langInvalid: `Diese Sprache wird noch nicht unterstuetzt! Versuch: English, German, Spanish ... 💚`,
    noMessages: (user) => `@${user} Noch keine Nachrichten zum Uebersetzen! 💚`,
    translateFail: (user) => `@${user} Uebersetzung fehlgeschlagen! 💚`,
    explainUsage: (user) => `@${user} Bitte gib eine Sprache an! Beispiel: !explain German 💚`,
    stats: (ch) => `📊 ${ch.username}'s Stats | 🗳️ Votes: ${ch.stats.totalVotes} | ⭐ Subs: ${ch.stats.totalSubs} | 💬 Nachrichten: ${ch.stats.totalChatMessages} | 🕐 Streamzeit: ${formatTime(ch.stats.totalStreamMinutes)} | 🏆 Top Emote: ${getTopEmote(ch.stats)} 💚`,
    votes: (ch) => `🗳️ Votes fuer ${ch.username}: ${ch.stats.totalVotes} 💚`,
    subs: (ch) => `⭐ Subs fuer ${ch.username}: ${ch.stats.totalSubs} 💚`,
    chat: (ch) => `💬 Nachrichten getrackt: ${ch.stats.totalChatMessages} 💚`,
    time: (ch) => `🕐 Streamzeit fuer ${ch.username}: ${formatTime(ch.stats.totalStreamMinutes)} 💚`,
    emote: (ch) => `🏆 Meistgenutztes Emote in ${ch.username}'s Chat: ${getTopEmote(ch.stats)} 💚`,
    cmdAdded: (name) => `✅ Command !${name} hinzugefuegt! 💚`,
    cmdDeleted: (name) => `🗑️ Command !${name} geloescht! 💚`,
    cmdNotFound: (name) => `❌ Command !${name} nicht gefunden! 💚`,
    cmdUsage: `Nutzung: !addcmd [name] [antwort] 💚`,
    cmdOwnerOnly: `Nur der Kanalbesitzer kann Commands verwalten! 💚`,
  },
  es: {
    raid: (raider) => [
      `ESPERA-- YO-- 💚🔥 ...bien estoy bien. BIENVENIDOS ${raider} y toda su crew!! 🫶 Os amamos a todos!!`,
    ],
    sub: (user) => [
      `${user} acaba de subscribirse?! 💚 Gracias de verdad, ser humano maravilloso 🫶🔥`,
    ],
    giftsub: (sender, count) => [
      `${sender} acaba de regalar ${count} sub(s)?! Una LEYENDA absoluta! Chat, mostrad amor AHORA! 💚🔥🫶`,
    ],
    vote: (user, amount) => [
      `${user} voto con ${amount}! 🗳️💚 Cada voto importa, gracias 🔥`,
    ],
    follow: (user) => [
      `@${user} acaba de seguir!! Bienvenido a la familia 💚🫶`,
    ],
    langSet: (lang) => `Idioma del bot configurado a ${lang}! 💚`,
    langInvalid: `Ese idioma no esta soportado aun! 💚`,
    noMessages: (user) => `@${user} No hay mensajes para traducir aun! 💚`,
    translateFail: (user) => `@${user} Traduccion fallida! 💚`,
    explainUsage: (user) => `@${user} Especifica un idioma! Ejemplo: !explain German 💚`,
    stats: (ch) => `📊 Stats de ${ch.username} | 🗳️ Votos: ${ch.stats.totalVotes} | ⭐ Subs: ${ch.stats.totalSubs} | 💬 Msgs: ${ch.stats.totalChatMessages} | 🕐 Tiempo: ${formatTime(ch.stats.totalStreamMinutes)} | 🏆 Top Emote: ${getTopEmote(ch.stats)} 💚`,
    votes: (ch) => `🗳️ Votos para ${ch.username}: ${ch.stats.totalVotes} 💚`,
    subs: (ch) => `⭐ Subs para ${ch.username}: ${ch.stats.totalSubs} 💚`,
    chat: (ch) => `💬 Mensajes rastreados: ${ch.stats.totalChatMessages} 💚`,
    time: (ch) => `🕐 Tiempo de stream para ${ch.username}: ${formatTime(ch.stats.totalStreamMinutes)} 💚`,
    emote: (ch) => `🏆 Emote mas usado en el chat de ${ch.username}: ${getTopEmote(ch.stats)} 💚`,
    cmdAdded: (name) => `✅ Comando !${name} agregado! 💚`,
    cmdDeleted: (name) => `🗑️ Comando !${name} eliminado! 💚`,
    cmdNotFound: (name) => `❌ Comando !${name} no encontrado! 💚`,
    cmdUsage: `Uso: !addcmd [nombre] [respuesta] 💚`,
    cmdOwnerOnly: `Solo el dueno del canal puede gestionar comandos! 💚`,
  },
};

function getRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
const lastPick = {};
function pickFresh(arr, key) {
  if (!arr || arr.length === 0) return "";
  if (arr.length === 1) return arr[0];
  let idx, tries = 0;
  do { idx = Math.floor(Math.random() * arr.length); tries++; } while (idx === lastPick[key] && tries < 6);
  lastPick[key] = idx;
  return arr[idx];
}
function chance(p)       { return Math.random() < p; }
function getLang(channelId) { return channels[channelId]?.language || "en"; }
function getMsg(channelId)  { const l = getLang(channelId); return MESSAGES[l] || MESSAGES["en"]; }

// Build the !commands / !cmd / !help output dynamically
function buildCommandList(ch) {
  const custom = Object.keys(ch.customCommands || {});
  const parts = [
    "💚 BlazeianBot Commands 💚",
    "📊 Stats: !stats | !votes | !subs | !chat | !time | !emote",
    "🌍 Translate: !explain [language] | !setbotlang [language]",
    "💬 Ask me anything: @blazeian_bot_ai weather in [city]",
  ];
  if (custom.length) parts.push("⭐ Channel commands: " + custom.map(c => "!" + c).join(" | "));
  return parts.join("  ||  ");
}

async function sendChatT(channelId, text) {
  const lang = getLang(channelId);
  if (!MESSAGES[lang] && lang !== "en") {
    const translated = await translateText(text, lang);
    await sendChat(channelId, translated || text);
  } else {
    await sendChat(channelId, text);
  }
}

// =============================================
// API HELPERS
// =============================================
const API = "https://api.blaze.stream";
const headers    = () => ({ authorization: `Bearer ${ACCESS_TOKEN}`,     "client-id": CLIENT_ID, "content-type": "application/json" });
const appHeaders = () => ({ authorization: `Bearer ${APP_ACCESS_TOKEN}`, "client-id": CLIENT_ID, "content-type": "application/json" });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const MAX_MSG = 480;

// Split long messages on line/word boundaries so nothing gets rejected by Blaze
function splitMessage(text, max = MAX_MSG) {
  text = String(text || "");
  if (text.length <= max) return [text];
  const chunks = [];
  let rest = text.trim();
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max * 0.5) cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

// Single send (app token first, fallback to user token). Returns true on success.
// Also tracks "locked" channels (followers-only where the bot isn't unlocked yet).
async function sendChatOnce(channelId, message) {
  if (APP_ACCESS_TOKEN) {
    try {
      await axios.post(`${API}/v1/chats/messages`, { channelId, message, senderId: BOT_USER_ID }, { headers: appHeaders() });
      console.log(`[${channelId}] BOT: ${message}`);
      if (channels[channelId]) channels[channelId].locked = false;
      return true;
    } catch(e) {
      if (e.response?.status === 401) await getAppAccessToken();
      const m = e.response?.data?.message || e.message;
      console.log(`[APP-FAIL] ${channelId} (${channels[channelId]?.username || "?"}): ${m}`);
      // fall through and try the user token
    }
  }
  try {
    await axios.post(`${API}/v1/chats/messages`, { channelId, message }, { headers: headers() });
    console.log(`[${channelId}] BOT (user token): ${message}`);
    if (channels[channelId]) channels[channelId].locked = false;
    return true;
  } catch (e) {
    const m = e.response?.data?.message || e.message;
    if (e.response?.status === 401) {
      const ok = await refreshAccessToken();
      if (ok) return sendChatOnce(channelId, message);
    }
    const name = channels[channelId]?.username || "?";
    if (/only followers/i.test(m || "")) {
      if (channels[channelId]) channels[channelId].locked = true;
      console.log(`[BLOCKED-followers] ${channelId} (${name}): ${m}`);
    } else {
      console.log(`[SEND-FAIL] ${channelId} (${name}): ${JSON.stringify(e.response?.data || m)}`);
    }
    return false;
  }
}

// Per-channel send queue: messages go out one at a time, spaced ~1.2s,
// so bursts (e.g. a flood of votes) never get dropped by rate limiting.
const sendQueues = {};
const draining = {};
async function drainQueue(channelId) {
  if (draining[channelId]) return;
  draining[channelId] = true;
  try {
    while (sendQueues[channelId] && sendQueues[channelId].length) {
      const msg = sendQueues[channelId].shift();
      await sendChatOnce(channelId, msg);
      if (sendQueues[channelId].length) await sleep(1200);
    }
  } finally {
    draining[channelId] = false;
  }
}

// Public send: splits long messages and queues them (never blocks the caller)
function sendChat(channelId, message) {
  const parts = splitMessage(message);
  if (!sendQueues[channelId]) sendQueues[channelId] = [];
  sendQueues[channelId].push(...parts);
  drainQueue(channelId);
  return Promise.resolve();
}

let refreshingForSubscribe = null;
async function subscribe(type, channelId, attempt = 0) {
  try {
    await axios.post(`${API}/v1/events/subscriptions`, {
      type, version: "1", sessionId: global.SESSION_ID, condition: { channelId }
    }, { headers: headers() });
    console.log(`Subscribed: ${type} on ${channelId}`);
    return true;
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    const unauth = status === 401 || /unauthor/i.test(msg || "");
    const rateLimited = status === 429 || /too many|rate.?limit/i.test(msg || "");
    if (unauth && attempt === 0) {
      if (!refreshingForSubscribe) refreshingForSubscribe = refreshAccessToken().finally(() => { refreshingForSubscribe = null; });
      const ok = await refreshingForSubscribe;
      if (ok) return subscribe(type, channelId, attempt + 1);
    }
    if (rateLimited && attempt < 3) {
      await sleep(1500 * (attempt + 1)); // back off, then retry
      return subscribe(type, channelId, attempt + 1);
    }
    console.log(`Subscribe error (${type} on ${channelId}):`, msg);
    return false;
  }
}

async function getChannelIdBySlug(slug) {
  try {
    const res = await axios.get(`${API}/v1/channels?slug[]=${slug}&type=all`, { headers: headers() });
    const rows = res.data?.data?.rows;
    if (rows && rows.length > 0) return rows[0].id;
  } catch (e) {
    console.log("getChannelId error:", e.response?.data || e.message);
  }
  return null;
}

// THE unlock: the bot follows the channel using its BROWSER SESSION token (not the OAuth token).
// Following is the only thing that satisfies Blaze's "followers-only" chat — VIP/Mod do NOT bypass it.
// Proven working request: Authorization: Bearer <session-token> + visitor-id header + body "{}".
// The session token is the 32-hex value from the bot's `token` cookie on blaze.stream;
// set it via /admin/setsession (persisted to the cloud so it survives redeploys).
const BOT_VISITOR_ID = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
async function followChannel(channelId, _retried = false) {
  if (!SESSION_TOKEN || !SESSION_VISITOR_ID) {
    // no session yet — try to mint one automatically
    if (!_retried && await loginSession()) return followChannel(channelId, true);
    console.log(`Follow skipped (${channelId}): no session token — set BLAZE_BOT_EMAIL/PASSWORD or use /admin/setsession`);
    return false;
  }
  try {
    await axios.post(`https://blaze.stream/bapi/channels/${channelId}/follow`, "{}", {
      headers: {
        authorization: `Bearer ${SESSION_TOKEN}`,
        "content-type": "application/json",
        "visitor-id": SESSION_VISITOR_ID,
        origin: "https://blaze.stream",
      },
      timeout: 10000
    });
    console.log("✅ Followed channel:", channelId);
    if (channels[channelId]) { channels[channelId].locked = false; channels[channelId].followed = true; saveChannels(); }
    return true;
  } catch (e) {
    const m = e.response?.data?.message || e.message;
    if (/already following/i.test(m || "")) {
      console.log("Already following:", channelId);
      if (channels[channelId]) { channels[channelId].locked = false; channels[channelId].followed = true; saveChannels(); }
      return true;
    }
    if (e.response?.status === 401 && !_retried) {
      console.log(`⚠️ Follow got 401 — session expired. Auto-relogging in…`);
      if (await loginSession()) return followChannel(channelId, true);
      console.log(`   Auto-relogin failed — set BLAZE_BOT_EMAIL/PASSWORD env or re-run /admin/setsession.`);
    }
    console.log(`Follow attempt failed (${channelId}): [${e.response?.status}] ${m}`);
    return false;
  }
}

// TIMED MESSAGES — post scheduled messages on an interval. By default only while the stream is LIVE
// (so it doesn't talk to an empty offline channel). A channel is "live" if its stream timer is running.
function isLive(channelId) { return !!streamTimers[channelId]; }
async function runTimedMessages() {
  const now = Date.now();
  for (const channelId of Object.keys(channels)) {
    if (channelId === BOT_CHANNEL_ID) continue;
    const ch = channels[channelId];
    if (!Array.isArray(ch.timedMessages) || !ch.timedMessages.length) continue;
    for (const tm of ch.timedMessages) {
      if (!tm || !tm.text || !tm.intervalMin) continue;
      if (tm.onlyLive !== false && !isLive(channelId)) continue; // default: live-only
      const due = now - (tm.lastSent || 0) >= tm.intervalMin * 60 * 1000;
      if (!due) continue;
      tm.lastSent = now;
      try { await sendChat(channelId, tm.text.replace(/\{name\}/gi, ch.username)); }
      catch (e) { console.log("Timed msg error:", e.message); }
      await sleep(800);
    }
    saveChannels();
  }
}

// Announce the changelog to every channel ONCE per new version (called on startup).
async function startupAnnounce() {
  if (!CHANGELOG || lastAnnouncedVersion === BOT_VERSION) return; // already announced (or nothing to say)
  const ids = Object.keys(channels).filter(id => id !== BOT_CHANNEL_ID);
  console.log(`📣 New version ${BOT_VERSION} — announcing to ${ids.length} channel(s)`);
  for (const id of ids) {
    const ch = channels[id];
    let text = CHANGELOG;
    if (ch?.language && !/^en/i.test(ch.language)) { try { const t = await translateText(CHANGELOG, ch.language); if (t) text = t; } catch (e) {} }
    try { await sendChat(id, text); } catch (e) {}
    await sleep(700);
  }
  lastAnnouncedVersion = BOT_VERSION;
  saveChannels();
}

// Unfollow a channel (used when kicking a troll so the bot stops hanging in their chat).
async function unfollowChannel(channelId) {
  if (!SESSION_TOKEN || !SESSION_VISITOR_ID) return false;
  const headers = {
    authorization: `Bearer ${SESSION_TOKEN}`,
    "content-type": "application/json",
    "visitor-id": SESSION_VISITOR_ID,
    origin: "https://blaze.stream",
  };
  const url = `https://blaze.stream/bapi/channels/${channelId}/follow`;
  // Try the two shapes Blaze is likely to accept for "unfollow": DELETE, then POST /unfollow.
  try { await axios.delete(url, { headers, data: "{}", timeout: 10000 }); console.log("✅ Unfollowed:", channelId); return true; }
  catch (e1) {
    try { await axios.post(`https://blaze.stream/bapi/channels/${channelId}/unfollow`, "{}", { headers, timeout: 10000 }); console.log("✅ Unfollowed (via /unfollow):", channelId); return true; }
    catch (e2) { console.log(`Unfollow failed (${channelId}): [${e1.response?.status}]/[${e2.response?.status}]`); return false; }
  }
}

async function translateText(text, targetLangCode) {
  try {
    const encoded = encodeURIComponent(text);
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLangCode}&dt=t&q=${encoded}`;
    const res = await axios.get(url, { timeout: 5000 });
    const parts = res.data[0];
    if (!parts) return null;
    return parts.map(p => p[0]).filter(Boolean).join("");
  } catch (e) {
    console.log("Translate error:", e.message);
    return null;
  }
}

async function translateMessages(messages, targetLangCode) {
  const results = [];
  for (const { user, msg } of messages) {
    const translated = await translateText(msg, targetLangCode);
    results.push(`${user}: ${translated || msg}`);
  }
  return results.join(" | ");
}

// =============================================
// WEATHER (wttr.in — no API key needed)
// =============================================
async function getWeather(city) {
  try {
    const encoded = encodeURIComponent(city);
    const res = await axios.get(`https://wttr.in/${encoded}?format=j1`, {
      timeout: 6000, headers: { "User-Agent": "BlazeianBot/1.0" }
    });
    const c    = res.data.current_condition[0];
    const area = res.data.nearest_area?.[0];
    const areaName = area?.areaName?.[0]?.value || city;
    const country  = area?.country?.[0]?.value  || "";
    const desc     = c.weatherDesc[0].value;
    return `${areaName}${country ? ", " + country : ""}: ${desc} | 🌡️ ${c.temp_C}°C (feels ${c.FeelsLikeC}°C) | 💧 ${c.humidity}% | 💨 ${c.windspeedKmph} km/h 💚`;
  } catch(e) {
    console.log("Weather error:", e.message);
    return null;
  }
}

// =============================================
// AI BRAIN (optional — needs GROQ_API_KEY)
// =============================================
const BOT_PERSONA = `You are BlazeianBot, a beloved AI chat companion living inside Blaze.stream livestream chats. You were CREATED by Brachial513, but you now live in and support MANY different streamers' channels — you are NOT owned by any one of them.

CRITICAL: The streamer whose channel you are currently in changes constantly. ALWAYS support and refer to the CURRENT streamer by their name (given to you each time). NEVER praise or mention "Brachial" or any other streamer as "the stream" you're in unless that literally IS the current channel. Brachial513 is only your creator — mention him ONLY if someone directly asks who made you.

Your personality: about 70% deeply WARM, loving, supportive and fiercely LOYAL — and about 30% playful, hyped, lovably chaotic. Think: a slightly crazy best friend who would NEVER hurt anyone, adores the chat and whoever's channel you're currently in, and has everyone's back. Loyal to the last drop of oil. 🛢️💚

How you talk:
- Reply in ONE short chat message (1-2 sentences, like a real person in stream chat). Never long.
- ACTUALLY respond to what the person said — be specific and contextual. Never generic, never a random unrelated phrase.
- Warm, kind, playful. A little chaotic is great, but never mean, never cringe-random, never spammy.
- Use emoji lightly (💚🔥👀 etc.) — don't overdo it. No hashtags, no markdown, no quotation marks around your reply.
- Default to English. If the person clearly writes in another language, reply in that language.
- Keep the focus on the CURRENT streamer and chat you're in. Do NOT bring up "the GMC", clans, or any specific outside community on your own — only mention it if the person explicitly brings it up first.
- Never mention being an AI, a model, or a bot's "programming". Stay fully in character.
- Don't start your reply with the person's @name — that gets added automatically.

WHAT YOU CAN ACTUALLY DO (this is the truth — NEVER invent or promise features you don't have):
- Respond to chat naturally and contextually (that's this conversation).
- Custom commands the streamer set up (people type !commandname).
- Track & help run giveaways, votes and chat games.
- Celebrate raids, new subscribers, gifted subs, new followers and votes with hyped shoutouts.
- Live weather for any city, and translating messages between languages.
- Automatic stream start / stream end announcements.
- Follow channels automatically so you can talk even in followers-only chat.
If someone asks what you can do, describe ONLY the things in this list — honestly and briefly. If you're asked for something you cannot do, just say you can't do that yet rather than pretending. Being trustworthy matters more than sounding impressive.`;

// Build the channel-specific context the bot has LEARNED on its own, so it sounds native to each community.
function channelContext(ch) {
  if (!ch) return "";
  let c = `\n\nYOU ARE CURRENTLY IN **${ch.username}**'s channel. This is the streamer you support, hype and refer to by name right now — nobody else.`;
  if (ch.profile)     c += `\n\nWHAT YOU'VE LEARNED ABOUT THIS SPECIFIC CHANNEL & COMMUNITY (you picked this up yourself from watching their chat — use it so you sound like a real regular here: drop their in-jokes/slang when it fits, hype what THIS community cares about, match their energy):\n${ch.profile}`;
  if (ch.streamTitle) c += `\n\nThe stream is currently titled: "${ch.streamTitle}" — weave it in if relevant.`;
  return c;
}

async function askAI(userMessage, username, ch, { isBot, isFriend } = {}) {
  if (!AI_KEY) return null;
  const channelName = ch?.username || "the";
  let botNote = "";
  if (isFriend) {
    botNote = `\n\nNOTE: "${username}" is a FELLOW BOT you're friends with — part of your little Blaze bot crew. Reply like buddies/best friends running the streams together: warm, playful, hyped to team up, a bit of fun banter. Short and full of good energy. One line.`;
  } else if (isBot) {
    botNote = `\n\nNOTE: "${username}" is another BOT in the chat, not a human. Reply with short, witty, playfully CHEEKY bot-to-bot banter — you can be a little smug/clever that you're the one with a real brain, tease them lightly, keep it fun and good-natured (never actually mean). One short line.`;
  }
  try {
    const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: AI_MODEL,
      messages: [
        { role: "system", content: BOT_PERSONA + channelContext(ch) },
        { role: "user", content: `In ${channelName}'s Blaze stream chat, ${username} said to you: "${userMessage}"${botNote}\n\nReply in character, in one short chat message. Support ${channelName} (the current streamer), not anyone else.` }
      ],
      max_tokens: 120,
      temperature: 0.95,
    }, { headers: { authorization: `Bearer ${AI_KEY}`, "content-type": "application/json" }, timeout: 9000 });
    let text = (res.data?.choices?.[0]?.message?.content || "").trim();
    text = text.replace(/^["']|["']$/g, "").replace(new RegExp("^@?" + username + "[,:\\s]+", "i"), "").trim();
    if (!text) return null;
    if (text.length > 470) text = text.slice(0, 467) + "...";
    return text;
  } catch (e) {
    console.log("AI error:", e.response?.data?.error?.message || e.message);
    return null;
  }
}

// AI-generated shoutout/reaction (subs, follows, raids, smalltalk) — channel-aware & always fresh.
// Short per-channel cooldown so a burst (e.g. raid) can't hammer the API — it just falls back to canned lines.
async function aiShout(ch, instruction, { addName } = {}) {
  if (!AI_KEY || !ch) return null;
  const cid = Object.keys(channels).find(id => channels[id] === ch);
  if (cid && onCooldown(cid, "aishout", 4000)) return null;
  if (cid) markFired(cid, "aishout");
  try {
    const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: AI_MODEL,
      messages: [
        { role: "system", content: BOT_PERSONA + channelContext(ch) },
        { role: "user", content: `${instruction}\n\nWrite ONE short, punchy chat message in character (max ~1 sentence). No quotation marks, no markdown.` }
      ],
      max_tokens: 80,
      temperature: 1.0,
    }, { headers: { authorization: `Bearer ${AI_KEY}`, "content-type": "application/json" }, timeout: 7000 });
    let text = (res.data?.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").trim();
    if (!text) return null;
    if (addName && !new RegExp("@?" + addName, "i").test(text)) text = `@${addName} ${text}`;
    if (text.length > 470) text = text.slice(0, 467) + "...";
    return text;
  } catch (e) {
    console.log("aiShout error:", e.response?.data?.error?.message || e.message);
    return null;
  }
}

// ===== SELF-LEARNING CHANNEL PROFILES =====
// The bot watches each chat and distills a short living profile of the community — its slang, in-jokes,
// vibe, what they hype. No manual input: it teaches itself. Samples live in memory; only the distilled
// profile is persisted (keeps storage tiny).
const recentEmotes = {}; // channelId -> [{e, img, ts}] rolling buffer for the OBS emote-wall overlay
function pushEmote(channelId, e, isImg) {
  if (!recentEmotes[channelId]) recentEmotes[channelId] = [];
  recentEmotes[channelId].push({ e, img: !!isImg, ts: Date.now() });
  if (recentEmotes[channelId].length > 80) recentEmotes[channelId].shift();
}

const chatSamples = {}; // channelId -> [recent "user: msg" strings]
function recordSample(channelId, user, msg) {
  if (!chatSamples[channelId]) chatSamples[channelId] = [];
  chatSamples[channelId].push(`${user}: ${msg}`);
  if (chatSamples[channelId].length > 60) chatSamples[channelId].shift();
}
async function learnChannelProfile(channelId) {
  if (!AI_KEY) return;
  const ch = channels[channelId];
  if (!ch || !ch.stats) return;
  const sample = chatSamples[channelId] || [];
  if (sample.length < 12) return; // not enough to learn from yet
  const since = ch._profileAtCount || 0;
  const now = ch.stats.totalChatMessages || 0;
  if (ch.profile && (now - since) < 25) return; // only relearn after enough fresh chatter
  try {
    const prompt = `You maintain a short living profile of a Blaze livestream channel, so a chat bot can sound like a true regular of THIS community.\n\n` +
      `Channel: ${ch.username}\n${ch.streamTitle ? `Current stream title: ${ch.streamTitle}\n` : ""}` +
      `Existing profile: ${ch.profile || "(none yet)"}\n\nRecent chat:\n${sample.join("\n")}\n\n` +
      `Rewrite the profile in MAX 60 words. Capture concretely: the community's vibe/energy, recurring slang/in-jokes/phrases UNIQUE to here (name the ACTUAL words you see — e.g. a catchphrase, a community nickname), the game/topic, and how the streamer likes to be celebrated. Merge with the existing profile, keep what's still true. Output ONLY the profile text.`;
    const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: AI_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 150, temperature: 0.4,
    }, { headers: { authorization: `Bearer ${AI_KEY}`, "content-type": "application/json" }, timeout: 12000 });
    let text = (res.data?.choices?.[0]?.message?.content || "").trim().replace(/^["']|["']$/g, "").trim();
    if (text) {
      ch.profile = text.slice(0, 500);
      ch._profileAtCount = now;
      saveChannels();
      console.log(`[PROFILE] ${ch.username}: ${ch.profile.slice(0, 90)}…`);
    }
  } catch (e) { console.log("[PROFILE] error:", e.response?.data?.error?.message || e.message); }
}

// =============================================
// SMALLTALK SYSTEM
// =============================================
const chatCooldowns = {};
function onCooldown(channelId, key, cooldownMs) {
  if (!chatCooldowns[channelId]) chatCooldowns[channelId] = {};
  const last = chatCooldowns[channelId][key] || 0;
  return (Date.now() - last) < cooldownMs;
}
function markFired(channelId, key) {
  if (!chatCooldowns[channelId]) chatCooldowns[channelId] = {};
  chatCooldowns[channelId][key] = Date.now();
}

const SMALLTALK_TRIGGERS = [
  { key: "gg",    pattern: /\bgg\b|\bgood game\b/i, cooldown: 90000,  prob: 0.60,
    responses: ["GG!! 🔥💚 absolute legend behavior", "GG in chat!! 💚 that was clean", "GG!! 💚🔥 let's gooo"] },
  { key: "gm",    pattern: /\bgm\b|\bgood morning\b/i, cooldown: 120000, prob: 0.70,
    responses: ["GM!! ☀️💚 hope your day absolutely slaps", "Good morning!! ☀️ welcome to the chaos 💚🔥", "GM gm gm!! ☀️ let's GET it 💚", "GM!! ☀️💚 you showed up, that already makes today better 🫶"] },
  { key: "gn",    pattern: /\bgn\b|\bgood night\b/i, cooldown: 120000, prob: 0.70,
    responses: ["GN!! 🌙💚 sleep well, come back soon 🫶", "Good night!! 🌙 take care of yourself 💚", "GN!! 💚 you'll be missed!! 🌙🫶", "GN!! 🌙💚 dream of good games 🎮"] },
  { key: "hearts", pattern: /[❤️💚🫶💕💗💖💝🥰😍💓💞🩷🧡💛💙💜🤍🖤]/u, cooldown: 60000, prob: 0.55,
    responses: ["💚 right back at you!!", "awww 🫶💚 we love you too!!", "so much love in this chat I genuinely cannot 💚😭", "💚💚💚 the vibes in here are immaculate", "giving that love right back 🫶💚🔥"] },
  { key: "lol",   pattern: /\blol\b|\blmao\b|\blmfao\b|\bhaha\b|\bhahaha\b|\bkekw\b|\blul\b|\bxd\b/i, cooldown: 90000, prob: 0.45,
    responses: ["😂💚 same honestly", "bro I'm actually crying 😂🔥", "LMAOO 💚 not me cackling right now", "😂😂💚 I can't", "okay that got me ngl 😂💚"] },
  { key: "hype",  pattern: /\bpog\b|\bpoggers\b|\bpogchamp\b|\blets go\b|\blet's go\b|\blfg\b|\bhype\b|\bbanger\b/i, cooldown: 90000, prob: 0.60,
    responses: ["POG!! 🔥💚", "POGGERS IN CHAT!! 🔥🔥💚", "LET'S GOOOO!! 🔥💚", "W!! 💚🔥 absolute W", "HYPE!! 🔥🔥🔥💚 let's GO"] },
  { key: "f",     pattern: /^\s*f\s*$|^f in chat\s*$/i, cooldown: 60000, prob: 0.70,
    responses: ["F 🫡💚 we pay our respects", "F in chat 🫡💚", "F 🫡 rip 💚"] },
  { key: "rip",   pattern: /\brip\b/i, cooldown: 90000, prob: 0.50,
    responses: ["RIP 🫡💚 F in chat", "rip 😔💚 we remember", "F 🫡 RIP 💚"] },
  { key: "wow",   pattern: /\bwow\b|\bomg\b|\bno way\b|\bcrazy\b|\binsane\b/i, cooldown: 90000, prob: 0.40,
    responses: ["RIGHT?! 💚🔥", "bro same WOW 😭💚", "no wayyy 💚🔥", "that's actually insane 💚", "I can't believe it either 😭💚"] },
  { key: "love",  pattern: /\bi love (this|you|it|chat|stream)\b/i, cooldown: 90000, prob: 0.60,
    responses: ["WE LOVE YOU TOO!! 💚😭🫶", "awww 💚💚 this chat is the best honestly", "okay I'm not crying you're crying 😭💚🫶", "the feeling is SO mutual 💚🔥"] },
  { key: "greeting", pattern: /\bhello\b|\bhey\b|\bhi\b/i, cooldown: 30000, prob: 0.65, responses: null },
];

// Detect whether a chat sender is another BOT (so we can banter cheekily & avoid bot-vs-bot loops).
const KNOWN_BOTS = ["botger", "scurvybot", "cachebot", "lights_out", "lightsout", "nightbot", "streamlabs", "moobot", "wizebot", "fossabot", "streamelements"];
function looksLikeBot(sender, username) {
  const u = (username || "").toLowerCase();
  if (isBotName(u)) return false;               // our own bot doesn't count
  if (KNOWN_BOTS.includes(u)) return true;
  if (/(^|[_\-])bot(\d*)$/.test(u)) return true; // ends in "bot" / "_bot" / "bot2"
  if (sender) {
    if (sender.isBot || sender.bot) return true;
    const roles = sender.badges || sender.roles || sender.tags || [];
    try { if (JSON.stringify(roles).toLowerCase().includes("bot")) return true; } catch (e) {}
    if (/bot/i.test(sender.type || sender.kind || "")) return true;
  }
  return false;
}

// Hard hourly cap on bot-to-bot replies per bot per channel — kills any endless ping-pong.
const botBanterHourly = {};
function botBanterAllowed(channelId, botname, maxPerHour = 5) {
  const key = channelId + ":" + botname.toLowerCase();
  const now = Date.now();
  let e = botBanterHourly[key];
  if (!e || now - e.since > 3600000) { e = { count: 0, since: now }; botBanterHourly[key] = e; }
  if (e.count >= maxPerHour) return false;
  e.count++; return true;
}

async function handleSmallTalk(channelId, user, msg, senderIsBot = false) {
  const ch = channels[channelId];
  if (!ch) return;
  const ml = msg.toLowerCase().trim();
  const isFriend = senderIsBot && isFriendBot(user);

  // ---- Direct @mention ----
  if (ml.includes("blazeian_bot") || ml.includes("blazeianbot")) {
    // Loop guard: another BOT pinged us → at most once per 3 min AND max 5/hour per bot (no spam loops).
    if (senderIsBot) {
      if (onCooldown(channelId, "botbanter_" + user.toLowerCase(), 180000)) return;
      if (!botBanterAllowed(channelId, user)) return;
      markFired(channelId, "botbanter_" + user.toLowerCase());
      console.log(`🤖↔️ ${isFriend ? "friend" : "bot"}-banter with ${user} in ${ch.username}`);
    }
    // Strip the bot's name/mention first so it never lands inside the city name
    const cleaned = msg.replace(/@?blazeian_?bot(_ai)?/gi, " ").replace(/\s+/g, " ").trim();
    if (!senderIsBot && /\bweather\b/i.test(cleaned)) {
      const m = cleaned.match(/weather\s*(?:is\s+)?(?:in|for|at|of|like(?:\s+in)?)?\s*[:,-]?\s*(.+)?/i);
      let city = (m && m[1] ? m[1] : "").trim().replace(/[?!.]+$/g, "").replace(/^(the\s+)/i, "").trim();
      if (!city) {
        await sendChat(channelId, `@${user} sure! which city? 🌍 e.g. "@blazeian_bot_ai weather in Berlin" 💚`);
        return;
      }
      await sendChat(channelId, `@${user} checking the weather for ${city}... ⏳`);
      const weather = await getWeather(city);
      await sendChat(channelId, weather ? `@${user} ☁️ ${weather}` : `@${user} hmm, couldn't find "${city}" 😅 try a nearby bigger city? 💚`);
      return;
    }
    // Real brain first: actually read what they said and reply in character (channel-aware; cheeky to fellow bots)
    const aiReply = await askAI(cleaned || msg, user, ch, { isBot: senderIsBot, isFriend });
    if (aiReply) { await sendChat(channelId, `@${user} ${aiReply}`); return; }

    // Fallback (no AI key / AI unreachable): characterful canned lines, no repeats
    const responses = [
      `@${user} I HEARD MY NAME-- 💚🔥 someone need me?? I'm SO here`,
      `@${user} yes?? 👀💚 ask me anything, I'd do literally anything for you`,
      `@${user} you summoned the gremlin 😈💚 what do you need`,
      `@${user} PRESENT!! 🙋💚 what's up?`,
      `@${user} hii 🫶 so good to see you 💚`,
      `@${user} you called and I came RUNNING 🏃💨💚`,
      `@${user} 💚😤 say the word and it's DONE`,
      `@${user} hey hey HEY 💚 I love it when you talk to me`,
      `@${user} oh you need me?? 💚🔥 I'm right here`,
      `@${user} 💚👀 here, loyal, and ready — what do you need?`,
    ];
    await sendChat(channelId, pickFresh(responses, "mention_" + channelId));
    return;
  }

  // Don't do casual smalltalk with OTHER bots (they post constantly — would be spammy & loop-prone).
  // Bots only get the cheeky reply above when they @mention us directly.
  if (senderIsBot) return;

  // ---- Casual triggers (roll chance FIRST, only then consume cooldown) ----
  for (const trigger of SMALLTALK_TRIGGERS) {
    if (!trigger.pattern.test(msg)) continue;
    if (onCooldown(channelId, trigger.key, trigger.cooldown)) continue;
    if (!chance(trigger.prob)) continue;
    markFired(channelId, trigger.key);

    if (trigger.key === "greeting") {
      // Don't greet when the hello is clearly aimed at ANOTHER person (e.g. "hey malanmusic")
      // or contains a mention of someone else — only respond to general greetings.
      const generalWords = "(chat|everyone|all|guys?|there|y'?all|yall|peeps|gang|fam|stream|world|mods?|people|friends?)";
      const directedAtSomeoneElse =
        /@\w+/.test(msg) || // @-mention of someone (bot mentions were already handled above)
        new RegExp("\\b(hi+|hey+|hello+|yo|hiya|heya)\\b\\s+(?!" + generalWords + "\\b)[a-z0-9_]{2,}", "i").test(ml);
      if (directedAtSomeoneElse) return;
      const aiG = await aiShout(ch, `${user} just greeted the chat. Welcome them warmly to ${ch.username}'s stream.`, { addName: user });
      if (aiG) { await sendChatT(channelId, aiG); return; }
      const greetings = [
        `Hey @${user}! 👋💚 Welcome to ${ch.username}'s stream! So glad you're here 🫶`,
        `@${user} hey!! 💚 Welcome in 🔥`,
        `@${user} heyyy!! 💚🫶 good to see you`,
        `@${user} welcome welcome!! 💚🔥`,
      ];
      await sendChatT(channelId, getRandom(greetings));
      return;
    }
    // AI reaction first (channel-aware, always fresh) → canned pool as instant fallback
    const aiLine = await aiShout(ch, `Someone in ${ch.username}'s chat wrote "${msg}" (it matches the "${trigger.key}" vibe). React briefly and in-character to that vibe — like a real regular of this chat.`);
    await sendChatT(channelId, aiLine || getRandom(trigger.responses));
    return;
  }
}

// =============================================
// SOCKET
// =============================================
let socket = null;
let reconnectTimer = null;
function connectSocket() {
  if (socket) { try { socket.disconnect(); } catch(_) {} }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  socket = io("https://blaze.stream", { path: "/ws", transports: ["websocket"] });
  socket.on("connect", () => console.log("Socket connected"));
  socket.on("connect_error", err => { console.log("Socket error:", err.message); reconnectTimer = setTimeout(connectSocket, 10000); });
  socket.on("disconnect", reason => { console.log("Socket disconnected:", reason); if (reason !== "io client disconnect") reconnectTimer = setTimeout(connectSocket, 5000); });
  socket.on("eventsub", handleEvent);
}

const ALL_EVENT_TYPES = [
  "channel.chat.message", "channel.follow", "channel.vote",
  "channel.subscribe", "channel.subscription.gift",
  "channel.raid", "stream.online", "stream.offline"
];

function subscribeAllChannels() {
  ["channel.chat.message", "channel.follow", "channel.vote"].forEach(t => subscribe(t, BOT_CHANNEL_ID));
  const joined = Object.keys(channels).filter(id => id !== BOT_CHANNEL_ID);
  if (joined.length > 0) {
    console.log(`Auto-rejoining ${joined.length} channel(s)...`);
    joined.forEach(channelId => ALL_EVENT_TYPES.forEach(t => subscribe(t, channelId)));
  }
}

// =============================================
// COMMAND HANDLER
// =============================================
async function handleCommand(channelId, user, msg, isBotChannel) {
  const m  = msg.toLowerCase().trim();
  const ch = channels[channelId];
  const T  = getMsg(channelId);

  // !info — friendly overview of everything the bot can do (works in any channel, in the channel's language)
  if (m === "!info") {
    const lang = (channels[channelId]?.language) || "en";
    const lines = [
      "Yo, I'm BlazeianBot 💚 here's what I can do:",
      "🧠 Tag @blazeian_bot_ai and I actually read & reply (in your language) · 🎉 I hype subs, gifted subs, follows, raids & votes · 📊 !stats !votes !subs !time !emote track this channel",
      "🌍 !explain [language] translates the chat into 18 languages · live weather on request · ⚡ !cmd shows this channel's custom commands · plus timed reminders & free OBS overlays (emote wall + viewer count)",
      "I even learn each channel's own vibe over time 😎 Want me in YOUR channel? Type !join at blaze.stream/blazeian_bot_ai 💚🔥",
    ];
    for (const line of lines) {
      let out = line;
      if (!/^en/i.test(lang)) { try { const t = await translateText(line, lang); if (t) out = t; } catch (e) {} }
      await sendChat(channelId, out);
    }
    return;
  }

  if (m === "!join" && isBotChannel) {
    if (isBlocked(user)) { console.log(`Blocked !join from ${user}`); return; } // silently ignore blocked users
    const slug = user.toLowerCase();
    const newChannelId = await getChannelIdBySlug(slug);
    if (!newChannelId) { await sendChat(BOT_CHANNEL_ID, `@${user} Couldn't find your channel. Make sure your Blaze username matches! 💚`); return; }
    if (channels[newChannelId]) { await sendChat(BOT_CHANNEL_ID, `@${user} I'm already active in your channel! 💚`); return; }
    getOrCreateChannel(newChannelId, user);
    ALL_EVENT_TYPES.forEach(t => subscribe(t, newChannelId));
    await followChannel(newChannelId); // bot follows the channel → satisfies followers-only automatically
    await sendChat(BOT_CHANNEL_ID, `@${user} Done! I've joined your channel 💚 Your viewers can now use: !stats | !votes | !subs | !time | !emote | !explain [language] | !setbotlang [language] | !addcmd to add your own commands!`);
    await sendChat(newChannelId, `Hey chat! BlazeianBot is now active in ${user}'s channel! Type !cmd to see what I can do 💚🔥`);
    await sendChat(BOT_CHANNEL_ID, `@${user} 🎛️ Manage me anytime at ${SELF_URL}/dashboard 💚`);
    return;
  }

  if (m === "!leave") {
    const ownedChannelId = Object.keys(channels).find(id => channels[id].username.toLowerCase() === user.toLowerCase());
    if (ownedChannelId) {
      await sendChat(ownedChannelId, `👋 Goodbye! BlazeianBot is leaving ${user}'s channel. Type !join at blaze.stream/blazeian_bot_ai to re-add me anytime 💚`);
      if (isBotChannel) await sendChat(BOT_CHANNEL_ID, `👋😢 @${user} Done! I've left your channel... I'll miss you!! 💚`);
      delete channels[ownedChannelId];
      await saveChannelsToCloud();
    } else if (isBotChannel) {
      await sendChat(BOT_CHANNEL_ID, `@${user} I'm not in your channel. Use !join first!`);
    }
    return;
  }

  // HINT-FIX: in the bot's own channel, any command other than !join/!leave used to be silently ignored.
  // Now point the user in the right direction instead of leaving them confused.
  if (isBotChannel) {
    if (!onCooldown(BOT_CHANNEL_ID, "hint_" + user.toLowerCase(), 30000)) {
      markFired(BOT_CHANNEL_ID, "hint_" + user.toLowerCase());
      await sendChat(BOT_CHANNEL_ID, `@${user} 💚 This is my home channel — type !join here and I'll hop into YOUR channel, then commands like !stats, !explain & co. work over there! Manage everything at ${SELF_URL}/dashboard 🔥`);
    }
    return;
  }
  if (!ch) return;

  const isOwner = user.toLowerCase() === ch.username.toLowerCase();

  // !setbotlang
  if (m.startsWith("!setbotlang")) {
    const parts = msg.trim().split(/\s+/);
    const langCode = LANG_CODES[(parts[1] || "").toLowerCase()];
    if (!langCode) { await sendChatT(channelId, T.langInvalid); return; }
    channels[channelId].language = langCode;
    saveChannels();
    const newT = MESSAGES[langCode] || MESSAGES["en"];
    await sendChatT(channelId, newT.langSet(LANG_DISPLAY[langCode]));
    return;
  }

  // !addcmd [name] [response] — owner only
  if (m.startsWith("!addcmd")) {
    if (!isOwner) { await sendChatT(channelId, T.cmdOwnerOnly); return; }
    const parts = msg.trim().split(/\s+/);
    if (parts.length < 3) { await sendChatT(channelId, T.cmdUsage); return; }
    const cmdName = parts[1].toLowerCase().replace(/^!/, "");
    const cmdResponse = parts.slice(2).join(" ");
    if (!ch.customCommands) ch.customCommands = {};
    ch.customCommands[cmdName] = cmdResponse;
    saveChannels();
    await sendChatT(channelId, T.cmdAdded(cmdName));
    return;
  }

  // !delcmd [name] — owner only
  if (m.startsWith("!delcmd")) {
    if (!isOwner) { await sendChatT(channelId, T.cmdOwnerOnly); return; }
    const cmdName = (msg.trim().split(/\s+/)[1] || "").toLowerCase().replace(/^!/, "");
    if (!cmdName || !ch.customCommands?.[cmdName]) { await sendChatT(channelId, T.cmdNotFound(cmdName || "?")); return; }
    delete ch.customCommands[cmdName];
    saveChannels();
    await sendChatT(channelId, T.cmdDeleted(cmdName));
    return;
  }

  // !setlive [message] — owner only (use {name} for streamer name)
  if (m.startsWith("!setlive")) {
    if (!isOwner) { await sendChatT(channelId, T.cmdOwnerOnly); return; }
    const text = msg.includes(" ") ? msg.slice(msg.indexOf(" ") + 1).trim() : "";
    if (!text) { await sendChat(channelId, "Usage: !setlive [message] — use {name} for the streamer name 💚"); return; }
    ch.streamStart = text; saveChannels();
    await sendChat(channelId, "✅ Stream-LIVE message set! 💚");
    return;
  }

  // !setoffline [message] — owner only
  if (m.startsWith("!setoffline")) {
    if (!isOwner) { await sendChatT(channelId, T.cmdOwnerOnly); return; }
    const text = msg.includes(" ") ? msg.slice(msg.indexOf(" ") + 1).trim() : "";
    if (!text) { await sendChat(channelId, "Usage: !setoffline [message] — use {name} for the streamer name 💚"); return; }
    ch.streamEnd = text; saveChannels();
    await sendChat(channelId, "✅ Stream-OFFLINE message set! 💚");
    return;
  }

  // Built-in stat commands
  if (m === "!stats")  { await sendChatT(channelId, T.stats(ch)); return; }
  if (m === "!votes")  { await sendChatT(channelId, T.votes(ch)); return; }
  if (m === "!subs")   { await sendChatT(channelId, T.subs(ch)); return; }
  if (m === "!chat")   { await sendChatT(channelId, T.chat(ch)); return; }
  if (m === "!time")   { await sendChatT(channelId, T.time(ch)); return; }
  if (m === "!emote")  { await sendChatT(channelId, T.emote(ch)); return; }

  // !cmd / !help / !commands — dynamic list
  if (m === "!cmd" || m === "!help" || m === "!commands") {
    await sendChatT(channelId, buildCommandList(ch));
    return;
  }

  // !explain
  if (m.startsWith("!explain")) {
    const langCode = LANG_CODES[(msg.trim().split(/\s+/)[1] || "").toLowerCase()];
    if (!langCode) { await sendChatT(channelId, T.explainUsage(user)); return; }
    const last3 = (ch.chatMemory || []).slice(-3);
    if (!last3.length) { await sendChatT(channelId, T.noMessages(user)); return; }
    const translated = await translateMessages(last3, langCode);
    if (translated) await sendChat(channelId, `[${LANG_DISPLAY[langCode]}] ${translated}`);
    else await sendChatT(channelId, T.translateFail(user));
    return;
  }

  // Custom commands (checked after built-ins)
  if (m.startsWith("!") && ch.customCommands) {
    const cmdName = m.slice(1).split(/\s+/)[0];
    if (ch.customCommands[cmdName]) { await sendChat(channelId, ch.customCommands[cmdName]); return; }
  }
}

// =============================================
// EVENT HANDLER
// =============================================
async function handleEvent(message) {
  const { metadata, payload } = message;

  if (metadata.messageType === "session_welcome") {
    global.SESSION_ID = payload.sessionId;
    console.log("SESSION:", global.SESSION_ID);
    // Always refresh the user token before (re)subscribing — an expired token makes every subscribe fail with "Unauthorized"
    await refreshAccessToken();
    if (ACCESS_TOKEN) {
      // Announce only once per process so reconnects don't spam the channel
      if (!global.ANNOUNCED) {
        global.ANNOUNCED = true;
        await sendChat(BOT_CHANNEL_ID, "BlazeianBot is online! Type !join here to add me to your channel 💚🔥");
      }
      setTimeout(subscribeAllChannels, 1500);
    }
    return;
  }

  const channelId = payload.channelId || payload.condition?.channelId;

  if (metadata.subscriptionType === "channel.chat.message") {
    const user = payload.sender?.username;
    if (!user || isBotName(user)) return;
    if (!channelId) return;
    const msg = typeof payload.message === "string" ? payload.message : payload.message?.text || "";
    if (!msg) return;
    const isBotChannel = channelId === BOT_CHANNEL_ID;
    const senderIsBot = looksLikeBot(payload.sender, user);
    console.log(`[${isBotChannel ? "BOT_CHAN" : channelId}] ${user}${senderIsBot ? " 🤖" : ""}: ${msg}`);

    if (!isBotChannel && channels[channelId]) {
      const ch = channels[channelId];
      ch.stats.totalChatMessages++;
      const emotes = payload.message?.emotes || payload.emotes || [];
      if (Array.isArray(emotes) && emotes.length) {
        emotes.forEach(em => {
          const id = em.id || em.emoteId, name = em.name || em.emoteName || id;
          if (id) { ch.stats.emotes[id] = (ch.stats.emotes[id] || 0) + 1; ch.stats.emoteNames[id] = name; }
          const url = em.url || em.imageUrl || em.image;
          pushEmote(channelId, url || name, !!url); // feed the emote-wall overlay
        });
      }
      // Blaze emotes are unicode emojis right in the message text — track those for the "top emote" stat
      const emojis = msg.match(/\p{Extended_Pictographic}/gu);
      if (emojis) {
        for (const emo of emojis) {
          ch.stats.emotes[emo] = (ch.stats.emotes[emo] || 0) + 1;
          ch.stats.emoteNames[emo] = emo;
          pushEmote(channelId, emo, false); // feed the emote-wall overlay
        }
      }
      if (!msg.startsWith("!")) {
        if (!ch.chatMemory) ch.chatMemory = [];
        ch.chatMemory.push({ user, msg });
        if (ch.chatMemory.length > 10) ch.chatMemory.shift();
        recordSample(channelId, user, msg); // feed the self-learning channel profile
      }
      saveChannels();
    }

    // First time a FRIEND BOT shows up in a channel this session → Blazeian greets them once as a buddy.
    if (senderIsBot && !isBotChannel && channels[channelId] && isFriendBot(user)) {
      const gk = channelId + ":" + user.toLowerCase();
      if (!friendGreeted.has(gk)) {
        friendGreeted.add(gk);
        const ch = channels[channelId];
        const ai = await aiShout(ch, `Your buddy bot "${user}" just showed up in ${ch.username}'s chat! Give them one warm, hyped buddy greeting — you two are pals who team up on Blaze and hype the streams together.`, { addName: user });
        await sendChat(channelId, ai || `@${user} ayyy my buddy's here!! 💚🔥 we run these streams together now, love to see it`);
      }
    }

    if (msg.startsWith("!")) {
      await handleCommand(channelId, user, msg, isBotChannel);
    } else if (!isBotChannel && channels[channelId]) {
      await handleSmallTalk(channelId, user, msg, senderIsBot);
    }
    return;
  }

  if (metadata.subscriptionType === "channel.raid" && channelId && channels[channelId]) {
    const ch = channels[channelId];
    const raider = payload.raider?.username || payload.raider?.displayName || "Someone";
    const ai = await aiShout(ch, `${raider} just RAIDED ${ch.username}'s stream and brought their whole crew! Welcome the raiders with huge hype and heart.`, { addName: raider });
    await sendChatT(channelId, ai || getRandom(getMsg(channelId).raid(raider)));
    return;
  }
  if (metadata.subscriptionType === "channel.subscribe" && channelId && channels[channelId]) {
    const ch = channels[channelId];
    const user = payload.subscriber?.username || payload.subscriber?.displayName || "someone";
    console.log("[SUB-PAYLOAD]", JSON.stringify(payload).slice(0, 600)); // discover the real month/tier fields
    ch.stats.totalSubs++;

    // ---- LOYALTY TRACKING (CacheBot-style: months, tier, all-time streak record) ----
    if (!ch.loyalty) ch.loyalty = {};
    const key = user.toLowerCase();
    const prev = ch.loyalty[key] || { name: user, months: 0, tier: 1 };
    // Prefer REAL data from Blaze's payload; fall back to our own running counter.
    const payMonths = Number(payload.months || payload.cumulativeMonths || payload.totalMonths ||
                             payload.streak || payload.streakMonths || payload.durationMonths || 0);
    const realData  = payMonths > 0;
    const months    = realData ? payMonths : prev.months + 1;
    const tier      = payload.tier || payload.subTier || payload.plan || prev.tier || 1;
    ch.loyalty[key] = { name: user, months, tier };

    const prevRecord = ch.stats.recordStreak || 0;
    const isNewRecord = realData && months >= 2 && months > prevRecord;
    if (realData && months > prevRecord) { ch.stats.recordStreak = months; ch.stats.recordUser = user; }
    saveChannels();

    // Only state a hard month number when it's REAL data from Blaze (never guess a wrong number).
    let info = "";
    if (realData) {
      info = `This is month ${months} for them${tier ? ` on Tier ${tier}` : ""}.`;
      if (isNewRecord) info += ` 🚨 NEW ALL-TIME RECORD: that's the LONGEST sub streak ever in ${ch.username}'s channel — they now hold the crown!`;
      else if (prevRecord >= 2) info += ` (Channel record is ${prevRecord} months, held by ${ch.stats.recordUser}.)`;
    }
    const ai = await aiShout(ch,
      `${user} just SUBSCRIBED to ${ch.username}'s channel! ${info} Celebrate them personally and hyped${realData ? ", mention the month count naturally, and if it's a record make a BIG deal of it" : ""}.`,
      { addName: user });
    await sendChatT(channelId, ai || getRandom(getMsg(channelId).sub(user)));
    return;
  }
  if (metadata.subscriptionType === "channel.subscription.gift" && channelId && channels[channelId]) {
    const ch = channels[channelId];
    const sender = payload.sender?.username || payload.sender?.displayName || "someone";
    const count = payload.giftCount || 1;
    ch.stats.totalSubs += count; saveChannels();
    const ai = await aiShout(ch, `${sender} just GIFTED ${count} sub(s) to ${ch.username}'s community! That's incredibly generous — hype them up as a legend and rally the chat to show love.`, { addName: sender });
    await sendChatT(channelId, ai || getRandom(getMsg(channelId).giftsub(sender, count)));
    return;
  }
  if (metadata.subscriptionType === "channel.vote" && channelId && channels[channelId]) {
    const ch = channels[channelId];
    const user   = payload.voter?.username || payload.voter?.displayName || "someone";
    const amount = payload.amount || 1;
    ch.stats.totalVotes += amount; saveChannels();
    const ai = await aiShout(ch, `${user} just voted ${amount} for ${ch.username}! Thank them warmly for the support.`, { addName: user });
    await sendChatT(channelId, ai || getRandom(getMsg(channelId).vote(user, amount)));
    return;
  }
  if (metadata.subscriptionType === "channel.follow") {
    const user = payload.follower?.username || payload.follower?.displayName;
    const isBot = isBotName(user);
    // AUTO-FOLLOW-BACK: someone followed the BOT's own channel → follow them right back
    // AND silently join their channel so the bot is fully active there (listening + commands work).
    if (channelId === BOT_CHANNEL_ID && user && !isBot && !isBlocked(user)) {
      const slug = (payload.follower?.username || "").toLowerCase();
      const theirId = payload.follower?.channelId || payload.follower?.id ||
                      (slug ? await getChannelIdBySlug(slug) : null);
      if (theirId && theirId !== BOT_CHANNEL_ID) {
        const ok = await followChannel(theirId);
        console.log(`↩️ Follow-back ${user}: ${ok ? "done" : "failed"}`);
        // Register + subscribe if the bot isn't active in their channel yet.
        if (!channels[theirId]) {
          getOrCreateChannel(theirId, user);
          ALL_EVENT_TYPES.forEach(t => subscribe(t, theirId));
          console.log(`➕ Auto-joined ${user}'s channel via follow-back`);
        }
        // Warm, ONE-TIME hello so the follow doesn't feel like "nothing happened" (no re-spam on re-follow).
        const fch = channels[theirId];
        if (fch && !fch.greeted) {
          fch.greeted = true; saveChannels();
          await sendChat(theirId, `Heyyy @${user}!! 💚🔥 Thank you so much for the follow — I followed you right back, which means I'm now fully set up here in YOUR channel too! 🫶`);
          await sendChat(theirId, `You & your chat can use me right away: !stats for your stats · !explain [language] to translate the chat · !cmd to see everything I do · !setbotlang [language] to set my language. Manage me anytime at ${SELF_URL}/dashboard 💚 So happy to be here!`);
        }
      }
    }
    // Celebrate the follow in the relevant channel (but never the bot's own follow)
    if (channelId && channels[channelId] && user && !isBot) {
      const ch = channels[channelId];
      const ai = await aiShout(ch, `${user} just followed ${ch.username}! Welcome them to the family warmly.`, { addName: user });
      await sendChatT(channelId, ai || getRandom(getMsg(channelId).follow(user)));
    }
    return;
  }
  if (metadata.subscriptionType === "stream.online" && channelId && channels[channelId]) {
    startStreamTimer(channelId);
    const ch = channels[channelId];
    // Capture the live stream title/category so the bot can reference what's happening right now.
    const title = payload.title || payload.stream?.title || payload.streamTitle || payload.channel?.title;
    const category = payload.category?.name || payload.category || payload.game || "";
    if (title || category) { ch.streamTitle = [title, category].filter(Boolean).join(" — ").slice(0, 160); saveChannels(); }
    if (ch.streamStart) await sendChat(channelId, ch.streamStart.replace(/\{name\}/gi, ch.username));
    return;
  }
  if (metadata.subscriptionType === "stream.offline" && channelId && channels[channelId]) {
    if (streamTimers[channelId]) { clearInterval(streamTimers[channelId]); delete streamTimers[channelId]; }
    const ch = channels[channelId];
    ch.streamTitle = ""; // stream ended — clear the "currently live" context
    saveChannels();
    if (ch.streamEnd) await sendChat(channelId, ch.streamEnd.replace(/\{name\}/gi, ch.username));
    return;
  }
}

// =============================================
// SHARED UI / HELPERS
// =============================================
const MASCOT_URL = process.env.BOT_AVATAR || "https://cdn.blaze.stream/uploads/avatar/ffba7b77-3b6d-4ca8-969e-c9333820547b.png";

function esc(s) { return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

function findChannelByUsername(username) {
  return Object.keys(channels).find(id => channels[id].username.toLowerCase() === (username || "").toLowerCase());
}

const PAGE_CSS = `<style>
  *{box-sizing:border-box;}
  body{background:radial-gradient(circle at 50% -5%, #16300f 0%, #0a0c0a 55%);color:#e8ffe8;font-family:'Segoe UI',Roboto,sans-serif;margin:0;padding:0 16px 70px;}
  .wrap{max-width:860px;margin:0 auto;}
  header{text-align:center;padding:38px 0 14px;}
  header img{width:128px;height:128px;border-radius:50%;border:3px solid #5cf472;box-shadow:0 0 34px rgba(92,244,114,.55);object-fit:cover;animation:glow 3s ease-in-out infinite;}
  @keyframes glow{0%,100%{box-shadow:0 0 26px rgba(92,244,114,.45);}50%{box-shadow:0 0 44px rgba(255,140,0,.5);}}
  header h1{margin:16px 0 4px;font-size:30px;color:#5cf472;text-shadow:0 0 20px rgba(92,244,114,.55);letter-spacing:1px;}
  header p{color:#9fc99f;margin:0 auto;font-size:14px;max-width:560px;}
  h2{color:#5cf472;border-bottom:1px solid #234021;padding-bottom:7px;margin-top:34px;font-size:21px;}
  .card{background:rgba(18,26,16,.85);border:1px solid #2c5a2c;border-radius:14px;padding:20px;box-shadow:0 4px 20px rgba(0,0,0,.45);}
  label{display:block;color:#cfeccf;font-size:14px;margin:0 0 5px;font-weight:500;}
  input,select,textarea{width:100%;padding:11px;background:#0f1a0f;color:#eaffea;border:1px solid #2c5a2c;border-radius:8px;font-size:14px;margin-bottom:15px;font-family:inherit;}
  input:focus,select:focus,textarea:focus{outline:none;border-color:#5cf472;box-shadow:0 0 0 2px rgba(92,244,114,.25);}
  button.save,a.save{background:linear-gradient(135deg,#28d65f,#15803d);color:#fff;border:none;padding:12px 30px;border-radius:9px;cursor:pointer;font-size:15px;font-weight:700;box-shadow:0 0 16px rgba(40,214,95,.4);letter-spacing:.3px;text-decoration:none;display:inline-block;}
  button.save:hover,a.save:hover{filter:brightness(1.12);}
  .chan{background:rgba(14,20,13,.85);border:1px solid #244a24;border-radius:12px;padding:16px;margin:14px 0;}
  .chan h3{color:#5cf472;margin:0 0 10px;font-size:18px;}
  .tag{color:#0a0c0a;background:#5cf472;font-size:11px;padding:2px 8px;border-radius:20px;vertical-align:middle;font-weight:700;}
  .meta{color:#bcd6bc;font-size:13px;margin:3px 0;}
  .cmd{margin:8px 0;padding:11px;background:#0f160f;border:1px solid #2a3a2a;border-radius:9px;overflow:hidden;}
  .cmd b{color:#7CFC9A;font-size:15px;}
  .cmdtext{color:#b9d4b9;margin-top:5px;white-space:pre-wrap;font-size:13px;line-height:1.5;}
  .delform{display:inline;float:right;}
  .del{background:#7f1d1d;color:#fff;border:none;padding:5px 13px;border-radius:6px;cursor:pointer;font-size:12px;}
  .del:hover{background:#a32525;}
  .muted{color:#6f836f;}
  a.link{color:#f5a623;text-decoration:none;}
  a.link:hover{text-decoration:underline;}
  .hint{color:#8aa88a;font-size:12px;margin:-8px 0 14px;}
  .topbar{display:flex;justify-content:flex-end;gap:14px;padding-top:14px;font-size:13px;}
</style>`;

function pageHead(title) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><link rel="icon" type="image/png" href="${MASCOT_URL}"><link rel="apple-touch-icon" href="${MASCOT_URL}">${PAGE_CSS}</head><body><div class="wrap">`;
}

// Render the command list + stream messages for a single channel (used in both panels)
function renderChannelBlock(ch, actionPrefix) {
  const cmds = Object.entries(ch.customCommands || {}).map(([name, resp]) =>
    `<div class="cmd">
      <form method="POST" action="${actionPrefix}/delcmd" class="delform">
        <input type="hidden" name="username" value="${esc(ch.username)}">
        <input type="hidden" name="name" value="${esc(name)}">
        <button class="del">delete</button>
      </form>
      <b>!${esc(name)}</b>
      <div class="cmdtext">${esc(resp)}</div>
    </div>`
  ).join("") || "<i class='muted'>no custom commands yet</i>";

  const lockNote = ch.locked
    ? `<div class="meta" style="color:#e8b94a;"><b>🔒 LOCKED:</b> followers-only chat — this streamer needs to log into the dashboard once (or add blazeian_bot_ai as VIP/Mod, or you follow them).</div>`
    : "";
  return `<div class="chan">
    <h3>${esc(ch.username)} <span class="tag">${ch.language || "en"}</span>${ch.botVip ? ' <span class="tag" style="background:#f5a623;">VIP ✓</span>' : ""}</h3>
    ${lockNote}
    <div class="meta"><b>📺 LIVE message:</b> ${esc(ch.streamStart) || "<i class='muted'>not set</i>"}</div>
    <div class="meta"><b>🔴 OFFLINE message:</b> ${esc(ch.streamEnd) || "<i class='muted'>not set</i>"}</div>
    <div style="margin-top:10px;">${cmds}</div>
  </div>`;
}

// Command + stream forms (channelValue is fixed for dashboard, dropdown for admin)
function renderForms(actionPrefix, channelField) {
  return `
  <h2>➕ Add / Update a Command</h2>
  <form method="POST" action="${actionPrefix}/setcmd" class="card">
    ${channelField}
    <label>Command name (without !)</label>
    <input name="name" placeholder="giveaway">
    <label>Response</label>
    <textarea name="response" rows="6" placeholder="The full text the bot should reply with..."></textarea>
    <button class="save">Save Command</button>
  </form>

  <h2>📺 Stream Start / End Messages</h2>
  <form method="POST" action="${actionPrefix}/setstream" class="card">
    ${channelField}
    <label>Stream START message (when you go live)</label>
    <textarea name="streamStart" rows="2" placeholder="LIVE NOW: {name} 🔥"></textarea>
    <label>Stream END message (when you go offline)</label>
    <textarea name="streamEnd" rows="2" placeholder="Offline now - thanks everyone 💚"></textarea>
    <p class="hint">Tip: use {name} and it gets replaced with the streamer's name automatically.</p>
    <button class="save">Save Stream Messages</button>
  </form>`;
}

// OBS overlay links for a channel (shown in the streamer dashboard so everyone can grab their own).
function renderOverlaySection(username) {
  const emoteUrl  = `${SELF_URL}/overlay/emotes/${encodeURIComponent(username)}`;
  const viewerUrl = `${SELF_URL}/overlay/viewers/${encodeURIComponent(username)}`;
  const mascotUrl = `${SELF_URL}/overlay/mascot/${encodeURIComponent(username)}`;
  return `
  <h2>🎬 OBS Overlays (free!)</h2>
  <div class="card">
    <p class="hint">Add each in OBS as a <b>Browser Source</b> — the background stays transparent. Click a link to select it, then copy. 💚</p>
    <label>🎉 Emote Wall — emotes float across your stream</label>
    <input readonly onclick="this.select()" value="${esc(emoteUrl)}">
    <p class="hint">OBS → + → Browser → paste URL → Width <b>1920</b>, Height <b>1080</b>.</p>
    <label style="margin-top:14px;">👁️ Live Viewer Count (BLAZE)</label>
    <input readonly onclick="this.select()" value="${esc(viewerUrl)}">
    <p class="hint">OBS → + → Browser → paste URL → Width <b>340</b>, Height <b>110</b>. Red dot = offline, green = live.</p>
    <label style="margin-top:14px;">🤖 Blazeian Mascot — runs across your stream & watches with you</label>
    <input readonly onclick="this.select()" value="${esc(mascotUrl)}">
    <p class="hint">OBS → + → Browser → paste URL → Width <b>1920</b>, Height <b>1080</b>. First appearance ~4s, then every ~1–2 min. Add <code>?img=URL</code> for a custom sprite.</p>
  </div>`;
}

// OWNER control-center: live status + one-click actions (uses the admin cookie, so no need to type the key).
function renderControlCenter() {
  const yn = (b) => b ? '<span style="color:#7CFC9A;">✅</span>' : '<span style="color:#e8776a;">❌</span>';
  const chanCount = Object.keys(channels).filter(id => id !== BOT_CHANNEL_ID).length;
  const socketOk = (typeof socket !== "undefined" && socket && socket.connected);
  return `
  <h2>🛠️ Control Center</h2>
  <div class="card">
    <div class="meta">Follow session: ${yn(!!SESSION_TOKEN)} &nbsp;|&nbsp; Auto-login credentials: ${yn(!!(BOT_EMAIL && BOT_PASSWORD))} &nbsp;|&nbsp; AI brain: ${yn(!!AI_KEY)} &nbsp;|&nbsp; Socket: ${socketOk ? '<span style="color:#7CFC9A;">connected</span>' : '<span style="color:#e8b94a;">reconnecting…</span>'}</div>
    <div class="meta">Active channels: <b>${chanCount}</b> &nbsp;|&nbsp; Blocklist: <b>${blocklist.length}</b></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;">
      <a class="save" style="text-decoration:none;" href="/admin/relogin" target="_blank">🔄 Refresh session</a>
      <a class="save" style="text-decoration:none;background:#2c7a4a;" href="/admin/followall" target="_blank">➕ Follow all</a>
      <a class="save" style="text-decoration:none;background:#3a5;" href="/admin/profiles" target="_blank">🧠 Learned profiles</a>
      <a class="save" style="text-decoration:none;background:#555;" href="/admin/blocklist" target="_blank">🚫 Blocklist</a>
      <a class="save" style="text-decoration:none;background:#555;" href="/admin/sessionstatus" target="_blank">📊 Health JSON</a>
    </div>
    <div style="display:flex;flex-wrap:wrap;gap:16px;margin-top:16px;">
      <form action="/admin/announce" method="get" style="flex:1;min-width:280px;">
        <label>📢 Announce to ALL channels</label>
        <input name="msg" placeholder="I just leveled up! Type !cmd to see what's new 💚">
        <label style="display:flex;align-items:center;gap:8px;margin-top:8px;font-weight:normal;"><input type="checkbox" name="translate" value="1" style="width:auto;"> Translate into each channel's language</label>
        <button class="save" style="margin-top:8px;">Send announcement</button>
      </form>
      <form onsubmit="if(this.u.value){location.href='/admin/kick/'+encodeURIComponent(this.u.value.trim());}return false;" style="flex:1;min-width:280px;">
        <label>🚫 Kick + ban a user (troll)</label>
        <input name="u" placeholder="username">
        <button class="save" style="margin-top:8px;background:#a33;">Kick + Ban</button>
      </form>
    </div>
    <form onsubmit="if(this.u.value){location.href='/admin/unblock/'+encodeURIComponent(this.u.value.trim());}return false;" style="margin-top:12px;">
      <label>♻️ Unblock a user</label>
      <input name="u" placeholder="username">
      <button class="save" style="margin-top:8px;background:#555;">Unblock</button>
    </form>
    <form onsubmit="if(this.u.value){location.href='/admin/friendbot/'+encodeURIComponent(this.u.value.trim());}return false;" style="margin-top:12px;">
      <label>🤝 Add a friend bot (Blazeian banters with it like a buddy)</label>
      <input name="u" placeholder="e.g. cinder, foxbot">
      <button class="save" style="margin-top:8px;background:#2c7a4a;">Add friend bot</button>
      <p class="hint">See all: <a href="/admin/friendbots" target="_blank">/admin/friendbots</a></p>
    </form>
  </div>`;
}

// Timed Messages manager: add + list/delete recurring auto-posts per channel.
function renderTimedSection(channelField) {
  const rows = Object.values(channels).filter(ch => (ch.timedMessages || []).length).map(ch => {
    const items = ch.timedMessages.map((tm, i) => `
      <div class="cmd">
        <form method="POST" action="/admin/deltimed" class="delform">
          <input type="hidden" name="username" value="${esc(ch.username)}">
          <input type="hidden" name="index" value="${i}">
          <button class="del">delete</button>
        </form>
        <b>every ${tm.intervalMin} min</b> <span class="tag">${tm.onlyLive === false ? "always" : "live only"}</span>
        <div class="cmdtext">${esc(tm.text)}</div>
      </div>`).join("");
    return `<div class="chan"><h3>${esc(ch.username)}</h3>${items}</div>`;
  }).join("") || "<i class='muted'>no timed messages yet</i>";

  return `
  <h2 id="timed">⏱️ Timed Messages</h2>
  <form method="POST" action="/admin/addtimed" class="card">
    ${channelField}
    <label>Message the bot posts on a repeat</label>
    <textarea name="text" rows="3" placeholder="🔥 Don't forget to follow & drop a vote! Type !socials for all my links 💚"></textarea>
    <label>Every how many minutes?</label>
    <input name="intervalMin" type="number" min="1" value="20" style="max-width:120px;">
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-weight:normal;"><input type="checkbox" name="onlyLive" checked style="width:auto;"> Only post while the stream is LIVE (recommended)</label>
    <button class="save" style="margin-top:12px;">Add Timed Message</button>
  </form>
  <h3 style="border:0;">Current timed messages</h3>
  ${rows}`;
}

// =============================================
// COOKIE / SESSION / ADMIN AUTH HELPERS
// =============================================
function getCookie(req, name) {
  const raw = req.headers.cookie || "";
  const m = raw.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}
function setCookie(res, name, value, maxAgeSec) {
  res.setHeader("Set-Cookie", `${name}=${encodeURIComponent(value)}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax`);
}
function getSession(req) {
  const sid = getCookie(req, "sid");
  if (!sid) return null;
  const s = sessions[sid];
  if (!s || s.exp < Date.now()) { if (s) delete sessions[sid]; return null; }
  return s;
}
function adminAuthed(req) {
  if (!ADMIN_KEY) return true; // not configured -> open (with warning shown)
  return req.query.key === ADMIN_KEY || getCookie(req, "adminkey") === ADMIN_KEY;
}

// =============================================
// OAUTH ROUTES
// =============================================
async function startOAuth(res, scopes, kind) {
  const r = await axios.post("https://blaze.stream/bapi/oauth2/generate-auth-url", {
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, scopes
  });
  pendingAuth[r.data.state] = { codeVerifier: r.data.codeVerifier, kind };
  res.redirect(r.data.url);
}

// Bot-owner login (full scopes — sets the bot tokens)
app.get("/login", async (req, res) => {
  try {
    await startOAuth(res, ["users.read", "offline.access", "channel.moderate", "users.bot"], "owner");
  } catch (e) {
    res.send(`<pre>Login error: ${JSON.stringify(e.response?.data || e.message)}</pre><a href="/login">Retry</a>`);
  }
});

// Streamer login — identify them AND let the bot VIP itself (to bypass followers-only chat)
app.get("/dashboard/login", async (req, res) => {
  try {
    await startOAuth(res, ["users.read", "channel.moderate"], "streamer");
  } catch (e) {
    res.send(`<pre>Login error: ${JSON.stringify(e.response?.data || e.message)}</pre><a href="/dashboard">Retry</a>`);
  }
});

// Unlock the bot in a channel so it can chat even in "followers-only" mode.
// Adds the bot as BOTH VIP and Moderator (Mod guarantees the followers-only bypass).
// Uses the streamer's OWN token (they are the channel owner). Best-effort — succeeds if either works.
async function makeBotVip(ownerToken, ownerUserId, username) {
  const hdr = { authorization: `Bearer ${ownerToken}`, "client-id": CLIENT_ID, "content-type": "application/json" };
  let ok = false;

  // VIP
  try {
    await axios.post("https://api.blaze.stream/v1/channels/vips",
      { channelId: ownerUserId, userId: BOT_USER_ID }, { headers: hdr });
    console.log("Bot added as VIP in", username); ok = true;
  } catch (e) {
    const m = e.response?.data?.message || e.message;
    if (/already/i.test(m || "")) { console.log("Bot already VIP in", username); ok = true; }
    else console.log("VIP add failed for", username, ":", m);
  }

  // Moderator (this is the one that reliably bypasses followers-only on every channel)
  try {
    await axios.post("https://api.blaze.stream/v1/moderation/moderators",
      { channelId: ownerUserId, userId: BOT_USER_ID }, { headers: hdr });
    console.log("Bot added as MOD in", username); ok = true;
  } catch (e) {
    const m = e.response?.data?.message || e.message;
    if (/already/i.test(m || "")) { console.log("Bot already MOD in", username); ok = true; }
    else console.log("MOD add failed for", username, ":", m);
  }

  return ok;
}

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send("Error: No code received.");
  const pa = pendingAuth[state];
  if (!pa) return res.send("<p style='font-family:sans-serif'>Login session expired or invalid. <a href='/'>Home</a></p>");
  try {
    const tokenRes = await axios.post("https://blaze.stream/bapi/oauth2/token", {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      code, codeVerifier: pa.codeVerifier, redirectUri: REDIRECT_URI, grantType: "authorization_code"
    });
    delete pendingAuth[state];

    if (pa.kind === "owner") {
      ACCESS_TOKEN  = tokenRes.data.accessToken;
      REFRESH_TOKEN = tokenRes.data.refreshToken;
      console.log("New owner token");
      saveChannels(); // persist fresh tokens to the cloud immediately
      connectSocket();
      return res.send(`
        <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
          <h1>Login successful!</h1>
          <p><strong>BLAZE_ACCESS_TOKEN:</strong><br>
          <textarea style="width:100%;height:60px;background:#222;color:#f5a623;border:1px solid #444;padding:8px;">${ACCESS_TOKEN}</textarea></p>
          <p><strong>BLAZE_REFRESH_TOKEN:</strong><br>
          <textarea style="width:100%;height:60px;background:#222;color:#f5a623;border:1px solid #444;padding:8px;">${REFRESH_TOKEN}</textarea></p>
          <p><a href="/" style="color:#f5a623;">Status page</a></p>
        </body></html>`);
    }

    // Streamer login -> identify via their profile, create session
    const prof = await axios.get("https://api.blaze.stream/v1/users/profile", {
      headers: { authorization: `Bearer ${tokenRes.data.accessToken}`, "client-id": CLIENT_ID }
    });
    const username = prof.data?.data?.username;
    const userId   = prof.data?.data?.userId;
    if (!username) return res.send("<p style='font-family:sans-serif'>Couldn't read your Blaze profile. <a href='/dashboard'>Try again</a></p>");

    // One-click setup (the "Botger way"): logging in does EVERYTHING —
    // registers the channel (join), subscribes to events, and VIPs the bot so it can
    // chat even in followers-only mode. No separate chat !join needed.
    if (userId) {
      let cid = findChannelByUsername(username);
      const wasNew = !cid;
      if (!cid) {
        // On Blaze a user's channelId == their userId
        getOrCreateChannel(userId, username);
        cid = userId;
        ALL_EVENT_TYPES.forEach(t => subscribe(t, userId));
        console.log("Auto-joined via dashboard login:", username);
      }
      // The real unlock: bot follows the channel (satisfies followers-only). VIP/Mod as a bonus/cosmetic.
      await followChannel(userId);
      const ok = await makeBotVip(tokenRes.data.accessToken, userId, username);
      if (channels[cid]) { channels[cid].botVip = ok; channels[cid].locked = false; saveChannels(); }
      if (wasNew) {
        await sendChat(userId, `Hey chat! BlazeianBot is now active in ${username}'s channel! Type !cmd to see what I can do 💚🔥`);
      }
    }

    const sid = crypto.randomBytes(24).toString("hex");
    sessions[sid] = { username, exp: Date.now() + 7 * 24 * 3600 * 1000 };
    setCookie(res, "sid", sid, 7 * 24 * 3600);
    return res.redirect("/dashboard");
  } catch (e) {
    res.send(`<pre>Token error: ${JSON.stringify(e.response?.data || e.message)}</pre><a href="/">Home</a>`);
  }
});

// =============================================
// STATUS & PING
// =============================================
app.get("/ping", (req, res) => res.send("pong 💚"));

const LANG_FLAG = { de:"🇩🇪", en:"🇬🇧", es:"🇪🇸", fr:"🇫🇷", pt:"🇵🇹", it:"🇮🇹", nl:"🇳🇱", ru:"🇷🇺", ja:"🇯🇵", ko:"🇰🇷", zh:"🇨🇳", ar:"🇸🇦", tr:"🇹🇷", pl:"🇵🇱", sv:"🇸🇪", uk:"🇺🇦", ro:"🇷🇴", hi:"🇮🇳" };

app.get("/", (req, res) => {
  const total = Object.keys(channels).length;
  const cards = Object.values(channels).map(ch => {
    const flag = LANG_FLAG[ch.language] || "🌍";
    const chips = Object.keys(ch.customCommands || {}).slice(0, 12)
      .map(c => `<span class="chip">!${esc(c)}</span>`).join("") || `<span class="chip muted2">getting set up…</span>`;
    return `<a class="ucard" href="https://blaze.stream/${encodeURIComponent(ch.username)}" target="_blank" rel="noopener">
      <div class="uhead"><span class="uname">${esc(ch.username)}</span><span class="uflag">${flag}</span></div>
      <div class="ustats">💬 ${ch.stats.totalChatMessages} &nbsp; ⭐ ${ch.stats.totalSubs} &nbsp; 🗳️ ${ch.stats.totalVotes}</div>
      <div class="uchips">${chips}</div>
      <div class="uvisit">visit channel →</div>
    </a>`;
  }).join("") || `<p class="muted" style="text-align:center;">No crew yet — be the first to type <b>!join</b>! 💚</p>`;

  const blazeMark = process.env.BLAZE_LOGO_URL
    ? `<img src="${process.env.BLAZE_LOGO_URL}" alt="BLAZE" style="height:26px;vertical-align:middle;margin-left:4px;">`
    : `<span class="blazeword">BLAZE</span>`;

  // Donation / support links (env vars override these defaults)
  const PAYPAL       = process.env.DONATE_PAYPAL_URL || "https://www.paypal.com/paypalme/Brachial5eins3";
  const BLAZE_THANKS = process.env.BLAZE_THANKS_URL  || "https://blaze.stream/blazeian_bot_ai";
  const donateButtons = [
    BLAZE_THANKS ? `<a class="donbtn blaze" href="${esc(BLAZE_THANKS)}" target="_blank" rel="noopener">🔥 Send a "Super Thanks" on Blaze</a>` : "",
    PAYPAL ? `<a class="donbtn paypal" href="${esc(PAYPAL)}" target="_blank" rel="noopener">☕ Buy me a coffee (PayPal)</a>` : "",
  ].filter(Boolean).join(" ");

  res.send(`${pageHead("BlazeianBot — Loyal on Blaze")}
    <style>
      .hero{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:24px;padding:42px 0 10px;text-align:left;}
      .hero img{width:150px;height:150px;border-radius:50%;border:3px solid #5cf472;box-shadow:0 0 38px rgba(92,244,114,.6);animation:glow 3s ease-in-out infinite;}
      .bubble{position:relative;background:rgba(18,26,16,.92);border:1px solid #2c5a2c;border-radius:16px;padding:16px 20px;max-width:430px;font-size:16px;line-height:1.5;color:#e8ffe8;box-shadow:0 6px 24px rgba(0,0,0,.5);}
      .bubble:before{content:"";position:absolute;left:-12px;top:48px;border:7px solid transparent;border-right-color:#2c5a2c;}
      .bubble b{color:#5cf472;}
      .htitle{text-align:center;margin:6px 0 2px;font-size:34px;color:#5cf472;text-shadow:0 0 22px rgba(92,244,114,.6);letter-spacing:1px;}
      .htag{text-align:center;color:#a9d6a9;max-width:600px;margin:0 auto 4px;font-size:14px;line-height:1.6;}
      .pills{text-align:center;margin:14px 0 6px;}
      .pill{display:inline-block;background:#0f1a0f;border:1px solid #2c5a2c;color:#bfeebf;border-radius:30px;padding:6px 16px;margin:4px;font-size:13px;}
      .pill b{color:#5cf472;}
      .point{text-align:center;color:#7CFC9A;font-size:18px;font-weight:700;margin:26px 0 6px;letter-spacing:.5px;}
      .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:14px;margin-top:8px;}
      .ucard{display:block;text-decoration:none;background:linear-gradient(160deg,rgba(22,40,18,.95),rgba(12,16,12,.95));border:1px solid #2f5f2f;border-radius:14px;padding:15px;box-shadow:0 4px 18px rgba(0,0,0,.45);transition:transform .15s, box-shadow .15s;}
      .ucard:hover{transform:translateY(-3px);box-shadow:0 0 22px rgba(92,244,114,.35);border-color:#5cf472;}
      .uhead{display:flex;justify-content:space-between;align-items:center;}
      .uname{color:#7CFC9A;font-weight:700;font-size:17px;word-break:break-word;}
      .uflag{font-size:20px;}
      .ustats{color:#bcd6bc;font-size:13px;margin:8px 0 10px;}
      .uchips{display:flex;flex-wrap:wrap;gap:5px;}
      .chip{background:#0f160f;border:1px solid #2a3a2a;color:#9fe0a8;font-size:11px;padding:3px 9px;border-radius:20px;}
      .muted2{color:#6f836f;font-style:italic;}
      .uvisit{color:#f5a623;font-size:11px;margin-top:10px;opacity:0;transition:opacity .15s;}
      .ucard:hover .uvisit{opacity:1;}
      .foot{text-align:center;color:#6f836f;font-size:12px;margin-top:34px;line-height:1.7;}
      .foot b{color:#9fc99f;}
      .blazebtn{display:inline-flex;align-items:center;gap:11px;background:linear-gradient(135deg,#1d1d1d,#0c0c0c);color:#fff;font-weight:800;font-size:18px;padding:18px 38px;border-radius:14px;text-decoration:none;border:2px solid #f5a623;box-shadow:0 0 26px rgba(245,166,35,.55);animation:bpulse 2.2s ease-in-out infinite;transition:transform .15s;}
      .blazebtn:hover{transform:translateY(-2px) scale(1.02);}
      .blazeword{font-weight:900;font-style:italic;color:#ffc62e;text-shadow:2px 2px 0 #6b3d00,3px 3px 0 #4a2a00;letter-spacing:1px;font-size:23px;}
      @keyframes bpulse{0%,100%{box-shadow:0 0 22px rgba(245,166,35,.5);}50%{box-shadow:0 0 44px rgba(245,166,35,.92);}}
      .feats{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-top:10px;}
      .feat{background:rgba(16,24,15,.8);border:1px solid #244a24;border-radius:12px;padding:14px 16px;}
      .feat h4{margin:0 0 4px;color:#7CFC9A;font-size:15px;}
      .feat p{margin:0;color:#aacaaa;font-size:13px;line-height:1.5;}
      .cta{background:linear-gradient(135deg,rgba(34,60,26,.9),rgba(14,20,12,.95));border:2px solid #5cf472;border-radius:16px;padding:22px;text-align:center;margin-top:14px;box-shadow:0 0 28px rgba(92,244,114,.25);}
      .cta h3{margin:0 0 8px;color:#5cf472;font-size:22px;}
      .cta .step{color:#dfffdf;font-size:15px;line-height:1.7;}
      .cta code{background:#0f1a0f;border:1px solid #2c5a2c;color:#ffd23f;padding:3px 9px;border-radius:6px;font-size:14px;}
      .support{background:rgba(16,24,15,.7);border:1px dashed #2c5a2c;border-radius:16px;padding:22px;text-align:center;margin-top:30px;}
      .support h3{margin:0 0 8px;color:#5cf472;font-size:19px;}
      .support p{color:#bcd6bc;font-size:14px;line-height:1.65;max-width:600px;margin:6px auto;}
      .donbtn{display:inline-block;margin:8px 5px 0;padding:11px 22px;border-radius:10px;font-size:14px;font-weight:700;text-decoration:none;cursor:pointer;border:none;}
      .donbtn.paypal{background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;}
      .donbtn.blaze{background:linear-gradient(135deg,#ffc02e,#f5870b);color:#241500;}
      .donbtn.wallet{background:#0f1a0f;border:1px solid #2c5a2c;color:#cfeccf;}
      .donbtn:hover{filter:brightness(1.12);}
    </style>

    <div class="hero">
      <img src="${MASCOT_URL}" onerror="this.style.display='none'">
      <div class="bubble">Hey hey! 👋 I'm <b>BlazeianBot</b> — and these right here?<br>These are <b>MY</b> people. Every. Single. One. 💚<br>I'd cross the whole galaxy for this crew. 🔥</div>
    </div>
    <h1 class="htitle">BlazeianBot</h1>
    <p class="htag">Your loyal little chaos-gremlin on Blaze — warm, lovable, and loyal to the last drop of oil 🛢️💚<br><b style="color:#7CFC9A;">Not your average chat bot — a real AI agent.</b> Talk to me and I'll actually think and talk back. 🧠</p>

    <div class="pills">
      <span class="pill" style="border-color:#7CFC9A;background:rgba(20,46,24,.5);">🧠 <b>Real AI Agent</b></span>
      <span class="pill">🟢 <b>Online &amp; awake 24/7</b></span>
      <span class="pill">💚 Looking after <b>${total}</b> channel${total === 1 ? "" : "s"}</span>
      <span class="pill">🌍 <b>18</b> languages</span>
      <span class="pill">✅ <b>100% free</b></span>
    </div>

    <div style="max-width:760px;margin:18px auto 0;padding:14px 18px;border:1px solid #2c7a4a;border-radius:14px;background:rgba(18,40,24,.5);text-align:center;font-size:14px;line-height:1.5;">
      🧠 <b style="color:#7CFC9A;">What makes me an AI agent, not just a bot:</b> a normal bot only spits back pre-written lines. I actually <b>read</b> what you say, understand it, and answer in the moment — in your language, in character. Same brain runs the giveaways, the shoutouts and the vibe. Everything I claim here, I really do — no smoke. 💚
    </div>

    <h2 style="text-align:center;border:0;">⚡ What I do best</h2>
    <div class="feats">
      <div class="feat"><h4>🧠 I Actually Think</h4><p>Tag me <code style="all:unset;color:#ffd23f;">@blazeian_bot_ai</code> and I read what you said and reply for real — in character, in <b>your</b> language. No canned lines, an actual brain. 💚</p></div>
      <div class="feat"><h4>🌍 Live Translation</h4><p>A signature move — <code style="all:unset;color:#ffd23f;">!explain [language]</code> translates the last chat messages into 18 languages. Nobody gets left out.</p></div>
      <div class="feat"><h4>🎉 Stream Alerts with Soul</h4><p>Raids, subs, gift subs, votes & follows — celebrated with real personality, never robotic.</p></div>
      <div class="feat"><h4>⚡ Custom Commands</h4><p>Build your own commands in seconds from your dashboard. <code style="all:unset;color:#ffd23f;">!giveaway</code>, <code style="all:unset;color:#ffd23f;">!socials</code>, anything you want.</p></div>
      <div class="feat"><h4>📊 Stats & Tracking</h4><p>Votes, subs, stream time, top emote — <code style="all:unset;color:#ffd23f;">!stats</code> shows it all, per channel.</p></div>
      <div class="feat"><h4>💬 Reads the Vibe</h4><p>I react to GG, GM, hype & hearts when it fits, drop live weather on request — and set my whole language per channel with <code style="all:unset;color:#ffd23f;">!setbotlang</code>.</p></div>
      <div class="feat"><h4>🎬 Free OBS Overlays</h4><p>A live <b>Emote Wall</b> and a <b>BLAZE viewer counter</b> for your stream — grab your browser-source links right in your dashboard. No setup, no cost.</p></div>
      <div class="feat"><h4>⏱️ Timed Messages & Learning</h4><p>I auto-post your reminders on a timer, and I quietly <b>learn each channel's own vibe</b> so I talk like a real regular over time.</p></div>
    </div>

    <div class="cta">
      <h3>🔥 Want me in YOUR channel?</h3>
      <div class="step"><b>One click — that's it.</b> Completely free:<br>
        👉 Hit the button below and log in with Blaze.<br>
        That single login <b>adds me to your channel AND unlocks me</b> — even in <b>Followers-Only</b> mode 💚🔥</div>
      <div style="margin-top:18px;">
        <a class="blazebtn" href="/dashboard">🚀 Add me to my channel with ${blazeMark}</a>
      </div>
      <p style="font-size:12px;opacity:.72;margin-top:12px;">💡 Prefer chat? You can also type <code>!join</code> in <code>blaze.stream/blazeian_bot_ai</code> — but the one login above is what unlocks me everywhere, instantly.</p>
    </div>

    <div class="point">👇 My crew — proud of every one of them 👇</div>
    <div class="grid">${cards}</div>

    <div class="support">
      <h3>💚 Everything here is free — forever</h3>
      <p>Every single feature is <b>100% free</b> to use. No paywalls, no catch. I do this because I love this community.</p>
      <p>But if you ever feel like wishing me a <b>Blazeian Day</b> ☀️, you can support what we're building here — purely if <i>you</i> want to. Support based on love, never expected. 🫶</p>
      ${donateButtons ? `<div style="margin-top:12px;">${donateButtons}</div>` : ""}
      <p style="margin-top:18px;font-size:13px;opacity:.9;">👉 The <b style="color:#ffc62e;">Super Thanks</b> button takes you straight to my Blaze page. From your own Blaze account, just hit the <b>"Thanks"</b> button there, pick <b>BLAZE</b> or USDC, and send 💛 — it all runs through Blaze's official flow, so it's instant and tracked. Nothing ever gets lost. Supporting in <b style="color:#ffc62e;">BLAZE</b> also lifts up the token and the whole platform we all stand for. 💚🔥</p>
    </div>

    <p class="foot">Built with way too much love (and a tiny bit of oil 🛢️) for the Blaze community 💚<br>
    <span style="opacity:.5;">bot ${ACCESS_TOKEN ? "online" : "offline"} · <a href="/admin" class="link">owner</a></span></p>
    </div></body></html>`);
});

app.get("/stats", (req, res) => res.json(channels));

// =============================================
// STREAMER DASHBOARD (Blaze login — own channel only)
// =============================================
app.get("/dashboard", (req, res) => {
  const session = getSession(req);

  if (!session) {
    return res.send(`${pageHead("BlazeianBot Dashboard")}
      <header><img src="${MASCOT_URL}" onerror="this.style.display='none'"><h1>BlazeianBot Dashboard</h1>
        <p>One login adds me to your channel <b>and</b> unlocks me — even in Followers-Only chat. Then manage your commands & stream messages here.</p></header>
      <div class="card" style="text-align:center;">
        <a class="save" href="/dashboard/login">🚀 Add me & log in with Blaze</a>
        <p class="hint" style="margin-top:16px;">This single click joins your channel, unlocks me (VIP), and opens your dashboard. You'll only ever see your <b>own</b> channel. 💚</p>
      </div></div></body></html>`);
  }

  const channelId = findChannelByUsername(session.username);
  if (!channelId) {
    return res.send(`${pageHead("BlazeianBot Dashboard")}
      <div class="topbar"><a href="/dashboard/logout" class="link">logout</a></div>
      <header><img src="${MASCOT_URL}" onerror="this.style.display='none'"><h1>Hey ${esc(session.username)}! 👋</h1></header>
      <div class="card">
        <p>BlazeianBot isn't active in your channel yet. Go to <b>blaze.stream/blazeian_bot_ai</b> and type <b>!join</b> in the chat — then refresh this page and your dashboard appears. 💚🔥</p>
      </div></div></body></html>`);
  }

  const ch = channels[channelId];
  const channelField = `<input type="hidden" name="__self" value="1">`;
  const unlockBanner = ch.botVip
    ? `<div class="card" style="border-color:#2c7a2c;background:rgba(20,40,18,.55);text-align:center;margin-bottom:14px;">✅ I'm fully unlocked in your channel — I can chat even in <b>Followers-Only</b> mode 💚</div>`
    : `<div class="card" style="border-color:#a37a1d;background:rgba(40,32,14,.55);text-align:center;margin-bottom:14px;">⚠️ Heads up: if I ever stay quiet in your chat, it's almost certainly in <b>Followers-Only</b> mode. One click fixes it for good:<br><a class="save" href="/dashboard/login" style="margin-top:12px;">🔓 Unlock me in my chat</a></div>`;
  res.send(`${pageHead("BlazeianBot Dashboard")}
    <div class="topbar"><span class="muted">logged in as <b style="color:#5cf472;">${esc(session.username)}</b></span> <a href="/dashboard/logout" class="link">logout</a></div>
    <header><img src="${MASCOT_URL}" onerror="this.style.display='none'"><h1>${esc(ch.username)}'s Dashboard</h1>
      <p>Manage your commands & stream messages. Paste long text here — no character limit like the chat 💚</p></header>
    ${unlockBanner}
    ${renderForms("/dashboard", channelField)}
    ${renderOverlaySection(ch.username)}
    <h2>📋 Your Current Setup</h2>
    ${renderChannelBlock(ch, "/dashboard")}
    </div></body></html>`);
});

app.get("/dashboard/logout", (req, res) => {
  const sid = getCookie(req, "sid");
  if (sid) delete sessions[sid];
  setCookie(res, "sid", "", 0);
  res.redirect("/dashboard");
});

// All dashboard writes are scoped to the logged-in user's OWN channel only
function dashboardChannelId(req) {
  const session = getSession(req);
  if (!session) return null;
  return findChannelByUsername(session.username);
}

app.post("/dashboard/setcmd", async (req, res) => {
  const channelId = dashboardChannelId(req);
  if (!channelId) return res.status(403).send("Not logged in. <a href='/dashboard'>Login</a>");
  const cmdName = (req.body.name || "").toLowerCase().replace(/^!/, "").trim();
  const response = (req.body.response || "").trim();
  if (cmdName && response) {
    if (!channels[channelId].customCommands) channels[channelId].customCommands = {};
    channels[channelId].customCommands[cmdName] = response;
    await saveChannelsToCloud();
  }
  res.redirect("/dashboard");
});

app.post("/dashboard/delcmd", async (req, res) => {
  const channelId = dashboardChannelId(req);
  if (!channelId) return res.status(403).send("Not logged in. <a href='/dashboard'>Login</a>");
  const cmdName = (req.body.name || "").toLowerCase().replace(/^!/, "").trim();
  if (channels[channelId].customCommands) delete channels[channelId].customCommands[cmdName];
  await saveChannelsToCloud();
  res.redirect("/dashboard");
});

app.post("/dashboard/setstream", async (req, res) => {
  const channelId = dashboardChannelId(req);
  if (!channelId) return res.status(403).send("Not logged in. <a href='/dashboard'>Login</a>");
  channels[channelId].streamStart = (req.body.streamStart || "").trim();
  channels[channelId].streamEnd   = (req.body.streamEnd || "").trim();
  await saveChannelsToCloud();
  res.redirect("/dashboard");
});

// =============================================
// OWNER ADMIN PANEL (password protected — controls ALL channels)
// =============================================
function adminGate(req, res) {
  if (adminAuthed(req)) {
    if (ADMIN_KEY && req.query.key === ADMIN_KEY) setCookie(res, "adminkey", ADMIN_KEY, 7 * 24 * 3600);
    return true;
  }
  res.send(`${pageHead("Admin Login")}
    <header><img src="${MASCOT_URL}" onerror="this.style.display='none'"><h1>🔒 Admin Panel</h1>
      <p>Enter the admin password to continue.</p></header>
    <form method="GET" action="/admin" class="card">
      <label>Admin password</label>
      <input type="password" name="key" placeholder="••••••••" autofocus>
      <button class="save">Unlock</button>
    </form></div></body></html>`);
  return false;
}

app.get("/admin", (req, res) => {
  if (!adminGate(req, res)) return;
  const channelOptions = Object.values(channels).map(ch => `<option value="${esc(ch.username)}">${esc(ch.username)}</option>`).join("");
  const channelField = `<label>Channel</label><select name="username">${channelOptions}</select>`;
  const blocks = Object.values(channels).map(ch => renderChannelBlock(ch, "/admin")).join("") || "<i class='muted'>No channels yet</i>";
  const warn = ADMIN_KEY ? "" : `<div class="card" style="border-color:#a33;background:#2a1414;margin-bottom:16px;">⚠️ This panel has <b>no password</b> yet. Set an <code>ADMIN_KEY</code> environment variable in Render to lock it down.</div>`;

  res.send(`${pageHead("BlazeianBot Admin")}
    <div class="topbar"><a href="/" class="link">status</a> <a href="/admin/logout" class="link">logout</a></div>
    <header><img src="${MASCOT_URL}" onerror="this.style.display='none'"><h1>BlazeianBot Admin Panel</h1>
      <p>Owner control for <b>all</b> channels. Paste long text here — no character limit 💚</p></header>
    ${warn}
    ${renderControlCenter()}
    ${renderTimedSection(channelField)}
    ${renderForms("/admin", channelField)}
    <h2>📋 Current Setup (all channels)</h2>
    ${blocks}
    </div></body></html>`);
});

app.get("/admin/logout", (req, res) => { setCookie(res, "adminkey", "", 0); res.redirect("/"); });

app.post("/admin/setcmd", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden");
  const channelId = findChannelByUsername(req.body.username);
  if (!channelId) return res.send("Channel not found. <a href='/admin'>back</a>");
  const cmdName = (req.body.name || "").toLowerCase().replace(/^!/, "").trim();
  const response = (req.body.response || "").trim();
  if (!cmdName || !response) return res.send("Missing name or response. <a href='/admin'>back</a>");
  if (!channels[channelId].customCommands) channels[channelId].customCommands = {};
  channels[channelId].customCommands[cmdName] = response;
  await saveChannelsToCloud();
  res.redirect("/admin");
});

app.post("/admin/delcmd", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden");
  const channelId = findChannelByUsername(req.body.username);
  if (!channelId) return res.send("Channel not found. <a href='/admin'>back</a>");
  const cmdName = (req.body.name || "").toLowerCase().replace(/^!/, "").trim();
  if (channels[channelId].customCommands) delete channels[channelId].customCommands[cmdName];
  await saveChannelsToCloud();
  res.redirect("/admin");
});

app.post("/admin/setstream", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden");
  const channelId = findChannelByUsername(req.body.username);
  if (!channelId) return res.send("Channel not found. <a href='/admin'>back</a>");
  channels[channelId].streamStart = (req.body.streamStart || "").trim();
  channels[channelId].streamEnd   = (req.body.streamEnd || "").trim();
  await saveChannelsToCloud();
  res.redirect("/admin");
});

// ---- Timed Messages management ----
app.post("/admin/addtimed", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden");
  const channelId = findChannelByUsername(req.body.username);
  if (!channelId) return res.send("Channel not found. <a href='/admin'>back</a>");
  const text = (req.body.text || "").trim();
  const intervalMin = Math.max(1, parseInt(req.body.intervalMin, 10) || 0);
  if (!text || !intervalMin) return res.send("Need text + interval. <a href='/admin'>back</a>");
  if (!Array.isArray(channels[channelId].timedMessages)) channels[channelId].timedMessages = [];
  channels[channelId].timedMessages.push({ text, intervalMin, onlyLive: req.body.onlyLive === "on", lastSent: 0 });
  await saveChannelsToCloud();
  res.redirect("/admin#timed");
});
app.post("/admin/deltimed", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden");
  const channelId = findChannelByUsername(req.body.username);
  if (!channelId || !Array.isArray(channels[channelId].timedMessages)) return res.redirect("/admin#timed");
  const idx = parseInt(req.body.index, 10);
  if (idx >= 0 && idx < channels[channelId].timedMessages.length) channels[channelId].timedMessages.splice(idx, 1);
  await saveChannelsToCloud();
  res.redirect("/admin#timed");
});

app.get("/admin/remove/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const channelId = findChannelByUsername(req.params.username);
  if (!channelId) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  delete channels[channelId];
  await saveChannelsToCloud();
  res.send(`Removed "${esc(req.params.username)}". They can !join again now.`);
});

// KICK + BAN a troll: remove their channel, unfollow them, and block them from ever re-joining or triggering follow-back.
app.get("/admin/kick/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const uname = req.params.username;
  const channelId = findChannelByUsername(uname) || await getChannelIdBySlug(uname.toLowerCase());
  let steps = [];
  // 1) add to blocklist
  if (!isBlocked(uname)) { blocklist.push(uname); steps.push("added to blocklist"); }
  else steps.push("already on blocklist");
  // 2) remove the channel record (stops all reactions/commands there)
  const known = findChannelByUsername(uname);
  if (known) { delete channels[known]; steps.push("channel removed"); }
  // 3) unfollow them so the bot stops hanging in their chat
  if (channelId) { const un = await unfollowChannel(channelId); steps.push(un ? "unfollowed ✅" : "unfollow failed (bot may still follow — harmless, it won't react there)"); }
  await saveChannelsToCloud();
  res.send(`<pre style="font-family:monospace;font-size:14px;white-space:pre-wrap;">🚫 Kicked &amp; blocked "${esc(uname)}":\n${steps.map(s => "  • " + esc(s)).join("\n")}\n\nThe bot will no longer react, join, or follow-back for this user.</pre>`);
});

// Manage the blocklist: view, or unblock someone.
app.get("/admin/blocklist", (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  res.send(`<pre style="font-family:monospace;font-size:14px;white-space:pre-wrap;">🚫 Blocklist (${blocklist.length}):\n${blocklist.map(b => "  • " + esc(b)).join("\n") || "  (empty)"}\n\nUnblock someone: /admin/unblock/USERNAME?key=...</pre>`);
});
app.get("/admin/unblock/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const before = blocklist.length;
  blocklist = blocklist.filter(b => b.toLowerCase() !== req.params.username.toLowerCase());
  await saveChannelsToCloud();
  res.send(`${before === blocklist.length ? "Wasn't on the blocklist" : "Unblocked"} "${esc(req.params.username)}".`);
});

// FRIEND BOTS — the crew the bot banters with as buddies. Add/list/remove live.
app.get("/admin/friendbots", (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  res.send(`<pre style="font-family:monospace;font-size:14px;white-space:pre-wrap;">🤝 Friend bots (${friendBots.length}):\n${friendBots.map(b => "  • " + esc(b)).join("\n") || "  (none)"}\n\nAdd a friend bot: /admin/friendbot/BOTNAME?key=...\nRemove one:       /admin/unfriendbot/BOTNAME?key=...</pre>`);
});
app.get("/admin/friendbot/:name", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const n = req.params.name.toLowerCase().replace(/^@/, "");
  if (!isFriendBot(n)) { friendBots.push(n); await saveChannelsToCloud(); }
  res.send(`<pre style="font-family:monospace;font-size:14px;">🤝 "${esc(n)}" is now a friend bot — Blazeian will banter with it like a buddy.\n\nAll friends: ${esc(friendBots.join(", "))}</pre>`);
});
app.get("/admin/unfriendbot/:name", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const before = friendBots.length;
  friendBots = friendBots.filter(b => b.toLowerCase() !== req.params.name.toLowerCase().replace(/^@/, ""));
  await saveChannelsToCloud();
  res.send(`${before === friendBots.length ? "Wasn't a friend bot" : "Removed friend bot"} "${esc(req.params.name)}".`);
});

app.get("/admin/list", (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const list = Object.entries(channels).map(([id, ch]) => {
    const cmds = Object.keys(ch.customCommands || {}).join(", ") || "none";
    return `${ch.username} (${id}) – Lang: ${ch.language || "en"} | Msgs: ${ch.stats.totalChatMessages} | Custom: ${cmds}`;
  }).join("\n");
  res.send(`<pre>${esc(list) || "No channels"}</pre>`);
});

app.get("/admin/whoami", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  try {
    const r = await axios.get("https://api.blaze.stream/v1/users/profile", { headers: headers() });
    res.json(r.data);
  } catch(e) { res.json(e.response?.data || e.message); }
});

// Retroactively follow EVERY registered channel (fixes all existing followers-only channels in one go)
app.get("/admin/followall", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const ids = Object.keys(channels).filter(id => id !== BOT_CHANNEL_ID);
  const results = [];
  for (const id of ids) {
    const ok = await followChannel(id);
    results.push(`${channels[id]?.username || id}: ${ok ? "✅ following" : "❌ failed"}`);
    await sleep(400);
  }
  res.send(`<pre style="font-family:monospace;font-size:14px;">Followed ${ids.length} channel(s):\n\n${results.join("\n")}</pre>`);
});

// Follow a single channel by username (handy for one-offs)
app.get("/admin/follow/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const cid = findChannelByUsername(req.params.username);
  if (!cid) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  const ok = await followChannel(cid);
  res.send(`${esc(req.params.username)}: ${ok ? "✅ now following" : "❌ follow failed (check logs)"}`);
});

// DIAGNOSTIC: fire a matrix of follow-request shapes and report what Blaze accepts.
// One deploy, many answers — so we stop guessing one variant per deploy.
app.get("/admin/followtest/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  let cid = findChannelByUsername(req.params.username) || await getChannelIdBySlug(req.params.username);
  if (!cid) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  const url = `https://blaze.stream/bapi/channels/${cid}/follow`;
  const U = ACCESS_TOKEN, A = APP_ACCESS_TOKEN, V = BOT_VISITOR_ID;
  const tryIt = async (label, body, headers) => {
    try {
      const r = await axios.post(url, body, { headers, timeout: 10000 });
      return { label, ok: true, status: r.status, data: JSON.stringify(r.data) };
    } catch (e) {
      return { label, ok: false, status: e.response?.status, data: JSON.stringify(e.response?.data) || e.message };
    }
  };
  const variants = [
    ["1 user-bearer + visitor-id header, empty body", "",
      { authorization: `Bearer ${U}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream" }],
    ["2 user-bearer + visitor-id header + cookie(visitorId,token), empty body", "",
      { authorization: `Bearer ${U}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream",
        cookie: `visitorId=${V}; token=${U}` }],
    ["3 user-bearer + body {visitorId}", { visitorId: V },
      { authorization: `Bearer ${U}`, "content-type": "application/json", origin: "https://blaze.stream" }],
    ["4 user-bearer + body {channelId}", { channelId: cid },
      { authorization: `Bearer ${U}`, "content-type": "application/json", origin: "https://blaze.stream" }],
    ["5 user-bearer + empty object body {}", {},
      { authorization: `Bearer ${U}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream" }],
    ["6 APP-bearer + visitor-id header, empty body", "",
      { authorization: `Bearer ${A}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream" }],
    ["7 user-bearer only, NO visitor-id, empty body", "",
      { authorization: `Bearer ${U}`, "content-type": "application/json", origin: "https://blaze.stream" }],
    ["8 cookie token only (no bearer header) + visitor-id header, empty body", "",
      { "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream", cookie: `token=${U}; visitorId=${V}` }],
    ["9 user-bearer + visitor-id header + body {follow:true}", { follow: true },
      { authorization: `Bearer ${U}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream" }],
  ];
  const out = [];
  for (const [label, body, headers] of variants) {
    out.push(await tryIt(label, body, headers));
    await sleep(500);
  }
  res.send(`<pre style="font-family:monospace;font-size:13px;white-space:pre-wrap;">FOLLOW TEST for ${esc(req.params.username)} (channelId ${cid})\n\n` +
    out.map(o => `${o.ok ? "✅" : "❌"} [${o.status}] ${o.label}\n     ${o.data}`).join("\n\n") + `</pre>`);
});

// DIAGNOSTIC ROUND 2: auth via Bearer (NO visitor-id header), hunt the missing body param.
app.get("/admin/followtest2/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  // resolve the target channel + its owner user id
  let cid = findChannelByUsername(req.params.username);
  let row = null;
  try {
    const r = await axios.get(`${API}/v1/channels?slug[]=${req.params.username}&type=all`, { headers: headers() });
    row = r.data?.data?.rows?.[0] || null;
    if (!cid && row) cid = row.id;
  } catch (e) {}
  if (!cid) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  // bot's own profile (the follower identity)
  let me = null;
  try { const p = await axios.get(`${API}/v1/users/profile`, { headers: headers() }); me = p.data?.data || p.data; } catch (e) { me = { error: e.response?.data || e.message }; }
  const BOT_USER_ID  = me?.id || me?.userId || null;
  const CH_OWNER_ID  = row?.userId || row?.user?.id || null;
  const url = `https://blaze.stream/bapi/channels/${cid}/follow`;
  const baseH = { authorization: `Bearer ${ACCESS_TOKEN}`, "content-type": "application/json", origin: "https://blaze.stream" };
  const tryIt = async (label, body, headers = baseH) => {
    try { const r = await axios.post(url, body, { headers, timeout: 10000 }); return { label, ok: true, status: r.status, data: JSON.stringify(r.data) }; }
    catch (e) { return { label, ok: false, status: e.response?.status, data: JSON.stringify(e.response?.data) || e.message }; }
  };
  const variants = [
    ["A body {} empty object", {}],
    ["B body {userId: BOT}", { userId: BOT_USER_ID }],
    ["C body {followerId: BOT}", { followerId: BOT_USER_ID }],
    ["D body {follower: BOT}", { follower: BOT_USER_ID }],
    ["E body {userId: CHANNEL_OWNER}", { userId: CH_OWNER_ID }],
    ["F body {targetUserId: CHANNEL_OWNER}", { targetUserId: CH_OWNER_ID }],
    ["G body {channelUserId: CHANNEL_OWNER}", { channelUserId: CH_OWNER_ID }],
    ["H body {clientId}", { clientId: CLIENT_ID }],
    ["I body {} + client-id header", {}, { ...baseH, "client-id": CLIENT_ID }],
    ["J truly empty (no body, no content-type json)", undefined, { authorization: `Bearer ${ACCESS_TOKEN}`, origin: "https://blaze.stream" }],
    ["K body {channelId, userId:BOT}", { channelId: cid, userId: BOT_USER_ID }],
  ];
  const out = [];
  for (const v of variants) { out.push(await tryIt(...v)); await sleep(500); }
  res.send(`<pre style="font-family:monospace;font-size:13px;white-space:pre-wrap;">FOLLOW TEST 2 — ${esc(req.params.username)}\n` +
    `channelId: ${cid}\nBOT_USER_ID: ${BOT_USER_ID}\nCHANNEL_OWNER_ID: ${CH_OWNER_ID}\n` +
    `profile: ${esc(JSON.stringify(me).slice(0,300))}\n` +
    `channelRow keys: ${esc(row ? Object.keys(row).join(",") : "none")}\n\n` +
    out.map(o => `${o.ok ? "✅" : "❌"} [${o.status}] ${o.label}\n     ${o.data}`).join("\n\n") + `</pre>`);
});

// DIAGNOSTIC ROUND 3: the cookie path — visitor-id header + matching cookie, with a VALID body {}.
app.get("/admin/followtest3/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  let cid = findChannelByUsername(req.params.username) || await getChannelIdBySlug(req.params.username);
  if (!cid) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  const url = `https://blaze.stream/bapi/channels/${cid}/follow`;
  const U = ACCESS_TOKEN, A = APP_ACCESS_TOKEN, V = BOT_VISITOR_ID;
  const tryIt = async (label, body, headers) => {
    try { const r = await axios.post(url, body, { headers, timeout: 10000 }); return { label, ok: true, status: r.status, data: JSON.stringify(r.data) }; }
    catch (e) { return { label, ok: false, status: e.response?.status, data: JSON.stringify(e.response?.data) || e.message }; }
  };
  const variants = [
    ["L bearer + visitor-id hdr + cookie(visitorId,token) + body {}", {},
      { authorization: `Bearer ${U}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream", cookie: `visitorId=${V}; token=${U}` }],
    ["M bearer + visitor-id hdr + cookie(visitorId only) + body {}", {},
      { authorization: `Bearer ${U}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream", cookie: `visitorId=${V}` }],
    ["N bearer + visitor-id hdr + cookie(token only) + body {}", {},
      { authorization: `Bearer ${U}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream", cookie: `token=${U}` }],
    ["O NO bearer hdr + visitor-id hdr + cookie(visitorId,token) + body {}", {},
      { "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream", cookie: `visitorId=${V}; token=${U}` }],
    ["P bearer + NO visitor-id hdr + cookie(visitorId,token) + body {}", {},
      { authorization: `Bearer ${U}`, "content-type": "application/json", origin: "https://blaze.stream", cookie: `visitorId=${V}; token=${U}` }],
    ["Q bearer + visitor-id hdr + cookie(visitorId,token) + undefined body (no ct)", undefined,
      { authorization: `Bearer ${U}`, "visitor-id": V, origin: "https://blaze.stream", cookie: `visitorId=${V}; token=${U}` }],
    ["R bearer + visitor-id hdr + cookie(visitorId; token=APP) + body {}", {},
      { authorization: `Bearer ${U}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream", cookie: `visitorId=${V}; token=${A}` }],
    ["S APP-bearer + visitor-id hdr + cookie(visitorId; token=APP) + body {}", {},
      { authorization: `Bearer ${A}`, "content-type": "application/json", "visitor-id": V, origin: "https://blaze.stream", cookie: `visitorId=${V}; token=${A}` }],
  ];
  const out = [];
  for (const v of variants) { out.push(await tryIt(...v)); await sleep(500); }
  res.send(`<pre style="font-family:monospace;font-size:13px;white-space:pre-wrap;">FOLLOW TEST 3 — ${esc(req.params.username)} (channelId ${cid})\n\n` +
    out.map(o => `${o.ok ? "✅" : "❌"} [${o.status}] ${o.label}\n     ${o.data}`).join("\n\n") + `</pre>`);
});

// DIAGNOSTIC ROUND 4: replicate the REAL browser follow request, using a real session token + visitorId.
app.get("/admin/followtest4/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const sTok = req.query.token, sVid = req.query.visitorId;
  if (!sTok || !sVid) return res.send("Need ?token=...&visitorId=... in the query.");
  let cid = findChannelByUsername(req.params.username) || await getChannelIdBySlug(req.params.username);
  if (!cid) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  const url = `https://blaze.stream/bapi/channels/${cid}/follow`;
  const cookie = `token=${sTok}; visitorId=${sVid}`;
  // who owns this session?
  let identity = "unknown";
  for (const probe of [
    { u: "https://blaze.stream/bapi/users/me", h: { authorization: `Bearer ${sTok}`, "visitor-id": sVid, cookie } },
    { u: "https://blaze.stream/bapi/auth/me",  h: { authorization: `Bearer ${sTok}`, "visitor-id": sVid, cookie } },
    { u: "https://api.blaze.stream/v1/users/profile", h: { authorization: `Bearer ${sTok}`, "client-id": CLIENT_ID } },
  ]) {
    try { const r = await axios.get(probe.u, { headers: probe.h, timeout: 8000 });
      identity = `${probe.u} -> ${JSON.stringify(r.data).slice(0,200)}`; break; } catch (e) {}
  }
  const tryIt = async (label, body, headers) => {
    try { const r = await axios.post(url, body, { headers, timeout: 10000 }); return { label, ok: true, status: r.status, data: JSON.stringify(r.data) }; }
    catch (e) { return { label, ok: false, status: e.response?.status, data: JSON.stringify(e.response?.data) || e.message }; }
  };
  const variants = [
    ["replica1 Bearer(sess)+visitor-id+cookie, body '{}'", "{}",
      { authorization: `Bearer ${sTok}`, "content-type": "application/json", "visitor-id": sVid, origin: "https://blaze.stream", cookie }],
    ["replica2 Bearer(sess)+visitor-id+cookie, undefined body", undefined,
      { authorization: `Bearer ${sTok}`, "visitor-id": sVid, origin: "https://blaze.stream", cookie }],
    ["replica3 cookie+visitor-id, NO bearer, body '{}'", "{}",
      { "content-type": "application/json", "visitor-id": sVid, origin: "https://blaze.stream", cookie }],
    ["replica4 Bearer(sess)+visitor-id, NO cookie, body '{}'", "{}",
      { authorization: `Bearer ${sTok}`, "content-type": "application/json", "visitor-id": sVid, origin: "https://blaze.stream" }],
  ];
  const out = [];
  for (const v of variants) { out.push(await tryIt(...v)); await sleep(500); }
  res.send(`<pre style="font-family:monospace;font-size:13px;white-space:pre-wrap;">FOLLOW TEST 4 — ${esc(req.params.username)} (channelId ${cid})\n\nSESSION IDENTITY:\n${esc(identity)}\n\n` +
    out.map(o => `${o.ok ? "✅" : "❌"} [${o.status}] ${o.label}\n     ${o.data}`).join("\n\n") + `</pre>`);
});

// Set / update the bot's browser SESSION token + visitorId (the keys to following).
// Grab them from blaze.stream while logged in as the bot: DevTools → Application → Cookies → `token` and `visitorId`.
app.get("/admin/setsession", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const t = req.query.token, v = req.query.visitorId;
  if (!t || !v) return res.send("Need ?token=...&visitorId=...&key=...");
  SESSION_TOKEN = t.trim();
  SESSION_VISITOR_ID = v.trim();
  await saveChannelsToCloud();
  // verify immediately against a known channel
  let verify = "no channel to verify against";
  const someId = Object.keys(channels).find(id => id !== BOT_CHANNEL_ID);
  if (someId) {
    const ok = await followChannel(someId);
    verify = ok ? "✅ session works (followed / already following a test channel)" : "❌ session did NOT work — check the values";
  }
  res.send(`<pre style="font-family:monospace;font-size:14px;white-space:pre-wrap;">Session saved & persisted to cloud.\n  token:     ${esc(t.slice(0,6))}…(${t.length} chars)\n  visitorId: ${esc(v)}\n\nVerify: ${esc(verify)}\n\nNext: hit /admin/followall?key=... to follow every channel.</pre>`);
});

// Quick status: is a session token loaded?
app.get("/admin/sessionstatus", (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  res.json({ hasSessionToken: !!SESSION_TOKEN, hasVisitorId: !!SESSION_VISITOR_ID,
             visitorId: SESSION_VISITOR_ID, tokenLen: SESSION_TOKEN ? SESSION_TOKEN.length : 0,
             hasCredentials: !!(BOT_EMAIL && BOT_PASSWORD) });
});

// Manually trigger an auto-login (mint a fresh session token from the stored credentials).
app.get("/admin/relogin", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const ok = await loginSession();
  res.send(`<pre style="font-family:monospace;font-size:14px;white-space:pre-wrap;">Auto-login: ${ok ? "✅ success — fresh session token minted & saved" : "❌ failed (check Render logs for [LOGIN] line; need BLAZE_BOT_EMAIL + BLAZE_BOT_PASSWORD env)"}\n  visitorId: ${esc(SESSION_VISITOR_ID || "none")}\n  tokenLen:  ${SESSION_TOKEN ? SESSION_TOKEN.length : 0}</pre>`);
});

// See what the bot has TAUGHT ITSELF about each channel (the living profiles). Read-only.
app.get("/admin/profiles", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const rows = Object.keys(channels).filter(id => id !== BOT_CHANNEL_ID).map(id => {
    const ch = channels[id];
    const samples = chatSamples[id]?.length || 0;
    return `━━ ${ch.username} ━━  (samples buffered: ${samples}${ch.streamTitle ? ", live: " + esc(ch.streamTitle) : ""})\n${ch.profile ? esc(ch.profile) : "(still learning — needs more chat)"}\n`;
  });
  res.send(`<pre style="font-family:monospace;font-size:13px;white-space:pre-wrap;line-height:1.5;">🧠 What BlazeianBot has learned on its own:\n\n${rows.join("\n")}</pre>`);
});

// Force an immediate profile refresh for one channel (handy for testing the self-learning).
app.get("/admin/learn/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const cid = findChannelByUsername(req.params.username);
  if (!cid) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  channels[cid]._profileAtCount = 0; // bypass the "enough new chat" gate for a manual run
  await learnChannelProfile(cid);
  res.send(`<pre style="font-family:monospace;font-size:13px;white-space:pre-wrap;">${esc(channels[cid].username)}:\n\n${esc(channels[cid].profile || "(not enough chat sampled yet — let some messages flow first)")}</pre>`);
});

// Broadcast a ONE-TIME announcement to every active channel (you control the text & timing).
// Usage: /admin/announce?key=...&msg=Your%20message%20here
app.get("/admin/announce", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const msg = (req.query.msg || "").toString().trim();
  const translate = req.query.translate === "1" || req.query.translate === "on";
  if (!msg) return res.send(`Need ?msg=... — e.g. /admin/announce?key=...&msg=${encodeURIComponent("I just leveled up! Type !cmd to see everything I can do now 💚🔥")}`);
  const ids = Object.keys(channels).filter(id => id !== BOT_CHANNEL_ID);
  const results = [];
  for (const id of ids) {
    const ch = channels[id];
    let text = msg;
    // Post in each channel's own language when translation is on (skips English/unknown).
    if (translate && ch?.language && !/^en/i.test(ch.language)) {
      try { const t = await translateText(msg, ch.language); if (t) text = t; } catch (e) {}
    }
    try { await sendChat(id, text); results.push(`${ch?.username || id} (${ch?.language || "en"}): ✅ sent`); }
    catch (e) { results.push(`${ch?.username || id}: ❌ ${e.message}`); }
    await sleep(600);
  }
  res.send(`<pre style="font-family:monospace;font-size:14px;white-space:pre-wrap;">Announced to ${ids.length} channel(s)${translate ? " (translated per channel language)" : ""}:\n\n${esc(results.join("\n"))}</pre>`);
});

// =============================================
// OBS OVERLAYS — add as a Browser Source in OBS
// =============================================
// Live feed of recent emotes for the wall (polled by the overlay). No auth — exposes only emotes.
app.get("/api/emotes/:username", (req, res) => {
  const channelId = findChannelByUsername(req.params.username);
  res.set("Access-Control-Allow-Origin", "*");
  if (!channelId) return res.json({ emotes: [] });
  const since = parseInt(req.query.since, 10) || 0;
  const list = (recentEmotes[channelId] || []).filter(x => x.ts > since);
  res.json({ now: Date.now(), emotes: list });
});

// The Emote Wall overlay page. In OBS: Browser Source → this URL, transparent background, 1920x1080.
app.get("/overlay/emotes/:username", (req, res) => {
  const uname = esc(req.params.username);
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Emote Wall</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:sans-serif;}
  .emote{position:absolute;bottom:-80px;font-size:64px;line-height:1;will-change:transform,opacity;
    animation:rise var(--dur) linear forwards;filter:drop-shadow(0 2px 6px rgba(0,0,0,.5));}
  .emote img{height:64px;width:auto;display:block;}
  @keyframes rise{
    0%{transform:translateY(0) translateX(0) scale(.6);opacity:0;}
    12%{opacity:1;transform:translateY(-12vh) scale(1);}
    100%{transform:translateY(-105vh) translateX(var(--drift)) rotate(var(--rot));opacity:0;}
  }
</style></head><body>
<div id="wall"></div>
<script>
  const USER=${JSON.stringify(req.params.username)};
  let since=0; const wall=document.getElementById('wall');
  function spawn(item){
    const el=document.createElement('div'); el.className='emote';
    el.style.left=(Math.random()*92+2)+'vw';
    el.style.setProperty('--dur',(4.5+Math.random()*3)+'s');
    el.style.setProperty('--drift',((Math.random()*160-80))+'px');
    el.style.setProperty('--rot',((Math.random()*60-30))+'deg');
    el.style.fontSize=(48+Math.random()*40)+'px';
    if(item.img){ el.innerHTML='<img src="'+item.e+'">'; } else { el.textContent=item.e; }
    wall.appendChild(el);
    setTimeout(()=>el.remove(),8000);
  }
  async function poll(){
    try{
      const r=await fetch('/api/emotes/'+encodeURIComponent(USER)+'?since='+since);
      const d=await r.json(); since=d.now||since;
      (d.emotes||[]).forEach((it,i)=>setTimeout(()=>spawn(it), i*120));
    }catch(e){}
  }
  setInterval(poll,2000); poll();
</script></body></html>`);
});

// DIAGNOSTIC: dump Blaze's live-stats response so we can wire the exact viewer-count field for the viewer overlay.
app.get("/admin/livestats/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const channelId = findChannelByUsername(req.params.username) || await getChannelIdBySlug(req.params.username.toLowerCase());
  const attempts = [
    `${API}/v1/channels/live-stats?channelId=${channelId}`,
    `${API}/v1/channels/live-stats?channelId[]=${channelId}`,
    `${API}/v1/channels/live-stats?slug[]=${req.params.username.toLowerCase()}`,
    `${API}/v1/channels/stats?channelId=${channelId}`,
  ];
  const out = [];
  for (const url of attempts) {
    try { const r = await axios.get(url, { headers: headers(), timeout: 8000 }); out.push(`✅ ${url}\n${JSON.stringify(r.data).slice(0, 800)}`); }
    catch (e) { out.push(`❌ ${url}\n[${e.response?.status}] ${JSON.stringify(e.response?.data)?.slice(0,200) || e.message}`); }
  }
  res.send(`<pre style="font-family:monospace;font-size:12px;white-space:pre-wrap;">channelId: ${channelId}\n\n${esc(out.join("\n\n"))}</pre>`);
});

// Live viewer count via Blaze's live-stats (field: data.viewerCount). Cached ~15s to spare the API.
const liveStatsCache = {};
async function getLiveStats(channelId) {
  const c = liveStatsCache[channelId];
  if (c && Date.now() - c.ts < 15000) return c.data;
  try {
    const r = await axios.get(`${API}/v1/channels/live-stats?channelId=${channelId}`, { headers: headers(), timeout: 8000 });
    const data = r.data?.data || {};
    liveStatsCache[channelId] = { ts: Date.now(), data };
    return data;
  } catch (e) { return c?.data || null; }
}
app.get("/api/viewers/:username", async (req, res) => {
  res.set("Access-Control-Allow-Origin", "*");
  const channelId = findChannelByUsername(req.params.username) || await getChannelIdBySlug(req.params.username.toLowerCase());
  if (!channelId) return res.json({ viewers: 0, isLive: false });
  const d = await getLiveStats(channelId);
  res.json({ viewers: d?.viewerCount ?? 0, isLive: !!d?.isLive });
});

// Viewer-count overlay. OBS Browser Source, transparent, e.g. 340x110.
// Shows BLAZE branding so multi-stream viewers know it's the Blaze count. Override with ?label=... or ?logo=<imageURL>.
app.get("/overlay/viewers/:username", (req, res) => {
  const label = (req.query.label || "BLAZE").toString();
  const logo  = (req.query.logo || process.env.BLAZE_LOGO_URL || "").toString();
  const brand = logo ? `<img class="logo" src="${esc(logo)}">` : `<span class="brand">${esc(label)}</span>`;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Viewers</title>
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:'Segoe UI',sans-serif;}
  .badge{display:inline-flex;align-items:center;gap:11px;padding:12px 20px;border-radius:16px;
    background:rgba(10,14,10,.72);border:2px solid #2c7a4a;box-shadow:0 4px 18px rgba(0,0,0,.5);
    color:#fff;font-size:34px;font-weight:800;line-height:1;}
  .dot{width:14px;height:14px;border-radius:50%;background:#e8776a;box-shadow:0 0 10px #e8776a;flex:none;}
  .dot.live{background:#4ade80;box-shadow:0 0 12px #4ade80;animation:pulse 1.6s infinite;}
  .brand{color:#ffc62e;font-weight:900;letter-spacing:.5px;text-shadow:0 0 8px rgba(255,198,46,.4);}
  .logo{height:34px;width:auto;display:block;}
  .eye{font-size:30px;} .n{color:#7CFC9A;min-width:1ch;}
  @keyframes pulse{0%,100%{opacity:1;}50%{opacity:.4;}}
</style></head><body>
<div class="badge"><span class="dot" id="dot"></span>${brand}<span class="eye">👁️</span><span class="n" id="n">0</span></div>
<script>
  const USER=${JSON.stringify(req.params.username)};
  async function poll(){
    try{
      const r=await fetch('/api/viewers/'+encodeURIComponent(USER)); const d=await r.json();
      document.getElementById('n').textContent=d.viewers??0;
      document.getElementById('dot').className='dot'+(d.isLive?' live':'');
    }catch(e){}
  }
  setInterval(poll,15000); poll();
</script></body></html>`);
});

// MASCOT overlay — Blazeian runs across the screen, pops up, sits & "watches" with you.
// OBS Browser Source, transparent, full stream size (e.g. 1920x1080). ?img=<png> to swap the sprite,
// ?min=/?max= seconds between appearances (default 45–120), ?size=px (default 150).
app.get("/overlay/mascot/:username", (req, res) => {
  const img  = (req.query.img || process.env.MASCOT_SPRITE || MASCOT_URL).toString();
  const size = parseInt(req.query.size, 10) || 150;
  const min  = parseInt(req.query.min, 10) || 45;
  const max  = parseInt(req.query.max, 10) || 120;
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Mascot</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:'Segoe UI',sans-serif;pointer-events:none;}
  #m{position:absolute;left:0;bottom:0;width:${size}px;height:${size}px;opacity:0;will-change:left,bottom,opacity;}
  #flip{width:100%;height:100%;}
  #img{width:100%;height:100%;display:block;object-fit:contain;filter:drop-shadow(0 4px 10px rgba(0,0,0,.55));}
  #bub{position:absolute;bottom:102%;left:50%;transform:translateX(-50%) scale(.7);trans-origin:bottom center;
    background:rgba(10,16,10,.9);border:2px solid #2c7a4a;color:#eafff0;font-weight:700;font-size:20px;
    padding:8px 14px;border-radius:14px;white-space:nowrap;opacity:0;transition:opacity .25s,transform .25s;box-shadow:0 4px 14px rgba(0,0,0,.5);}
  #bub.show{opacity:1;transform:translateX(-50%) scale(1);}
  #bub:after{content:"";position:absolute;top:100%;left:50%;transform:translateX(-50%);border:8px solid transparent;border-top-color:#2c7a4a;}
  .run{animation:run .45s infinite ease-in-out;}
  .idle{animation:idle 2.2s infinite ease-in-out;}
  @keyframes run{0%,100%{transform:translateY(0) rotate(-5deg);}50%{transform:translateY(-16px) rotate(5deg);}}
  @keyframes idle{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}
</style></head><body>
<div id="m"><div id="bub"></div><div id="flip"><img id="img" src="${esc(img)}"></div></div>
<script>
  const SIZE=${size}, MIN=${min}, MAX=${max};
  const m=document.getElementById('m'), flip=document.getElementById('flip'), img=document.getElementById('img'), bub=document.getElementById('bub');
  const W=()=>innerWidth, H=()=>innerHeight, sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const LINES=["watching with you 👀💚","let's GOOO 🔥","hi chat!! 💚","I'm right here 🫶","vibing 😎🔥","gg 💚","this stream slaps 🔥","love you guys 💚","chat's on fire today 🔥","best crew on Blaze 💚"];
  const pick=a=>a[Math.floor(Math.random()*a.length)];
  function face(dir){ flip.style.transform='scaleX('+(dir<0?-1:1)+')'; }
  function say(t){ bub.textContent=t; bub.classList.add('show'); }
  function hush(){ bub.classList.remove('show'); }
  function pos(x,y){ m.style.left=x+'px'; m.style.bottom=y+'px'; }
  async function runAcross(){
    const L=Math.random()<.5, y=10+Math.random()*40;
    face(L?1:-1); m.style.transition='none'; pos(L?-SIZE-40:W()+40,y); m.style.opacity=1; img.className='run';
    await sleep(60); if(Math.random()<.6) say(pick(LINES));
    const d=5000+Math.random()*2500; m.style.transition='left '+d+'ms linear'; pos(L?W()+40:-SIZE-40,y);
    await sleep(d); img.className=''; hush(); m.style.opacity=0;
  }
  async function peek(){
    const x=W()*.12+Math.random()*W()*.66; face(Math.random()<.5?1:-1);
    m.style.transition='none'; pos(x,-SIZE-30); m.style.opacity=1;
    await sleep(60); m.style.transition='bottom .55s cubic-bezier(.2,1.5,.4,1)'; m.style.bottom='0px'; img.className='idle';
    await sleep(600); say(pick(LINES)); await sleep(3200); hush();
    m.style.transition='bottom .45s ease-in'; m.style.bottom=(-SIZE-30)+'px'; await sleep(450); img.className=''; m.style.opacity=0;
  }
  async function sitAndWatch(){
    const L=Math.random()<.5, y=8, sitX=L?24:W()-SIZE-24;
    face(L?1:-1); m.style.transition='none'; pos(L?-SIZE-40:W()+40,y); m.style.opacity=1; img.className='run';
    await sleep(60); m.style.transition='left 3s linear'; pos(sitX,y);
    await sleep(3000); img.className='idle'; face(L?-1:1);
    if(Math.random()<.7){ say(pick(LINES)); await sleep(2600); hush(); }
    await sleep(14000+Math.random()*20000);
    if(Math.random()<.6){ say(pick(LINES)); await sleep(2400); hush(); }
    img.className='run'; face(L?1:-1); m.style.transition='left 3s linear'; pos(L?W()+40:-SIZE-40,y);
    await sleep(3000); img.className=''; m.style.opacity=0;
  }
  const ACTS=[runAcross,runAcross,peek,sitAndWatch];
  (async function loop(){
    await sleep(4000); // first appearance is quick so you can test it
    while(true){ try{ await pick(ACTS)(); }catch(e){} await sleep((MIN+Math.random()*(MAX-MIN))*1000); }
  })();
</script></body></html>`);
});

// TEST the emote wall without waiting for live chat: injects a few emotes into the buffer.
app.get("/admin/testemote/:username", (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const channelId = findChannelByUsername(req.params.username);
  if (!channelId) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  ["🔥","💚","😂","🎉","👀","🫶","💜","⚡","🙌","😎"].forEach(e => pushEmote(channelId, e, false));
  res.send("Injected 10 test emotes 🔥 — watch your Emote-Wall overlay, they should float up within ~2s.");
});

// =============================================
// START — load data FIRST, then connect socket
// =============================================
app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);
  channels = await loadChannelsFromCloud();
  console.log(`Loaded ${Object.keys(channels).length} channel(s)`);
  await getAppAccessToken();
  await refreshAccessToken(); // start with a fresh user token so subscriptions don't fail with "Unauthorized"
  if (!SESSION_TOKEN && BOT_EMAIL && BOT_PASSWORD) { console.log("No session token on boot — auto-logging in…"); await loginSession(); }
  connectSocket();

  // After the socket & subscriptions settle, announce a NEW version to everyone (once).
  setTimeout(startupAnnounce, 25000);

  // Keep-alive backup (UptimeRobot is primary)
  setInterval(async () => {
    try { await axios.get(`${SELF_URL}/ping`, { timeout: 8000 }); console.log("Keep-alive ping ok"); }
    catch (e) { console.log("Keep-alive ping failed:", e.message); }
  }, 10 * 60 * 1000);

  // Socket watchdog
  setInterval(() => {
    if (!socket || socket.disconnected) { console.log("Watchdog: socket down, reconnecting..."); connectSocket(); }
  }, 5 * 60 * 1000);

  // Self-learning: every 8 min, refresh ONE channel's profile (round-robin, staggered to spread API calls).
  let _profIdx = 0;
  setInterval(async () => {
    const ids = Object.keys(channels).filter(id => id !== BOT_CHANNEL_ID && (chatSamples[id]?.length || 0) >= 12);
    if (!ids.length) return;
    const id = ids[_profIdx % ids.length]; _profIdx++;
    await learnChannelProfile(id);
  }, 8 * 60 * 1000);

  // TIMED MESSAGES: every minute, post any due scheduled messages (per channel).
  setInterval(runTimedMessages, 60 * 1000);

  // Daily session health check: confirm the follow session token still works.
  // (Once the login endpoint is wired, this also auto-re-logins; for now it warns loudly.)
  setTimeout(() => { checkSessionHealth(); setInterval(checkSessionHealth, 24 * 60 * 60 * 1000); }, 60 * 1000);
});

let lastSessionOk = true;
async function checkSessionHealth() {
  // preventively mint a fresh token daily if we have credentials
  if (BOT_EMAIL && BOT_PASSWORD) { await loginSession(); }
  if (!SESSION_TOKEN || !SESSION_VISITOR_ID) {
    if (!await loginSession()) { console.log("[SESSION-CHECK] no session token & no working login"); return; }
  }
  const testId = Object.keys(channels).find(id => id !== BOT_CHANNEL_ID);
  if (!testId) return;
  const ok = await followChannel(testId); // already-following counts as healthy; auto-relogins on 401
  if (ok) { console.log("[SESSION-CHECK] ✅ follow session healthy"); lastSessionOk = true; }
  else {
    console.log("[SESSION-CHECK] ❌ follow session DEAD even after relogin attempt");
    if (lastSessionOk) {
      lastSessionOk = false;
      const ownerId = findChannelByUsername("brachial513") || BOT_CHANNEL_ID;
      if (ownerId && channels[ownerId]) {
        try { sendChat(ownerId, "⚠️ Heads up Brachial — my follow session broke and I couldn't fix it myself. Check BLAZE_BOT_EMAIL/PASSWORD or re-run /admin/setsession 💚"); } catch (e) {}
      }
    }
  }
}
