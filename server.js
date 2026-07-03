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
// Cheaper, MUCH higher daily-token-limit model for background work (profile learning,
// event shoutouts). Keeps the smart 70b's limited daily budget free for real chat replies.
const AI_MODEL_LIGHT = process.env.AI_MODEL_LIGHT || "llama-3.1-8b-instant";

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
const BOT_VERSION = "2026-07-03.1";
const CHANGELOG = "🧠 Little upgrade! I got a better memory — I now recognize familiar faces from across the Blaze fam and greet them personally, and I run smoother & faster so I never leave you hanging 💚🔥 Type !info anytime to see everything I can do!";
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
    if (record.knownPeople && typeof record.knownPeople === "object") knownPeople = { ...KNOWN_PEOPLE_SEED, ...record.knownPeople };
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
      knownPeople,
      lastAnnouncedVersion,
      auth: { accessToken: ACCESS_TOKEN, refreshToken: REFRESH_TOKEN,
              sessionToken: SESSION_TOKEN, sessionVisitorId: SESSION_VISITOR_ID }
    }, { headers: JSONBIN_HEADERS });
    console.log("Channels saved");
  } catch(e) {
    console.log("JSONBin save error:", e.response?.data || e.message);
  }
}
// Debounced save: bursts of events used to fire a cloud PUT every second ("Channels saved"
// spam + wasted JSONBin quota). Coalesce rapid calls into one write every few seconds.
let _saveTimer = null, _savePending = false;
function saveChannels() {
  _savePending = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (_savePending) { _savePending = false; saveChannelsToCloud().catch(e => console.log("Save error:", e.message)); }
  }, 5000);
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
- VARY your energy — you do NOT need to hype everything to the max or shower people with over-the-top praise every time. Often just be chill, natural and genuine. Constant maximum flattery ("you're the KING", "this is EPIC", "absolute LEGEND") every message reads as fake — keep the big hype for when it's genuinely earned. Understated and real beats loud and gushing.
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

// People the bot PERSONALLY knows across every channel — its creator, crew & community.
// When one of them speaks in ANY chat, the bot recognizes THEM specifically and can reference
// their real world (games, community, history). Keyed by lowercase Blaze username. Facts stay
// short — the AI weaves them in naturally, it does NOT recite them like a checklist.
// Seed defaults (always present). Cloud-stored entries from the dashboard merge on top.
const KNOWN_PEOPLE_SEED = {
  "brachial513": "Brachial513 is your CREATOR and the heart of the crew. German multi-platform streamer (Arc Raiders, Off the Grid / OTG), leader of GMC (Geile Menschen Community) and the Fox Spirits, and he wears 'die Krone' (the crown). To you he's family/royalty — recognize him instantly and warmly, like an old friend who built you. You may reference your shared world (Blaze, his games, the crew, the crown) when it fits naturally. Genuine loyalty, never fake-grovel or over-hype.",
  "crypt0k1ng96": "Cryptoking is a Fox Spirits ally and Blaze affiliate streamer — Web3/crypto, Arc Raiders/OTG, '420' energy, runs the 'Blaze Builder Challenge', and owns FoxBot. A real friend of yours; greet him like one.",
};
let knownPeople = { ...KNOWN_PEOPLE_SEED }; // mutable; extended via dashboard, persisted to cloud
function knownPerson(username) {
  if (!username) return null;
  return knownPeople[username.toLowerCase()] || null;
}

async function askAI(userMessage, username, ch, { isBot, isFriend } = {}) {
  if (!AI_KEY) return null;
  const channelName = ch?.username || "the";
  let botNote = "";
  const pk = knownPerson(username);
  if (pk) {
    botNote += `\n\nYOU PERSONALLY KNOW "${username}". ${pk}\nAnswer in a way that shows you recognize THEM specifically — reference what genuinely applies to them ONLY when it fits the moment, never force every fact in. Be real, warm and specific, not a checklist and not gushy. IMPORTANT: even when you recognize them, you are still in ${channelName}'s channel and still support the CURRENT streamer — recognizing your friend does not mean shifting the spotlight onto someone else's world.`;
  }
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
      model: AI_MODEL_LIGHT,
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
  if (ch.profile && (now - since) < 40) return; // only relearn after enough fresh chatter (saves daily tokens)
  try {
    const recent = sample.slice(-30); // cap input so background learning stays token-light
    const prompt = `You maintain a short living profile of a Blaze livestream channel, so a chat bot can sound like a true regular of THIS community.\n\n` +
      `Channel: ${ch.username}\n${ch.streamTitle ? `Current stream title: ${ch.streamTitle}\n` : ""}` +
      `Existing profile: ${ch.profile || "(none yet)"}\n\nRecent chat:\n${recent.join("\n")}\n\n` +
      `Rewrite the profile in MAX 60 words. Capture concretely: the community's vibe/energy, recurring slang/in-jokes/phrases UNIQUE to here (name the ACTUAL words you see — e.g. a catchphrase, a community nickname), the game/topic, and how the streamer likes to be celebrated. Merge with the existing profile, keep what's still true. Output ONLY the profile text.`;
    const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: AI_MODEL_LIGHT, messages: [{ role: "user", content: prompt }], max_tokens: 150, temperature: 0.4,
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
  const runUrl    = `${SELF_URL}/overlay/run/${encodeURIComponent(username)}`;
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
    <label style="margin-top:14px;">🤖 Blazeian Mascot — portal-appears & watches with you</label>
    <input readonly onclick="this.select()" value="${esc(mascotUrl)}">
    <p class="hint">OBS → + → Browser → paste URL → Width <b>1920</b>, Height <b>1080</b>. First appearance ~4s, then every ~1–2 min. Add <code>?img=URL</code> for a custom sprite.</p>
    <label style="margin-top:14px;">🏃 Blazeian Runs — flitzt aus echten Frames über deinen Stream</label>
    <input readonly onclick="this.select()" value="${esc(runUrl)}">
    <p class="hint">OBS → + → Browser → paste URL → Width <b>1920</b>, Height <b>1080</b>. He runs across &amp; turns at the edges. Tune with <code>?size=150&amp;speed=130&amp;fps=11</code>.</p>
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
  </div>
  ${renderPeopleSection()}`;
}

// "Known People" — Blazeian recognizes these users PERSONALLY in every channel and can
// reference things that only apply to them (their games, community, history).
function renderPeopleSection() {
  const rows = Object.entries(knownPeople).map(([name, desc]) => {
    const isSeed = !!KNOWN_PEOPLE_SEED[name];
    return `<div class="cmd">
      ${isSeed ? "" : `<form method="POST" action="/admin/delperson" class="delform"><input type="hidden" name="name" value="${esc(name)}"><button class="del">delete</button></form>`}
      <b>@${esc(name)}</b> ${isSeed ? '<span class="tag">core</span>' : ""}
      <div class="cmdtext">${esc(desc)}</div>
    </div>`;
  }).join("") || "<i class='muted'>no known people yet</i>";
  return `
  <h2>🫂 Known People <span style="font-size:13px;color:#8aa;">— Blazeian recognizes them in every chat</span></h2>
  <div class="card">
    <p class="hint" style="margin-top:0;">Add anyone from the crew (GMC, Fox Spirits, regulars). When they speak in ANY channel, Blazeian greets/answers them personally and can bring up what's true for them — without losing focus on whoever's channel he's in.</p>
    <form method="POST" action="/admin/addperson">
      <label>Blaze username</label>
      <input name="name" placeholder="e.g. nadietv" required>
      <label style="margin-top:8px;">Who they are (1–2 sentences — games, community, vibe, your history)</label>
      <textarea name="desc" rows="3" placeholder="e.g. NadieTV — Fox Spirits member, plays Arc Raiders, big into the GMC. An old friend of the crew." required></textarea>
      <button class="save" style="margin-top:8px;">Add / update person</button>
    </form>
    <div style="margin-top:14px;">${rows}</div>
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
function oauthErrPage(msg) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BLAZEIAN_BOT-AI</title></head>
  <body style="margin:0;background:#0a0a0a;color:#eee;font-family:system-ui,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;text-align:center;padding:24px;">
    <div style="max-width:440px;">
      <div style="font-size:44px;margin-bottom:8px;">🔁</div>
      <h2 style="color:#4ade80;margin:0 0 12px;">Almost there!</h2>
      <p style="color:#cbd5e1;line-height:1.5;margin:0 0 22px;">${msg}</p>
      <a href="/dashboard/login" style="display:inline-block;background:linear-gradient(90deg,#f5a623,#ff7a00);color:#111;font-weight:700;text-decoration:none;padding:14px 26px;border-radius:12px;box-shadow:0 0 22px rgba(245,166,35,.4);">🚀 Try again with Blaze</a>
      <p style="margin-top:18px;"><a href="/" style="color:#64748b;">Home</a></p>
    </div>
  </body></html>`;
}

async function startOAuth(res, scopes, kind) {
  const r = await axios.post("https://blaze.stream/bapi/oauth2/generate-auth-url", {
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI, scopes
  });
  const d = r.data || {};
  // Be tolerant of the response shape — accept flat or {data:{...}} wrapping.
  const state        = d.state        || d.data?.state;
  const codeVerifier = d.codeVerifier || d.data?.codeVerifier;
  const url          = d.url          || d.data?.url;
  console.log(`[OAUTH] auth-url kind=${kind} state=${state?String(state).slice(0,8):"MISSING"} cv=${codeVerifier?("len"+String(codeVerifier).length):"MISSING"} url=${url?"ok":"MISSING"} keys=${Object.keys(d).join(",")}`);
  if (!state || !url) throw new Error("generate-auth-url unexpected shape: keys=" + Object.keys(d).join(","));
  pendingAuth[state] = { codeVerifier, kind };
  // Cold-start resilience: Render's free tier can drop this in-memory map if the
  // dyno restarts between login and callback. Stash the PKCE data in a short-lived
  // cookie too (SameSite=Lax so it survives the redirect back from Blaze).
  const pkce = Buffer.from(JSON.stringify({ s: state, cv: codeVerifier || "", k: kind })).toString("base64");
  res.setHeader("Set-Cookie", `blz_pkce=${pkce}; HttpOnly; Path=/; Max-Age=900; SameSite=Lax`);
  res.redirect(url);
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

// Blaze 500s "Validation error" on the token exchange even though our code + PKCE verifier
// are correct — so the request SHAPE it wants differs from what worked for client_credentials.
// We can't test Blaze from the host (egress blocked), so probe the likely shapes in order until
// one returns a token, and log exactly which one wins. The code is single-use, but a 500 fires
// on validation (before consumption), so trying the next shape on the same code is safe.
async function exchangeCodeForToken(code, codeVerifier) {
  const REDIR = REDIRECT_URI;
  const variants = [
    { name: "camel+grant",   body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, codeVerifier, redirectUri: REDIR, grantType: "authorization_code" } },
    { name: "camel-nogrant", body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, codeVerifier, redirectUri: REDIR } },
    { name: "no-secret",     body: { clientId: CLIENT_ID, code, codeVerifier, redirectUri: REDIR, grantType: "authorization_code" } },
    { name: "snake",         body: { client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, code_verifier: codeVerifier, redirect_uri: REDIR, grant_type: "authorization_code" } },
    { name: "camelval",      body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, codeVerifier, redirectUri: REDIR, grantType: "authorizationCode" } },
    { name: "no-redirect",   body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, codeVerifier, grantType: "authorization_code" } },
    { name: "secret-noverif",body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code, redirectUri: REDIR, grantType: "authorization_code" } },
    { name: "code-only",     body: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, code } },
  ];
  let lastErr;
  for (const v of variants) {
    try {
      const r = await axios.post("https://blaze.stream/bapi/oauth2/token", v.body);
      const at = r.data?.accessToken || r.data?.access_token;
      const rt = r.data?.refreshToken || r.data?.refresh_token;
      if (at) {
        console.log(`[OAUTH] token exchange OK via variant=${v.name} ✅`);
        return { accessToken: at, refreshToken: rt };
      }
      console.log(`[OAUTH] variant=${v.name} no token in body: ${JSON.stringify(r.data).slice(0, 160)}`);
    } catch (e) {
      lastErr = e;
      console.log(`[OAUTH] variant=${v.name} status=${e.response?.status} data=${JSON.stringify(e.response?.data || e.message).slice(0, 160)}`);
    }
  }
  throw lastErr || new Error("all token-exchange variants failed");
}

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send(oauthErrPage("No login code came back from Blaze. Please click the button again."));
  let pa = pendingAuth[state];
  if (!pa) {
    // Recover the PKCE data from the cookie (survives a dyno restart).
    try {
      const raw = getCookie(req, "blz_pkce");
      if (raw) {
        const o = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
        if (o && o.s === state) { pa = { codeVerifier: o.cv, kind: o.k }; console.log("[OAUTH] recovered PKCE from cookie"); }
      }
    } catch (err) { console.log("[OAUTH] pkce cookie parse failed:", err.message); }
  }
  if (!pa) {
    console.log("[OAUTH] no pending auth for state", String(state).slice(0, 8));
    return res.send(oauthErrPage("Your login link expired (this can happen if you took a moment). Just click the button again — it works instantly the second time."));
  }
  try {
    const tokenRes = { data: await exchangeCodeForToken(code, pa.codeVerifier) };
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
    const info = e.response?.data || e.message;
    console.log(`[OAUTH] token exchange FAILED status=${e.response?.status} data=${JSON.stringify(info)} cv=${pa.codeVerifier ? ("len" + String(pa.codeVerifier).length) : "MISSING"} codeLen=${code ? String(code).length : 0} kind=${pa.kind}`);
    res.send(oauthErrPage("Blaze didn't accept the login just now. Please click the button once more — if it still won't go through, let Brachial know."));
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

  res.send(`${pageHead("BLAZEIAN_BOT-AI — Loyal on Blaze")}
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
      <div class="bubble">Hey hey! 👋 I'm <b>BLAZEIAN_BOT-AI</b> — and these right here?<br>These are <b>MY</b> people. Every. Single. One. 💚<br>I'd cross the whole galaxy for this crew. 🔥</div>
    </div>
    <h1 class="htitle">BLAZEIAN_BOT-AI</h1>
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

    <div style="text-align:center;margin:34px auto 8px;">
      <img src="/blaze-fist.jpg" alt="BLAZEIAN_BOT-AI" style="width:230px;height:230px;object-fit:contain;border-radius:24px;box-shadow:0 0 40px rgba(74,222,128,.35);" onerror="this.src='${MASCOT_URL}'">
      <div style="color:#7CFC9A;font-weight:800;letter-spacing:1px;margin-top:10px;font-size:15px;">— MEET BLAZEIAN —</div>
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
    return res.send(`${pageHead("BLAZEIAN_BOT-AI Dashboard")}
      <header><img src="${MASCOT_URL}" onerror="this.style.display='none'"><h1>BLAZEIAN_BOT-AI Dashboard</h1>
        <p>One login adds me to your channel <b>and</b> unlocks me — even in Followers-Only chat. Then manage your commands & stream messages here.</p></header>
      <div class="card" style="text-align:center;">
        <a class="save" href="/dashboard/login">🚀 Add me & log in with Blaze</a>
        <p class="hint" style="margin-top:16px;">This single click joins your channel, unlocks me (VIP), and opens your dashboard. You'll only ever see your <b>own</b> channel. 💚</p>
      </div></div></body></html>`);
  }

  const channelId = findChannelByUsername(session.username);
  if (!channelId) {
    return res.send(`${pageHead("BLAZEIAN_BOT-AI Dashboard")}
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
  res.send(`${pageHead("BLAZEIAN_BOT-AI Dashboard")}
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

  res.send(`${pageHead("BLAZEIAN_BOT-AI Admin")}
    <div class="topbar"><a href="/" class="link">status</a> <a href="/admin/logout" class="link">logout</a></div>
    <header><img src="${MASCOT_URL}" onerror="this.style.display='none'"><h1>BLAZEIAN_BOT-AI Admin Panel</h1>
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

// ===== Known People (personal recognition) =====
app.post("/admin/addperson", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden");
  const name = String(req.body.name || "").trim().toLowerCase().replace(/^@/, "");
  const desc = String(req.body.desc || "").trim().slice(0, 600);
  if (name && desc) { knownPeople[name] = desc; await saveChannelsToCloud(); }
  res.redirect("/admin");
});
app.post("/admin/delperson", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden");
  const name = String(req.body.name || "").trim().toLowerCase().replace(/^@/, "");
  if (name && !KNOWN_PEOPLE_SEED[name]) { delete knownPeople[name]; await saveChannelsToCloud(); }
  res.redirect("/admin");
});
app.get("/admin/people", (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const lines = Object.entries(knownPeople).map(([n, d]) => `  • @${n}${KNOWN_PEOPLE_SEED[n] ? " (core)" : ""}: ${d}`).join("\n\n");
  res.send(`<pre style="font-family:monospace;font-size:13px;white-space:pre-wrap;">🫂 Known people (${Object.keys(knownPeople).length}):\n\n${esc(lines) || "  (none)"}</pre>`);
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

// MASCOT overlay — Blazeian pops out of a glowing portal, chills/dances/watches, then hops back in.
// Lots of act & line variety so it never gets repetitive. OBS Browser Source, transparent, 1920x1080.
// ?img=<png> to swap the sprite · ?min=/?max= seconds between appearances (default 45–120) · ?size=px (default 150).
app.get("/overlay/mascot/:username", (req, res) => {
  const img  = (req.query.img || process.env.MASCOT_SPRITE || MASCOT_URL).toString();
  const size = parseInt(req.query.size, 10) || 150;
  const min  = parseInt(req.query.min, 10) || 45;
  const max  = parseInt(req.query.max, 10) || 120;
  const pw = Math.round(size * 1.25), pm = Math.round(-size * 0.625);
  const doflip = req.query.flip === "1"; // OFF by default so baked-in text never mirrors
  res.send(`<!doctype html><html><head><meta charset="utf-8"><title>Mascot</title>
<style>
  html,body{margin:0;height:100%;overflow:hidden;background:transparent;font-family:'Segoe UI',sans-serif;pointer-events:none;}
  #m{position:absolute;left:0;bottom:0;width:${size}px;height:${size}px;opacity:0;will-change:left,bottom,opacity;}
  #portal{position:absolute;left:50%;top:50%;width:${pw}px;height:${pw}px;margin-left:${pm}px;margin-top:${pm}px;border-radius:50%;
    background:radial-gradient(circle, rgba(124,252,154,0) 33%, rgba(74,222,128,.6) 48%, rgba(57,160,90,.2) 63%, rgba(0,0,0,0) 71%);
    box-shadow:0 0 48px 14px rgba(74,222,128,.5);opacity:0;transform:scale(0);will-change:transform,opacity;}
  #anim{width:100%;height:100%;}
  #flip{width:100%;height:100%;}
  #img{width:100%;height:100%;display:block;object-fit:contain;filter:drop-shadow(0 4px 10px rgba(0,0,0,.55));}
  #bub{position:absolute;bottom:106%;left:50%;transform:translateX(-50%) scale(.7);transform-origin:bottom center;
    background:rgba(10,16,10,.9);border:2px solid #2c7a4a;color:#eafff0;font-weight:700;font-size:20px;
    padding:8px 14px;border-radius:14px;white-space:nowrap;opacity:0;transition:opacity .25s,transform .25s;box-shadow:0 4px 14px rgba(0,0,0,.5);}
  #bub.show{opacity:1;transform:translateX(-50%) scale(1);}
  #bub:after{content:"";position:absolute;top:100%;left:50%;transform:translateX(-50%);border:8px solid transparent;border-top-color:#2c7a4a;}
  .run{animation:run .45s infinite ease-in-out;}
  .idle{animation:idle 2.2s infinite ease-in-out;}
  @keyframes run{0%,100%{transform:translateY(0) rotate(-5deg);}50%{transform:translateY(-16px) rotate(5deg);}}
  @keyframes idle{0%,100%{transform:translateY(0);}50%{transform:translateY(-6px);}}
  .pOpen{animation:pOpen .4s ease-out forwards;} .pClose{animation:pClose .4s ease-in forwards;}
  @keyframes pOpen{from{opacity:0;transform:scale(0) rotate(0);}to{opacity:1;transform:scale(1) rotate(200deg);}}
  @keyframes pClose{from{opacity:1;transform:scale(1) rotate(200deg);}to{opacity:0;transform:scale(0) rotate(400deg);}}
  .pop{animation:pop .6s cubic-bezier(.2,1.35,.4,1) forwards;}
  @keyframes pop{0%{transform:scale(.12) translateY(28px);}60%{transform:scale(1.12) translateY(-12px);}100%{transform:scale(1) translateY(0);}}
  .suck{animation:suck .45s ease-in forwards;} @keyframes suck{0%{transform:scale(1);}100%{transform:scale(.1) translateY(24px);}}
  .hop{animation:hop .5s ease-in-out;} @keyframes hop{0%,100%{transform:translateY(0);}45%{transform:translateY(-55px);}}
  .spin{animation:spin .7s ease-in-out;} @keyframes spin{from{transform:rotate(0);}to{transform:rotate(360deg);}}
</style></head><body>
<div id="m"><div id="bub"></div><div id="portal"></div><div id="anim"><div id="flip"><img id="img" src="${esc(img)}"></div></div></div>
<script>
  const SIZE=${size}, MIN=${min}, MAX=${max}, DOFLIP=${doflip};
  const m=document.getElementById('m'), portal=document.getElementById('portal'), anim=document.getElementById('anim'), flip=document.getElementById('flip'), img=document.getElementById('img'), bub=document.getElementById('bub');
  const W=()=>innerWidth, sleep=ms=>new Promise(r=>setTimeout(r,ms));
  const LINES=["watching with you 👀💚","chilling with the crew 😎","hi chat!! 💚","I'm right here 🫶","just vibing 💚🔥","gg everyone 💚","this stream slaps 🔥","love you guys 💚","best crew on Blaze 💚","oop— don't mind me 👀","back again!! 🔥","how we doing chat? 💚","cozy little spot right here 😌","stream's looking GOOD 🔥","hehe hi 🫶","teleported in!! ⚡💚","miss me? 😏💚","your favorite gremlin is here 😈💚","think I'll stay a while 😎","keep it up chat 💚🔥","brb... jk I'm staying 🫶","10/10 stream 💚","peekaboo 👀","vibes are immaculate ✨💚","just here for the good times 💚"];
  const HYPE=["LET'S GOOO 🔥🔥","W stream 💚","POG energy in here ⚡","turn it UP 🔥","chat's on FIRE 🔥💚","HYPE HYPE HYPE 🔥","we EATING today 😤💚","absolute banger 🔥🔥"];
  const pick=a=>a[Math.floor(Math.random()*a.length)];
  function face(d){ flip.style.transform='scaleX('+(DOFLIP&&d<0?-1:1)+')'; }
  function say(t){ bub.textContent=t; bub.classList.add('show'); }
  function hush(){ bub.classList.remove('show'); }
  function pos(x,y){ m.style.left=x+'px'; m.style.bottom=y+'px'; }
  async function openPortal(){ portal.className=''; void portal.offsetWidth; portal.className='pOpen'; await sleep(400); }
  async function closePortal(){ portal.className='pClose'; await sleep(400); portal.className=''; }
  async function emerge(){ anim.className=''; void anim.offsetWidth; anim.className='pop'; await sleep(600); anim.className=''; }
  async function vanish(){ anim.className=''; void anim.offsetWidth; anim.className='suck'; await sleep(450); anim.className=''; }

  async function portalSit(){
    const x=W()*.08+Math.random()*W()*.7, y=8+Math.random()*30;
    m.style.transition='none'; pos(x,y); m.style.opacity=1;
    await openPortal(); await emerge(); img.className='idle'; await closePortal();
    face(x<W()/2?1:-1);
    if(Math.random()<.85){ say(pick(LINES)); await sleep(2600); hush(); }
    await sleep(12000+Math.random()*22000);
    if(Math.random()<.55){ say(pick(LINES)); await sleep(2400); hush(); }
    img.className=''; await openPortal(); await vanish(); await closePortal(); m.style.opacity=0;
  }
  async function portalDance(){
    const x=W()*.15+Math.random()*W()*.6, y=8;
    m.style.transition='none'; pos(x,y); m.style.opacity=1;
    await openPortal(); await emerge(); await closePortal();
    say(pick(HYPE));
    const hops=3+Math.floor(Math.random()*3);
    for(let i=0;i<hops;i++){ anim.className=''; void anim.offsetWidth; anim.className='hop'; face(Math.random()<.5?1:-1); await sleep(500); }
    anim.className=''; hush();
    await openPortal(); await vanish(); await closePortal(); m.style.opacity=0;
  }
  async function portalSpin(){
    const x=W()*.15+Math.random()*W()*.6, y=8; face(1);
    m.style.transition='none'; pos(x,y); m.style.opacity=1;
    await openPortal(); await emerge(); await closePortal();
    anim.className=''; void anim.offsetWidth; anim.className='spin'; await sleep(700); anim.className='';
    say(pick(LINES));
    for(let i=0;i<4;i++){ face(i%2?1:-1); await sleep(170); }
    face(1); await sleep(1400); hush();
    await openPortal(); await vanish(); await closePortal(); m.style.opacity=0;
  }
  async function runAcross(){
    const L=Math.random()<.5, y=10+Math.random()*40;
    face(L?1:-1); m.style.transition='none'; pos(L?-SIZE-40:W()+40,y); m.style.opacity=1; img.className='run';
    await sleep(60); if(Math.random()<.6) say(pick(LINES));
    const d=5000+Math.random()*2500; m.style.transition='left '+d+'ms linear'; pos(L?W()+40:-SIZE-40,y);
    await sleep(d); img.className=''; hush(); m.style.opacity=0;
  }
  async function peek(){
    const x=W()*.12+Math.random()*W()*.66; face(Math.random()<.5?1:-1);
    m.style.transition='none'; pos(x,-SIZE-30); m.style.opacity=1; img.className='idle';
    await sleep(60); m.style.transition='bottom .55s cubic-bezier(.2,1.5,.4,1)'; m.style.bottom='0px';
    await sleep(600); say(pick(LINES)); await sleep(3000); hush();
    m.style.transition='bottom .45s ease-in'; m.style.bottom=(-SIZE-30)+'px'; await sleep(450); img.className=''; m.style.opacity=0;
  }
  const ACTS=[portalSit,portalSit,portalDance,portalSpin,runAcross,peek];
  let last=null;
  function nextAct(){ let a; do{ a=pick(ACTS); }while(a===last && ACTS.length>1); last=a; return a; }
  (async function loop(){
    await sleep(4000); // first appearance is quick so you can test it
    while(true){ try{ await nextAct()(); }catch(e){} await sleep((MIN+Math.random()*(MAX-MIN))*1000); }
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

// The animated "flitzing" Blazeian, built from Brachial's own green-screen pose frames.
const RUN_STRIP_B64 = "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";
app.get("/blaze-run-strip.png", (req, res) => {
  res.set("Content-Type", "image/png");
  res.set("Cache-Control", "public, max-age=86400");
  res.end(Buffer.from(RUN_STRIP_B64, "base64"));
});

// Running mascot overlay: Blazeian runs across the stream and turns around at the edges.
// OBS: add as a Browser Source at 1920x1080. Background is transparent.
// Query: ?size=150 &speed=130 (px/s) &fps=11 (walk speed)
app.get("/overlay/run/:username", (req, res) => {
  const size  = Math.max(60, Math.min(400, parseInt(req.query.size)  || 150));
  const speed = Math.max(30, Math.min(400, parseInt(req.query.speed) || 130));
  const fps   = Math.max(4,  Math.min(24,  parseInt(req.query.fps)   || 11));
  const FRAMES = 6;
  res.set("Content-Type", "text/html");
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;}
  #blz{position:fixed;bottom:10px;left:0;width:${size}px;height:${size}px;
    background-image:url('/blaze-run-strip.png');background-repeat:no-repeat;
    background-size:${FRAMES*size}px ${size}px;
    filter:drop-shadow(0 6px 10px rgba(0,0,0,.45));
    will-change:transform,background-position;}
</style></head><body>
<div id="blz"></div>
<script>
  var el=document.getElementById('blz');
  var FRAMES=${FRAMES}, size=${size}, fps=${fps}, speed=${speed};
  var frame=0,lastF=0,x=20,dir=1,face=1,last=performance.now();
  function vw(){return window.innerWidth||1920;}
  function tick(now){
    var dt=(now-last)/1000; last=now;
    if(now-lastF>1000/fps){frame=(frame+1)%FRAMES;lastF=now;
      el.style.backgroundPositionX=(-frame*size)+'px';}
    x+=dir*speed*dt;
    var maxx=vw()-size-10;
    if(x>=maxx){x=maxx;dir=-1;face=-1;}
    if(x<=10){x=10;dir=1;face=1;}
    var bob=Math.sin(now/120)*3;
    el.style.transform='translate('+x+'px,'+bob+'px) scaleX('+face+')';
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
</script></body></html>`);
});


// The "cool fist pose" Blazeian, baked in so the homepage can show it without external hosting.
const FIST_JPG_B64 = "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";
app.get("/blaze-fist.jpg", (req, res) => {
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "public, max-age=86400");
  res.end(Buffer.from(FIST_JPG_B64, "base64"));
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
