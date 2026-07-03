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
    <label style="margin-top:14px;">🏃 Blazeian Runs — flitzt aus echten Frames über deinen Stream (+ Sprechblasen)</label>
    <input readonly onclick="this.select()" value="${esc(runUrl)}">
    <p class="hint">OBS → + → Browser → paste URL → Width <b>1920</b>, Height <b>1080</b>. He runs across, turns at the edges &amp; pops speech bubbles. Tune: <code>?size=160&amp;speed=120&amp;fps=12&amp;talk=0</code>.<br>
    🎨 <b>Farbe wählen:</b> häng <code>?theme=</code> an — <code>green</code> (GMC), <code>blue</code>, <code>cyan</code>, <code>purple</code>, <code>pink</code>, <code>red</code>, <code>gold</code>, oder <code>rgb</code> (Regenbogen 🌈). Beispiel: <code>…/run/NAME?theme=rgb</code></p>
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
  const size  = Math.max(70, Math.min(400, parseInt(req.query.size)  || 160));
  const speed = Math.max(30, Math.min(400, parseInt(req.query.speed) || 120));
  const fps   = Math.max(4,  Math.min(24,  parseInt(req.query.fps)   || 12));
  const talk  = req.query.talk === "0" ? false : true;
  const CELLS = 7, RUN = 6, IDLE = 6, CW = 200;
  const THEMES = { green:110, lime:90, blue:210, cyan:190, teal:170, purple:278, magenta:300, pink:325, red:2, orange:32, gold:45, yellow:55 };
  let hue = 110, rgb = false;
  const t = (req.query.theme || "").toLowerCase();
  if (t === "rgb") rgb = true;
  else if (THEMES[t] !== undefined) hue = THEMES[t];
  else if (req.query.hue !== undefined) hue = ((parseInt(req.query.hue) % 360) + 360) % 360;
  const msgs = [
    "gm! Blazeian_Bot_AI wishes you an epic stream 💚",
    "You like me? Come join my crew — I do way more than just run around 🔥",
    "Type !join in my channel and I hop into YOUR stream too 🤖",
    "I read chat, and celebrate every sub, follow & raid 💚",
    "Follow the streamer & drop a vote — spread the love 🔥",
    "Loyal to the last drop of oil 🛢️💚 — that's me!",
    "Need me? Just @ me in chat, I actually answer 👀",
    "24/7 online, never missing a moment of your stream 💪"
  ];
  res.set("Content-Type", "text/html");
  res.send(`<!doctype html><html><head><meta charset="utf-8">
<style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;font-family:system-ui,'Segoe UI',sans-serif;}
  #wrap{position:fixed;bottom:10px;left:0;width:${size}px;height:${size}px;will-change:transform;}
  #c{position:absolute;inset:0;filter:drop-shadow(0 6px 10px rgba(0,0,0,.45));}
  #bubble{position:absolute;left:50%;bottom:${size-4}px;transform:translateX(-28%);
    max-width:280px;min-width:70px;background:#fff;color:#141418;padding:9px 13px;border-radius:14px;
    font-size:15px;font-weight:600;line-height:1.25;box-shadow:0 4px 14px rgba(0,0,0,.4);
    opacity:0;transition:opacity .25s ease,transform .25s ease;pointer-events:none;text-align:center;}
  #bubble.show{opacity:1;transform:translateX(-28%) translateY(-5px);}
  #bubble:after{content:"";position:absolute;left:24px;bottom:-9px;border:9px solid transparent;border-top-color:#fff;border-bottom:0;}
</style></head><body>
<div id="wrap"><canvas id="c" width="${size}" height="${size}"></canvas><div id="bubble"></div></div>
<script>
  var size=${size},fps=${fps},speed=${speed},TALK=${talk},CELLS=${CELLS},RUN=${RUN},IDLE=${IDLE},CW=${CW};
  var HUE=${hue},RGB=${rgb},MSGS=${JSON.stringify(msgs)};
  var cv=document.getElementById('c'),ctx=cv.getContext('2d');
  var wrap=document.getElementById('wrap'),bub=document.getElementById('bubble');
  var STRIPW=CELLS*CW, STRIPH=CW;
  // offscreen base + themed strips
  var base=document.createElement('canvas');base.width=STRIPW;base.height=STRIPH;
  var bctx=base.getContext('2d');
  var themed=document.createElement('canvas');themed.width=STRIPW;themed.height=STRIPH;
  var tctx=themed.getContext('2d');
  var accentIdx=[],accS=[],accV=[],baseData=null,ready=false;
  function rgb2hsv(r,g,b){var mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;var h=0;
    if(d){if(mx===r)h=((g-b)/d)%6;else if(mx===g)h=(b-r)/d+2;else h=(r-g)/d+4;h*=60;if(h<0)h+=360;}
    return [h,mx?d/mx:0,mx/255];}
  function hsv2rgb(h,s,v){var c=v*s,x=c*(1-Math.abs((h/60)%2-1)),m=v-c,r=0,g=0,b=0;
    var i=Math.floor(h/60)%6;
    if(i===0){r=c;g=x;}else if(i===1){r=x;g=c;}else if(i===2){g=c;b=x;}
    else if(i===3){g=x;b=c;}else if(i===4){r=x;b=c;}else{r=c;b=x;}
    return [(r+m)*255,(g+m)*255,(b+m)*255];}
  function recolor(targetHue){
    if(!baseData)return;
    var out=tctx.createImageData(STRIPW,STRIPH);
    out.data.set(baseData.data);
    for(var k=0;k<accentIdx.length;k++){var p=accentIdx[k];
      var rgbv=hsv2rgb(targetHue,accS[k],accV[k]);
      out.data[p]=rgbv[0];out.data[p+1]=rgbv[1];out.data[p+2]=rgbv[2];}
    tctx.putImageData(out,0,0);
  }
  var img=new Image();
  img.onload=function(){
    bctx.drawImage(img,0,0,STRIPW,STRIPH);
    baseData=bctx.getImageData(0,0,STRIPW,STRIPH);
    var d=baseData.data;
    for(var i=0;i<d.length;i+=4){if(d[i+3]<30)continue;
      var hsv=rgb2hsv(d[i],d[i+1],d[i+2]);
      if(hsv[0]>70&&hsv[0]<175&&hsv[1]>0.22&&hsv[2]>0.14){accentIdx.push(i);accS.push(hsv[1]);accV.push(hsv[2]);}}
    recolor(RGB?0:HUE);
    ready=true;requestAnimationFrame(tick);
  };
  img.src='/blaze-run-strip.png';
  var frame=0,lastF=0,x=20,dir=1,face=1,last=performance.now(),lastHue=0;
  var mode='run',modeUntil=performance.now()+(6000+Math.random()*6000);
  function vw(){return window.innerWidth||1920;}
  function draw(fr){ctx.clearRect(0,0,size,size);ctx.save();
    if(face<0){ctx.translate(size,0);ctx.scale(-1,1);}
    ctx.drawImage(themed,fr*CW,0,CW,CW,0,0,size,size);ctx.restore();}
  function tick(now){
    if(!ready){requestAnimationFrame(tick);return;}
    var dt=(now-last)/1000;last=now;
    if(RGB && now-lastHue>90){lastHue=now;recolor((now/22)%360);}
    if(mode==='run'){
      if(now-lastF>1000/fps){frame=(frame+1)%RUN;lastF=now;}
      x+=dir*speed*dt;var maxx=vw()-size-10;
      if(x>=maxx){x=maxx;dir=-1;face=-1;}
      if(x<=10){x=10;dir=1;face=1;}
      draw(frame);
      wrap.style.transform='translate('+x+'px,'+(Math.sin(now/120)*3)+'px)';
      if(now>=modeUntil){
        if(TALK){mode='talk';modeUntil=now+4600;face=1;draw(IDLE);
          wrap.style.transform='translate('+x+'px,0px)';
          bub.textContent=MSGS[Math.floor(Math.random()*MSGS.length)];bub.classList.add('show');}
        else{modeUntil=now+(6000+Math.random()*6000);}
      }
    }else{
      draw(IDLE);
      if(now>=modeUntil){bub.classList.remove('show');mode='run';lastF=now;modeUntil=now+(9000+Math.random()*7000);}
    }
    requestAnimationFrame(tick);
  }
</script></body></html>`);
});

// The "cool fist pose" Blazeian, baked in so the homepage can show it without external hosting.
const FIST_JPG_B64 = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAkGBwgHBgkIBwgKCgkLDRYPDQwMDRsUFRAWIB0iIiAdHx8kKDQsJCYxJx8fLT0tMTU3Ojo6Iys/RD84QzQ5Ojf/2wBDAQoKCg0MDRoPDxo3JR8lNzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzf/wAARCADIAMgDASIAAhEBAxEB/8QAGwAAAgMBAQEAAAAAAAAAAAAAAAUDBAYCAQf/xABEEAACAQMCAwYDBAcGBQQDAAABAgMABBEFIRIxQQYTUWFxgSKRoRQyUrEHIzNCYsHRFSRygqLwQ5KywuEWU2Nzk9Lx/8QAGgEAAgMBAQAAAAAAAAAAAAAAAAQCAwUBBv/EADMRAAIBAgQDBAoCAwEAAAAAAAECAAMRBBIhMUFR8BNhccEFIjKBkaGx0eHxFCMVM0JS/9oADAMBAAIRAxEAPwD4fXteUUQnteUUUQhRRXoGTRCeV6FJq/aabJMokYrHFn9o/I+g5n2rR6P2aubxlOm6f3wzvc3WyD0Xl8+L0petiqdIXYytqirvMtbWFzcKzwwu6KMswHwj1PKu/sDZwzoD4L8X/ivq8fY3TraNbjXdTeZUG6cYjjXyH/jFQ3up9l9OAh0q1BmZTwTRIAB6u5Hh41mf5fO1qSlvAafE/aUnEE+yJ85j0S4kUdza3cueREeB+VW4eymoOCTaBOv6yZV/M1pjq7vFJdP9naJGClnuGlIz4hAMfOl03aZSxXiXhB5Jaj/uc1MYnFPoo8/pOdpUO0Vjsvfj71vbDwzcp/8AtUc3Zq/UZFmGH/xzq38zTxe09sNPKGJjP3meMwR5C45Yx1P5VW/9QocAheEn9+1H/a4rq1sXfUD5wD1Ign0e4hGZba4i8S8Zx86qx2bSnCSR5/ibh/PatZFrKK3GgiHiIpniP+oEfWrz3em3kYa5iUHG7XEOV/8AyR5+uKs/l1k9pevCS7VhwmCntJ7feWNlB5HGx9DyqHBrezaJAI+/sZ5LaNjsysJ4G9SP55pHqWm90pNzaqo6XVmcxn/EvT/T6VdSxqPp114EyxaoMztFWrmyeAB8q8Z5OhyP/B9aqkYpwEEXEsBvCiiiuzsKKKKIQor2iiE8or2vKIQoFFXdOsxdSlOLhPDlds5ORtXGYKLmcJtK8MEk0ixxqzMxwABkk1ptH7OSTzCJIu/uM4K5yieZI5/l6017NaN3xaK2KooOJ7o74B/dX/e/pWsS9stEs3tdPSPvQMu7HCoOjOfyHM9BWLjPSLA9nSGvW8VqVjss5tuzGlaVYre6zcIz7DL8s+Cr1Plj2qlr3ax4oxHaAWkQGBxqGlI8k5L/AJj7VnNR1nvS8kUzy3Gcd8/MA8+Afuj6nqazM0ziQMw4uZwfGlsP6Pao2eubnrh14StUzbxtd6rLqLlChZ2GO8lPePjyzsPYDnSa5WSOZ4ZGZmhYx7sWxjbA8s087MxxNw3FxlSZlZfh2KR/GwJ6ZIUD0NJ7j4tSuA7EIJjxyFSeEZ5kCtikqICqjaNCmQu0e9kRFcQajaXlxBbwS2zIHmAwJCQVJPPYikU9nNbozMAMbfEQC3mAd8eeK5upRBcBbVWSWM/C/Hls9DtsPb61TdpHyZWPFnfO5NSp0SHL30NtJ1aVibydLjuuEthgG+6CP5iupHhEmBxrjcYOf5VCiDIJ+LyNddwhI2386YyC97SYUSRzEkbfHJxkfCuM5/Kp7eGRI2kinWKVAeNCxRhjmPX3q92Z046prSCSNeC3HeSEHY/hHz/Knn6QdEFt2guLq0RTDdJ36kbrucNj33/zClmqp2nZHe1/xIEpnyzM22qTxTd6ryRuduOP9WzevRvcGn2m6sBdLMypOD+0VF4Gx1yg2I/w/KslcNMBjHwkeOaLO4eOYSI/AQMDw965VwiVBpOPSvN3caFp+rxSXehXCQPnDQN91vLH9PkKyOqaU8F61s8f2e5X70L8vY1bsLyW3nPeStBMcP3ucg+BIHMeY3rRX+rWOq2gGuIomgQsHUgl1/FG373p/sJK1bDvb2l+f5lIzIZ88eNlYgggjYjwrg1p76zQW8codZYZx+puSuOID91vAj5jzFZ25gaGZo2wSp3xWnSrCpGFfNIqKK9q6ThRXlFEIUUV0q5NEJ1FG0jhEBZicADrWx7MaDJeXJgUhY0x38w3A8h/vp4Uo0axmluYYrVeKebZP4fE/nX0qVLXRtGTTbORQzoWmkI3x+85Hh0A67DxrH9I4spamm56vFa1TgJHc3dpZwGz04rFDCPjlAzw/wBWPT5nasXq2qQzEW8WUhBzw5yWPUk9SfGo9U1SN17m24lhQnGTknPNj4k0l2kuAwXYkbDNQwmDCes0glPiY3srFriYCP8AZg7t5c661PThDPMZmUZcmLhXAKZO5HTyFS6ddTwyiK0fhQrlwQPixv1+laHtbDE0CzvFwpBGhnRcAsMjIB9KHrOlZVOxkcxzWmTks+O1n4pWLWlkG4WbZC7ghQPRs+uaTxtPdZjVs8RLEscDPnVvU76b7RdJcKQXmcnGAPDGwH++lKwSyhOQ5keJrVQHLeaC2G+0urZFLZLjvQS52UoykjP3gSMEZHSrlrax6nEkEIK6ivEyknIuPBfJuePHlzp92H1K0ltJdG1iFJ7Hi4sODmIn95SNx54q/rPZF9MgXVNHl+22C4kSSPDPFjfLAfeA8R7gUq+IAc02Nm4d/XKVtVF7WtMK8TQ3Hdu6uNhleRqcqI04+BX4SCVbkRQYCJu92KNnBHIHypz2c0Ztb13T9NVuJJ5czYB+BF3Y/IU7mAGskWF7iaLRbIaJ2HlvZh3dzfBnBPNVI2+S5P8AmFXbmEaz+jy3uYvjl01grkf+0wx8vu/8tRfpYuRNdxaZpqnhLd1HGgzsDvj3wParX6H7uGSG70i73jnRreRT5gkfzFZCKf8Aax3b8fiLDfMec+a3tqYHeNuEspIxnIz5eNVYomRH4zwqRsOH73iKfdorNrC9lik/aRSNC+3Ig4+vOlNpbS3kg7tQvMkscDFaauCmYmNI+kujSH/sYXmC1vIpMYiw7JKDjhODsDSydpY4JIJEwvHkoy47ts748D0rZ6H2S1rWrNUtnW3sYn7z7XJlVQjOSvVjg7+g5Vm+1UcFpqcyWU01ykREclxOwLyyEZJI6D+nPNLUqmZypIPH7TjlGYZY206aC1iWw1Ru8s7pFkPiu2OJf4hjPmDiqOu6I9jL3MrCRWTit50+7IvTHl+RryWX7ZotrcMEIt5VhlC+DIOH3BjO/nTTTLuHUtN/sm5cYyTaSucd0/4T/C30NUOWpuai89R5/fmJRUBRrzCyLwmuaZ6laPE0vfKUmjbhdCNwfOlpGK1UYMLiXqbieUUUVKdhVuzg72ULyHMnwFVkGTWq7PaPJey2sEanvLhuNjj7sY2+u59hVFeqKSFjIO2UTX9itJOm2MmrXEYHeoeHxjjHh68vbzpP2ruu+unigZldsGXp6L6L+ea13aDVrWxSKxfbulU8K8s/uA+mM+wrAXUnfXBlXAJPMjNedwmerVNdxvt4cIitycxiKSERxB5GHE2Qqg5Ix4jp5UW3DGm7EMTtUskPFcupbIBI32Jq7DZKAndHiLAhgR9K22qALrLy1hrGXZuxF3f264Awc77g4338KdduplTUHjmjDLFbK0acXDxliQW9jhfLJ5ZzVjs7BbWUK3V4wgt1+JmfbhPLB6nNJu3F4l3LcyyJNE7KIrISxMgMQwzHmCGLcgRyXzrIRjWxgPAddd0jQDNVuJi7kz3kkTmcyySkseI44WJJPP5586lvrWNIIbu0y0TjglB5xyDmPQ8x5elUXV+P4lwMZA8qvC5nNpKkTKBKoFwgH3xnKsR49M8/nW+wIIKx22YXG4+khsbswXYl4jjGCc9DWqse0l9ot6l7Zvw21xvJGfucfJsjp45HiKyNwVcJwqoKj4lAwKe9nVTUrSXTXI45ATHn8YH8x+QqjFIhXMw04+Eoqr/0ZtZdN0ftXC9zopjs9TxxS2jnEcviRjl6j3A50t7P6l/6e1XUHvIJbe/CCCKFhngGBjfwJA3HSsVYT3mmX5jj7zvoXPwoSGUjmQa2c2vWHbG1jt9ccR30ahIb5QFI8A/h+XpzpSrSZFykll+YHn9fGVspAtwnWn3EuoXw1zS5RcalYOT9jYZLIv7y+Jzk/wC9+4jN2Zn/ALavzHBfahIXisM4ZQcsGI6b/n8spe6fqvZLUY5G41AcNFPGcBvMHofKptO03V+2eoyT8bsxbMlzKfhT1PU+Q+lBpJkzFx2fPy+Pv4Qyi2+k0naNoNX1yK6siZzfxKRFGpLd4NsY9Mb+RpxYdnNK7M2633aZ1kk+9HYIcj/N4/l5nlSsa3pfY2zNtpXBe35BRryQcXD5J4+g29ax8l9f9otUVJ5JH708Tljkkef9KhTSq66GyDidyB9OtoLcjum11jt/d6jA85AtdPj+C3todgwHMnx6Dw35V8/u5ku7SLjtiLgl375TvIS2d/Ec+VW9beGSdLSEkwQrwDhIGTvv7tk+mKitkS1/vNy4MsQDxxE5VsE88dMjltnNN0aaoucDU9fuMUVNiecktYxL2ck5BoLlWxnfBGD9SteaaQkrYPE3CcL+LHT1xmo9PM4k1KNgDmFy69TkjHlscN7GoSGhuI2BKsCCreG9TIuWHP7SFQCaXWlGp6dHqSqXmQCO7x1HJW9xt6jzrHXcJhlZMgjmCOo6GtjpN1HHdqkgH2G9jKygclDHDD/KwyPalXaDTTZrLA65ntJOBiOqnkf9/iqnC1Ozbsjtw67jp8JXTbKcszlFB50VpxmT2sTTTRxp952Cj1NfVewCQxx6hqRGIosQxk9EUb/TFfM9I+GZ5RziQkep2H5/SvoCRCz7KW0CSFJJgFlGMEBvjc/8ikVjelfXUU+dh5mK4g30ivtNdNfXysylWk/WEcyC3Iew4R7VVji4YV42YMx5qOQwdqk+1RagRPxcNwXGRywSelNwqrevG0PGqHHCxwPSqc3ZIEttKb2FplJDJ9tZHHeMhKZU/exsDmpoInM6JKu3gTgAnYH2ptqwt4NdaO0gMKxsoYjYsw5n61ev9Glkvo5YWylwvejiGCOI8jVhxK2W+lxOl9p12l1OO1mtHuLt1FkqFo7dsSTSMMkq3JeEcPxfxbVj9bhnmuJ7mOWSeFwLlZXO5VtxnzzkHzFS653VxfXQlkci3jkxjcM/HwgemAPlTLQH0qTQ2bV1mcW8IRO4YKclnIBJB2+L6CrcOgoIpHh8evn3RpEKKJnLh4pbG1RYyJ4ndXc8mUnK/LJqKx/u94VkB4SjhgB0KmmCzWq6LKptFa5EiOk5c7L8Pw8PLod/Oq15eh72N0gS1jK8LpFk7ZOeZJ61o5fUIEZFhUEp8OcNU+m3EljfRyxkoysGVvAjcVKbJBb3rNKv93UcJVgRIxYDY9diT7VVnh7olZSS/AG50MyuCshkLAjlNf25twJNO7T6aGjhvABIUOO7lUbjPjsflVHUdOkuNMHaGxkiYKwS6WNQpRiNjwjbB/PNX+zOuayun/2fpwt3iZ+MxXPBjjxuRxEY2rRqvbSGPjTQLcq4wzwW8LBx5kNvWUGajZLj1eJPDkfvFLkacpl+znauMRjT9ZtlvNPbZrdzyH8B6enyxUet9q2ZDp+lQra2S/CsKdR/ERz9B9al7Q6Jr2qTLM/ZyaGcbM0UIQP5nB3NS6HpOtaZGHg7KzXNwN2ee0MoX/DvtUwMObOAC3K4359C87Zd7Sk0Fx2dslv9QhiOoXSZiWUZaBdxxAcgT5jbB5V1okEemdnrnVJdp7n9Vb56L1b5Z+laKW97QXLO972NiuJurTaeSfLmeVZLtHqlzqN3HbXlrHY938P2eBMKo64GTg7AY8q5TzVfVNr31seA4AcpwBm0ii1+Ofjcc8k7/dHLNeu6rcnhw3EMEuMg77be1dxs9uzQNbA959wsSGAz0wcZ9c1LMLIiOSzDpKG4WgkYZDdCGwMj5VpFhyjlmU2ItLMTQia4lguApnygU7fDxcOPUjf0JqfTtON7eiKU5jAaQg7D4QTz9qr2F7YkySX6tJdTOcsu+FKOD78RXHpXdyWtJljLFZWA4skjGdv5mlXDDQaGUVhYi0t3V3C6SQWw4Fgy2wGGGcPj2wf8tMddj+16Xp+pnfvkNrOf4l5H3GPlWWiZbe4HHkgHDDPTkfpmtdYKJuymq6bKcyWxWZPVTwkj2pauopFGHP66HyMXYZbET59MpR2U81ODRVjUlxclvxAN/WittTcAxwG4l3RIO9Pd75lmRB9f6itt2lulRWCAgJE5G/LiKoPpx1l+ypX+0dOVtwbkMR44x/Sr2uzs5uGCFYi8a7b4H6xsfUVkYlc+JF+H6ilQXeIYMSyvhtsgBQdyScU+0039nqETsGZpGCtG3/EX1O3lmkdpbd/cgKCcnbArcahaWmlaTpz6iZ47nDHuhGSSmdm6AepIqWKqKpCb34Qe5NgLx1caSNStPtzQMLpQjEk4ygH1PKnWnWMk8dobhAHiAHLpjas3fdvH06BYxpqcfDwccs+ePzwgI+RrjTv0mxtCiz6YkcgYhiJ+FcdCMj88VgVMJjmTRNOGo2+MqOHqWuRMNqfe2V5cLG4x3/ePxDkeJ1PtzqnFM0MEyMVEd0O8UAZJAY8/DcUw7TxT6hqhns4JAl1M3cKQP1gY8WAwJU4YsNj4Uo1FGhlaFnV/s6iHKcsjOfXcnevT0LMq336848p0sZEF4bVxlgSVKrkcsbk+XKve9SN2DxiQMjKATjhPj7V1Ndf3SOARgYx8Y5kbbfSuLZoXuR9oLCMA5Kjfy+uKaF8pzS64zArGFnpiPd20TM570EqOhHrWwbsna3CmSdmZw3FnOyjA235ClnZERXiSN3KrwvwInETwrnIG/nVTttrM1zdPplpIRaQNwycJ/auOZPkDsPnWTVNariOyRrW3M2ENChhu0Zb5thOdUtNMiaRYdbgDk7iMsQfXAIqO1k1KygZ9L1BmiHMwTMvz4T+YpNbWDXMqxIw425CtHrfYrXex1vBqN+ogEhHdsjBt8ZIbwPkacFPKts1z3iZTV6NRiXT4SGHWtWZx9p1LUod/viV3UfI5qR+0upx5aPV9RkydmEjIpPqSPyrUdmtN0jtRpkd73BguUJjmWNvhDeIB5AitBa9iNDwovoXukUg8DOVB/wCXB+tZb+kMPTqZai2I306+sbPotWXOpuOE+YvqOuaoSpv7hlJ4GVrl39Rimdh2b1W0v7UtZSTJdDgeYjeEcsnoMDffma0nbLVNK7IoseiWFrFqE4LLEqZWFOXEc8874HlXz1JO0PaG6BE95dTu3wojEnPgFHL2pik1TELmQBUPPc9eMiRh8LYf9fTum+7S9kGvVspbS57l7VOFndcsw58W371YC4tbO4ksGtu8jiml7ol8A7EZOeXX25dK0XZjtHqmi6nHpevmVraRghW4zxwk8mGd8eIq/wDpG0+2lhTE0cckKM6RBcFvxH8vkapoPWw1VaFQ3B2I9/n8I3UFPFUmq0xY8fLrjMdYww/bktHjAklkIjmYbI2MD/Vipe0E017ci84XjIUfA4wU2zj65881zpFtDfXVvb3F+qyNMkccjfs0Qgk5PTBx0rrVYZ4rbT3mQ/rbbAOD8QViA3mOEr8q1mQZwx3mFUXQHiIoQl5Mt1Oa2mgsTO4J+G4tMt/y4P1Q1jkj+IN0PKtfogMK2Mj7BllTc7YBB/76Wx1smnXHyi9XaZPVUwsZPNSyn/fzoqbWl3lx+7Mf50U9RN0EYpm6yz2dybmzdcBkdjkimN/KhtTasjGZpUIIbbh4SOWN6V6GCJbaQchMQfp/Wm0N1GmrwSuyIIcSSO44giqck46nlgdSRWfXH9pPKUMpZ9JzrWk3nZeGF5S0c8oEgH4htlRjcY6nbGQBSqa71DXZgZpWcImI4g2yqOSqCenhzPnU/aC91LUpJLrUS4USE92x+5xkkA+GwG3lSWAzPOos1PHkY4fX6VfhqbdmHqWz84yqqI2itrKBeKRxx9Q7Y+Q69ak1i40ua8T7CqxqqL8UWR8WN8++Rt4UmihaVpnmmjjaPmrc2OeQA510kXwO4jduEguSgwo5DfPU0wF1uT0YKNd5oY+0s9ravYcMN/Y4ZliljAALD7zcOMkbe42xSm90+CV4p9NctBKoyjsAYpMZKEnn5Hr6iqcNpNdSfqQgPQGRVz8zXc1vcQ3b2Qil4pcKqOvCW/CcVWKSU29Q2PH72lmYvoZzqUtw0yQ3QcGCMRqrrwkKOQx71DbJxuuQeEtgnO2elMbaWD7O8GpI0qgBVfiPHBvuV8fQ7VBNanT5zFc/EMB42T7siEbMD4EVYGsMltfrBAM02vZXuBHEbRkYhh9wY3Hj475rIaRfG3e+aVEZ5bd1DyZ+Ancn35e9OuyA+xzGYSmQ5HCOgAJP9aU6xp/2PW5oHVlt2YvESuMxkkg/y9qQpKorVEOt7fKO48F8OjEW3i2yuBDeJO6khXDFQxGRnkD0rcdtP0i3nbLSUsrm3igihk41CZJY4wCSfImstdaBPFIvczQzRuAQ8b5AyM4PpXF5arZ8VqHRpFJDspyB47+FOdpTcgqZlFlO0236IZmV9RhGeAhG99xX09CMbmsN+jTSWsNHe7mUq92wZQeYQbD5862gyRg8jtXjPSrrUxblZ6vCoy4dQd7T4lqt3b65rOtajd3IjZWLQJjPEoYKAPILvVn9HPa5Oy+vi+u07yBY3HAi/ExIwAD09TWcltJvtVzbRxkyxuwcY32Ne2Wm3ErMzwuqRn4yVIxXskVES19Ba3dPLufWLMY77d68naHtJdalHAIFmIZUzkjGAMnx2rR9t0t5ILAqry6jJa8EaL+EruxHlk/Osvoek/2prENvGuY3cZbHJFOWb+VMu30scfaaCXvZESKMBOEZIK7jHvgZ9fCkqpV8TTUHUAmaOEzJhKlS25H7mXKyw3kwcKhiZshdhkbYGKc6tciTTNIhLMxhtiME/dBcjH+nPvSaJLgxovAQ1xsrMMZGTk58M53qzNeFzKoIdWRYlZ1BIReWPDl9adqAsw7v1MxzecMiC2BXHGT+Lp6VrrBre4tdNhitpVkLyBi0uVP7PPIen1rGxxSOYjGpI6nGBzr6BotsOCwIHxKsjn3IH/bSOOYKoJ7/AKGL1NN5itcHA92o6TfLnRXmunLXTYODclc+maK0cP8A6xGKfszzRJykUgb9yRXH1H9KYFTDcX1+gjbu+FVSQZB4iTy67L9aV6Eolmkh6yxMF/xD4h9Rj3qzcysthdFW4i8cW3h8TAn6fWl6q/2Ec7eX5kbkVLiVftx1D+7Xr4Mtx3st02WYA88jr4//ANqjEDG7FJNgccS7EipLGLvrhiylkRSzKvNugHuSB71bl0t4Gge6KRRu2GKyKWUZ32BJBpi6IcvylyoTtIpFgjiiMLHiIPek+OT19MU47P2tgeGbUpuIS5RbZQAzBgRxl22QA7g7nbliq8naa5fT2sY5Ps9sSQtvGiCMJjG4xkt/ETmk7XMzOCZMtgDiPgKjlqVEKtp79fp1zkrjeNrp7OznP2bjco+AkwDA+JyNiK8vtca6tYIZcu0YZX4zxKRnbhGPgxvypbeQsF7yJ3liwoLlSMMQCR7HNXdEt4p2+z3MscVvLjvJWUkoBvtjqcY96kaae02toZjbSeQmLTdVWR0a4jXgmjEh4eJTht/PBx4c6nv2l1HT5Z2m7xrecCMEBWEb53wNgMhfdj40v1OAW0kLJxcEkKsnE3FyyD7ZB2qXTykkN0DM4c27/BjYkEMN/Yn2FRKiwfiOjOglhaeRSHTj3kfC0uOEMpIMbbHI6Ecx4c621gbTtHYhdQTgKDiimjYcce3xc9ivkdj5GvnKOxIXjIAPEMnbNXMlrf4WBXGSqSct9yR/vxqvEYftADezDjGqFcJcFbqeE2B7A3k8pNtqFq0XQurofkMimujdg7W1nWXU5xdupyIkUrH753akXZ/tcumQ9xPG7RceYgjk8O2OHck45866i7VXli89vp4nZ5JXkd7scbKeoCjkABWbVp+kGJphtOegv7+EbpjAJaoB7t7e6avXO2MOg35s59PmfCK0TowCsOvpiu9K7c2ur30djbWN130h3KYZUXqxO2w9K+e61r9xrXdpqMluAmwkSDBA8eeatdlO0Q0GR+4tbaeNxh5TxI7AeZz18qi3ohBh75L1PHSH+QLVvbsnhNP2q7I3Q1FtY0NeKZzxywqQrBx+8ueeeo8aQx6P2o1N2imtbmNHbik78iFG82Od/atNqna3vtBjudInt0u5OEuJHH6oHnz5kVnL/tdqeptKmnlo0jVVzHEDx9CTncZOMAVDCfzCgBUaaXO4t1pIYrD4PtO0YnXXTjHdybDs7pF5bw3kQ1Rrf4pgOEL+FU8PHxPOvnqBL0RRSFYZFY97LIcAKBgbcyeZPUk01vLy5E8eqX7KzsDHFbgYAZefEDk8I29TtyBpPb3dybxXidAzMcs/I558XrWhhaLIpN7k8e/l7onjK6uQlMWVdp6+zFVYmMfCnEN+H+WfCopV3yvy8aZtarJp6XUSDg4cN8fFwsMZ9OY8efOqUCFn4iCV8emfCmlcanlM+5vGts8NsY7Zmy2BzXGc1u9Ptvs6SXJ4RHbwAc/BSx+r/SsRZWwub4SXDDn8R8FA3PyFajV797LspMp+F7kKOHwMhLH/AE4FZGMBdlRdzv74s4uQJgdYl47W3/8Akd5D9B/I0VHrhCXgtxyt41jP+LGW/wBRaityiLII8gsJWs52t5klj+8jBh6ir+pxgTyGIExjDqPFG3H8vcUqQ4YU5RluNPUneS3+FvOMnb5N/wBQqNUWYN1195F9DeGhTQwx6m5IMhtgsRIGFYuvxexxS3v5pLZItzEhIQcX3SdzgVYVkt3kLpxRyRsjY5jI2PsQDVrTmtoNZDSLG8EqkK0iDCh1wGxy2J+lRBClmtfj8BLF9YShYKDJktgEEPlc7HnirGs2iWesXMVsD9nViY+IjPB0J9iKrKEQ4DfErcvLofzq3qs0LzrLbySyxBQitKPi4eEAjw25fKrSTm07/KcvL3x3umxW084ENvxuB4AjJx4n4aV6ZcxRzI9yGaIMvGqnBK8jjzxXMd0DA6SSFfh+HhTOT5nNVFYRyEg8uRoCWuJ3hLl9J3zxjibhQkYI+6Dv/M145SyNzHBMJeMd2jgc1PM+RwAPc1EjyXE3NmbcsSedWtSZpobe5ZAQuYGcHdiu4z54YD2rhFiBw6M6BpKDpiFHGN8ggeVdESWkhV0OHXkduJT1FNNP0xbvTOIMBcKzvw5wXjHCCQeuDnb18KqTWmGUMzYxgZ5KfDyoVwxtJsMtj4Sv30SkFYST/G2cHyx/OrizwCANGER3Dcafeznl6D61XuLFoA3eMQytgoRuKi7luJR3bbjIztkeNBCnjAVCOUt28L3U6wxRO8kmAnDtv5+VeXBFtAsSKxGW7xyvDxcsAE7kbZ96J7O+s1jz3kayqSpD7EA46efjVZYWkchmJAPxPuQo8a4PWN76QFgLcZZhkiitlmFyRMuRHEqb56knoPr5Uw0m/nFncQWiorMuWK7uqDmV88ZBOfuk+dLJIYv7P78KcibhB6NtuPLp8zVyxuJNM7rULaQ5kVlbhUfAc4PpkY9cnzquooZSNz385wtl7pU1CPuirBVCkchUMIWQKqcTzOwCxjYe5q92hWMXwks1K2kqd7Cp6KScj2IIqgjIGV2Bz+9wVZTJKAylRYWMeaBbzvIYHThib4HGM93lwCzeAH1+tTa2sVgosbdg5iJ4nHV9s/lUHZiL7ZrMSrORGN3Dc+DBJxjyB386n1OzaTUWQEAux+ENnr40k5AxFieF5TUIzi867NWffzcUrsI3z3m//DXdz8sL/mpt2quuO/toJQOC2jN1cKOjHcL8uEe9XdGt4rPTDdTgdx3fG3/0qcj/AJ3+gFY7Wrp3heeU/wB4v5DK4/DGDsPc59lFL0/78QW4DTr3eUggzveJZnaWRpHOXdizHxJormitvaOTzrV/TrruZgWXiQgq6/iU7EVQr1WIO1cZQwsZwi8cXNv3Upi4uIYyjfjU8jULQSy25jQBpYPiVAPjKdQPHB3x51NayG8gS3GPtEWWt2PM9SnvzHn60Tq8qJcxkqy8ypwVNKXKmx36+srBKmKyOObAAUnYjfapZoLtGEMkUwwOIKVOMeI8vOr0t5cTpiSZmLDDEqOJvVsZPua8DM6hDJIY+QjLnh+XKre0blJZxFpZsKpQA45+IrtrUDgLyBQx3ODt7U2uVsiimWFkDxBhJbqCY2XY5U42Ix1qjeyWAUC3S5eXYl5SqrjyUZ+eaEq5thOqQReT6b3tvdyx6VxTzfEqOsfxFSMZA3x136VFq0y4hsYGUxwDLsnJ5T94+fRR5L51DJfyyQdxFHFBGSCwiXBfHLiPM1WXZgfOuhCXzGTJ4S9C0jhEkz+rXCkcsc/60606O3is5729QOgPdQRN92R+ZJ8gME+ZApPAyGAYb9Zn6Vc1mVhZ6daqpJ+zhhjfLOxJP5D2qupqQo0vK2JJnGk2tvqFw8N1JLgqRAExlm6A55DxY8hvV7TorA3UGnRslyvecD3UpZYtyM8KrgsNhux9hVUS93pt9P8AZVguOJbf4QQF4ixbY8vhTh9zWhe30y3voptNt+F+MSKGYlY3MYZQfBNy+f4SOlL1q1m1B/QHH3/W/CRZp72wtdO0PUxYidmj4QEnTiwmQDkoSfhyehBpZPp062tslvm5eZnWaFBwrHKBxAg8iCmGB671au9Jg1TgS4u2hFsGR5z8QIV3fOebHgII+uKjsp54rXTZIJsRjuz3bsAzETFVIHU8KgHyqpavqi2/fe3G36vOAi0Tw6fINK1FishRI1k4h9376j+Z+VUtGuzZ3kMxJKJKjOh3DgHkQdj150zfU+6s9WtFk4IZgVVR++Q64+QBNUNPs4JSZLjjES5YhGB4+Hdh5HB2PiKbUkq3aDQ/YS9Lm15JqzqDCiiHugpdBHnZWYsAc9QCPYilwid5UWJCWY4VeROeVbLS7WN5QsKpJAMlwBhWXHMgeIIpVNZm3nmZlCBRhGjHXw8ts1XSxAHqCUGoMxFoaXJPp+SuFlY74xsDsR7030bTFubgvcOUQpmUjpH1x/E33R5ZNLdJ064vpkKIZCWwiDm58PIdSegrRazOmh6eLRR3k7MDI3D+3lxsAPwjb6ClMQ5L5E9o9dfuUOSTpvKvaK5ErGxZjEhxPdleUUS/dQegx7law+oXTXd08zKFB2VByRQMAD0AAq7q1w0Qa1aQyXEj95dyZ5v+H0HXz9BSnnT+DoCmnXX4tGaaZRCiiinJZCiva8ohJoZOEjBwelOUmNwPtca8UsYzcQg471erjz8fn44Q7Y86sWc8kMyujlGXdSOhqqpTzDvkWF41u7eOWFJbTHdsco+MHP4W8/8AY2qrKjxQcciEA7Y8/CmMLhwbjT0TvT+3sukgG/Eg8PIbjptysTm21K372zlKPjdDuyeTDqPAj6UoKjIbEaSnUb7TNzlw/CkpcBcZxjIxvtUJf9XwsuSDs3gPCmtzppU/q1Ikx+zY5J81P7w+vlSpl3bizt+dNoysNJapBnmc8gamhlePfu43GMEOudv5VCM+FdiUDmMfWpkX0k7kG4nferxkoCo8DuallnlmSBtw0C4RgdyMkj5ZNU/3g2MDNXLWeCORTcI7xcmRGwT6HBrjAb2vItzjBZGksbq2u3UTXIS6hZj99hnYnxIZvcYq9C9rdWqiO5Zbg2qwXSG6EBKrtghkwcYHXpWfurhpJeNIxDGPuRoThB5ZPvTq11e0uLJ5NUWK5u1YBFltuJmXxMgIPzzSdamQAwHw685Aiwli4ZJbdbOzvWuJZYxHLJJMHS1gTBxkADBwM/4cb5qpNfRd+r2yZgtV4YST8TYXC5HIfFlvnVe4vRexMgkitYEIPcQxBePbmABv6sapacMzhYmQPsVDjIJyOn+xtRTo2U5ur/j4QC3nryJFYLbhlZ5ZBJIfwgZAH1J+Verc9yP1JK46npXOqWn2W6YKWdM7MRzqvCneSAYJyeQ5mmVClb85PMCLiPtH1KS1d4oJ+G1KgPKYM8WOWBt0898c6nkhmv5QIyZO+bKiPcyHJAAXx2PPlRYaJcXhIgToOMk4WP8AxHp6c60UUlh2XsHMZMtyw4TPj4m/hQdBn/zvtWZWqorf1i7HrWUVHUm4Gpl1I17MaMWlx9raP9Y6b92n4V8/E+9YzWdUm70Xd0SL50C28ec/ZY+h/wAR6eufCpdS1O7EzXl4GN4Bwx2/NLZT1fz/AIT6nwrN3kommZ+J3LHLO5yznqTUsHhDcu+pO58vD6+G8qVOxud5CTmvKKK15fCiiiiEKKKKIQr2vKKISaKZkdWViGU5DA4IptBex3EyzOwt71R8M67I5/jA5HzHPqOtI66VyKg9MPvOEXmjnnS4kWK/QW8pGQzbxv4EEcvUbelFzaEkG5TvEO4JbDHwIcbN759aSwXkkSd2eGSHOTFIMr7eB8xV+0vhCrC0nMStu1vcfFGx8jy+YHrSjUWT2evMdayooRtK1zZxLOiwSkhz92Ud2V988PvmoLu0uYCO/gdAeTEbN6Hkacme3kVUvLZ7UPuHUccZ8wD/ACJq1Baw900VlcqwcYZYpinEPNG5/Ku/yGS2br37QzkbzL4LLwMcKNxmo+EZwPY1o57FUwstuAQf+JEyZ9wcfSoP7NiLq0fDueSzbD5qKsGIW06Kgi22SV2VRKoxyEnKuriaUEqe53OSUXFO49EcoZigZDheIXkO22wO/OuF0BAwdu5C9e8uw3/Qpqv+TSJvf6SPaLxiGBTJMvEC2enLPrUscE7XHDbpIZP4M5+lbDS9AtnUOb23VQ+/dWzO3+s/yphNH2Zsvimd7p+bC4k+HP8A9aYHzqh/SC5rKpPukTWF9JnbLRptTCRAvPcAbpbjvGHqfuj3Naa07IW9lD3uqTpAIwT9ngcFyP45Og9MV5N2z4Yu60Kx7uBduIgRRgefT6is1qPaBpS32q5NyWG8MHwoPItjf2HvSlsZXNvZHz/HWsrAqNtpG9/r0RhNloUScEe+EHDFGOrMx/M/WszcamttJx28xuL0/eumHwp5Rg9f4j7Ac6XXV9LcKI8LHCu6wxjCjz8z5nJqrWlQwaUxr+/Hr4xhKYWdSOzszEk5OTk5yfE1zRRTsthRRRRCe0V5RRCFFFFEIUUUUQhmiiiiEM0cVFFEJJHPJEcxuy+QO1SG74/2kUbHxA4T9NqKKiVBnLCSw6jLCMQyzxjwWQ4qwmu3iLgXBYeEkat+YNFFQNGmdxOFFM7HaG9ClRLGFOCR3CdM/wAPma5bXb0jAumAP4EVfyFFFc/j0v8AyPhOdmvKVpNQml/bTTyDwaQ4rmO+aFuKGKJT0LLx/wDVkUUVPs1ta07lEiuLua4binldz/EeXp4VCTmiipAAaCShmiiiuwhmiiiiEM0UUUQhRRRRCf/Z";
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
