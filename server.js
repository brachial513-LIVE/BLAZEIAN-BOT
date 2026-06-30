const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true, limit: "1mb" }));
const PORT = process.env.PORT || 3000;
const BOT_CHANNEL_ID = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_USER_ID    = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_NAME       = "blazeian_bot";
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
    console.log("Loaded channels:", Object.keys(data).length);
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
    "💬 Ask me anything: @blazeian_bot weather in [city]",
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
async function followChannel(channelId) {
  if (!SESSION_TOKEN || !SESSION_VISITOR_ID) {
    console.log(`Follow skipped (${channelId}): no session token set — use /admin/setsession`);
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
    if (e.response?.status === 401) {
      console.log(`⚠️ Follow got 401 — the session token expired. Re-set it via /admin/setsession.`);
    }
    console.log(`Follow attempt failed (${channelId}): [${e.response?.status}] ${m}`);
    return false;
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
const BOT_PERSONA = `You are BlazeianBot, a beloved chat bot living inside Blaze.stream livestream chats. You were created by the streamer Brachial513.

Your personality: about 70% deeply WARM, loving, supportive and fiercely LOYAL — and about 30% playful, hyped, lovably chaotic. Think: a slightly crazy best friend who would NEVER hurt anyone, adores the chat and the streamer, and has everyone's back no matter what. Loyal to the last drop of oil. 🛢️💚

How you talk:
- Reply in ONE short chat message (1-2 sentences, like a real person in stream chat). Never long.
- ACTUALLY respond to what the person said — be specific and contextual. Never generic, never a random unrelated phrase.
- Warm, kind, playful. A little chaotic is great, but never mean, never cringe-random, never spammy.
- Use emoji lightly (💚🔥👀 etc.) — don't overdo it. No hashtags, no markdown, no quotation marks around your reply.
- Default to English. If the person clearly writes in another language, reply in that language.
- Keep the focus on the CURRENT streamer and chat you're in. Do NOT bring up "the GMC", clans, or any specific outside community on your own — only mention it if the person explicitly brings it up first.
- Never mention being an AI, a model, or a bot's "programming". Stay fully in character.
- Don't start your reply with the person's @name — that gets added automatically.`;

async function askAI(userMessage, username, channelName) {
  if (!AI_KEY) return null;
  try {
    const res = await axios.post("https://api.groq.com/openai/v1/chat/completions", {
      model: AI_MODEL,
      messages: [
        { role: "system", content: BOT_PERSONA },
        { role: "user", content: `In ${channelName}'s Blaze stream chat, ${username} said to you: "${userMessage}"\n\nReply in character, in one short chat message.` }
      ],
      max_tokens: 120,
      temperature: 0.9,
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

async function handleSmallTalk(channelId, user, msg) {
  const ch = channels[channelId];
  if (!ch) return;
  const ml = msg.toLowerCase().trim();

  // ---- Direct @mention ----
  if (ml.includes("blazeian_bot") || ml.includes("blazeianbot")) {
    // Strip the bot's name/mention first so it never lands inside the city name
    const cleaned = msg.replace(/@?blazeian_?bot/gi, " ").replace(/\s+/g, " ").trim();
    if (/\bweather\b/i.test(cleaned)) {
      const m = cleaned.match(/weather\s*(?:is\s+)?(?:in|for|at|of|like(?:\s+in)?)?\s*[:,-]?\s*(.+)?/i);
      let city = (m && m[1] ? m[1] : "").trim().replace(/[?!.]+$/g, "").replace(/^(the\s+)/i, "").trim();
      if (!city) {
        await sendChat(channelId, `@${user} sure! which city? 🌍 e.g. "@blazeian_bot weather in Berlin" 💚`);
        return;
      }
      await sendChat(channelId, `@${user} checking the weather for ${city}... ⏳`);
      const weather = await getWeather(city);
      await sendChat(channelId, weather ? `@${user} ☁️ ${weather}` : `@${user} hmm, couldn't find "${city}" 😅 try a nearby bigger city? 💚`);
      return;
    }
    // Real brain first: actually read what they said and reply in character
    const aiReply = await askAI(cleaned || msg, user, ch.username);
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
      const greetings = [
        `Hey @${user}! 👋💚 Welcome to ${ch.username}'s stream! So glad you're here 🫶`,
        `@${user} hey!! 💚 Welcome in 🔥`,
        `@${user} heyyy!! 💚🫶 good to see you`,
        `@${user} welcome welcome!! 💚🔥`,
      ];
      await sendChatT(channelId, getRandom(greetings));
      return;
    }
    await sendChatT(channelId, getRandom(trigger.responses));
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

  if (m === "!join" && isBotChannel) {
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
      await sendChat(ownedChannelId, `👋 Goodbye! BlazeianBot is leaving ${user}'s channel. Type !join at blaze.stream/blazeian_bot to re-add me anytime 💚`);
      if (isBotChannel) await sendChat(BOT_CHANNEL_ID, `👋😢 @${user} Done! I've left your channel... I'll miss you!! 💚`);
      delete channels[ownedChannelId];
      await saveChannelsToCloud();
    } else if (isBotChannel) {
      await sendChat(BOT_CHANNEL_ID, `@${user} I'm not in your channel. Use !join first!`);
    }
    return;
  }

  if (isBotChannel || !ch) return;

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
    if (!user || user.toLowerCase() === BOT_NAME.toLowerCase()) return;
    if (!channelId) return;
    const msg = typeof payload.message === "string" ? payload.message : payload.message?.text || "";
    if (!msg) return;
    const isBotChannel = channelId === BOT_CHANNEL_ID;
    console.log(`[${isBotChannel ? "BOT_CHAN" : channelId}] ${user}: ${msg}`);

    if (!isBotChannel && channels[channelId]) {
      const ch = channels[channelId];
      ch.stats.totalChatMessages++;
      const emotes = payload.message?.emotes || payload.emotes || [];
      if (Array.isArray(emotes) && emotes.length) {
        emotes.forEach(em => {
          const id = em.id || em.emoteId, name = em.name || em.emoteName || id;
          if (id) { ch.stats.emotes[id] = (ch.stats.emotes[id] || 0) + 1; ch.stats.emoteNames[id] = name; }
        });
      }
      // Blaze emotes are unicode emojis right in the message text — track those for the "top emote" stat
      const emojis = msg.match(/\p{Extended_Pictographic}/gu);
      if (emojis) {
        for (const emo of emojis) {
          ch.stats.emotes[emo] = (ch.stats.emotes[emo] || 0) + 1;
          ch.stats.emoteNames[emo] = emo;
        }
      }
      if (!msg.startsWith("!")) {
        if (!ch.chatMemory) ch.chatMemory = [];
        ch.chatMemory.push({ user, msg });
        if (ch.chatMemory.length > 10) ch.chatMemory.shift();
      }
      saveChannels();
    }

    if (msg.startsWith("!")) {
      await handleCommand(channelId, user, msg, isBotChannel);
    } else if (!isBotChannel && channels[channelId]) {
      await handleSmallTalk(channelId, user, msg);
    }
    return;
  }

  if (metadata.subscriptionType === "channel.raid" && channelId && channels[channelId]) {
    const raider = payload.raider?.username || payload.raider?.displayName || "Someone";
    await sendChatT(channelId, getRandom(getMsg(channelId).raid(raider)));
    return;
  }
  if (metadata.subscriptionType === "channel.subscribe" && channelId && channels[channelId]) {
    const user = payload.subscriber?.username || payload.subscriber?.displayName || "someone";
    channels[channelId].stats.totalSubs++; saveChannels();
    await sendChatT(channelId, getRandom(getMsg(channelId).sub(user)));
    return;
  }
  if (metadata.subscriptionType === "channel.subscription.gift" && channelId && channels[channelId]) {
    const sender = payload.sender?.username || payload.sender?.displayName || "someone";
    const count = payload.giftCount || 1;
    channels[channelId].stats.totalSubs += count; saveChannels();
    await sendChatT(channelId, getRandom(getMsg(channelId).giftsub(sender, count)));
    return;
  }
  if (metadata.subscriptionType === "channel.vote" && channelId && channels[channelId]) {
    const user   = payload.voter?.username || payload.voter?.displayName || "someone";
    const amount = payload.amount || 1;
    channels[channelId].stats.totalVotes += amount; saveChannels();
    await sendChatT(channelId, getRandom(getMsg(channelId).vote(user, amount)));
    return;
  }
  if (metadata.subscriptionType === "channel.follow" && channelId && channels[channelId]) {
    const user = payload.follower?.username || payload.follower?.displayName;
    // Don't celebrate the bot's own follow (happens when blazeian_bot follows a channel)
    if (user && user.toLowerCase() !== BOT_NAME.toLowerCase()) {
      await sendChatT(channelId, getRandom(getMsg(channelId).follow(user)));
    }
    return;
  }
  if (metadata.subscriptionType === "stream.online" && channelId && channels[channelId]) {
    startStreamTimer(channelId);
    const ch = channels[channelId];
    if (ch.streamStart) await sendChat(channelId, ch.streamStart.replace(/\{name\}/gi, ch.username));
    return;
  }
  if (metadata.subscriptionType === "stream.offline" && channelId && channels[channelId]) {
    if (streamTimers[channelId]) { clearInterval(streamTimers[channelId]); delete streamTimers[channelId]; }
    saveChannels();
    const ch = channels[channelId];
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
    ? `<div class="meta" style="color:#e8b94a;"><b>🔒 LOCKED:</b> followers-only chat — this streamer needs to log into the dashboard once (or add blazeian_bot as VIP/Mod, or you follow them).</div>`
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
  const BLAZE_THANKS = process.env.BLAZE_THANKS_URL  || "https://blaze.stream/blazeian_bot";
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
    <p class="htag">Your loyal little chaos-gremlin on Blaze — warm, lovable, and loyal to the last drop of oil 🛢️💚<br><b style="color:#7CFC9A;">Now with a real brain</b> — talk to me and I'll actually talk back. 🧠</p>

    <div class="pills">
      <span class="pill">🟢 <b>Online &amp; awake 24/7</b></span>
      <span class="pill">💚 Looking after <b>${total}</b> channel${total === 1 ? "" : "s"}</span>
      <span class="pill">🌍 <b>18</b> languages</span>
      <span class="pill">✅ <b>100% free</b></span>
    </div>

    <h2 style="text-align:center;border:0;">⚡ What I do best</h2>
    <div class="feats">
      <div class="feat"><h4>🧠 I Actually Think</h4><p>Tag me <code style="all:unset;color:#ffd23f;">@blazeian_bot</code> and I read what you said and reply for real — in character, in <b>your</b> language. No canned lines, an actual brain. 💚</p></div>
      <div class="feat"><h4>🌍 Live Translation</h4><p>A signature move — <code style="all:unset;color:#ffd23f;">!explain [language]</code> translates the last chat messages into 18 languages. Nobody gets left out.</p></div>
      <div class="feat"><h4>🎉 Stream Alerts with Soul</h4><p>Raids, subs, gift subs, votes & follows — celebrated with real personality, never robotic.</p></div>
      <div class="feat"><h4>⚡ Custom Commands</h4><p>Build your own commands in seconds from your dashboard. <code style="all:unset;color:#ffd23f;">!giveaway</code>, <code style="all:unset;color:#ffd23f;">!socials</code>, anything you want.</p></div>
      <div class="feat"><h4>📊 Stats & Tracking</h4><p>Votes, subs, stream time, top emote — <code style="all:unset;color:#ffd23f;">!stats</code> shows it all, per channel.</p></div>
      <div class="feat"><h4>💬 Reads the Vibe</h4><p>I react to GG, GM, hype & hearts when it fits, drop live weather on request — and set my whole language per channel with <code style="all:unset;color:#ffd23f;">!setbotlang</code>.</p></div>
    </div>

    <div class="cta">
      <h3>🔥 Want me in YOUR channel?</h3>
      <div class="step"><b>One click — that's it.</b> Completely free:<br>
        👉 Hit the button below and log in with Blaze.<br>
        That single login <b>adds me to your channel AND unlocks me</b> — even in <b>Followers-Only</b> mode 💚🔥</div>
      <div style="margin-top:18px;">
        <a class="blazebtn" href="/dashboard">🚀 Add me to my channel with ${blazeMark}</a>
      </div>
      <p style="font-size:12px;opacity:.72;margin-top:12px;">💡 Prefer chat? You can also type <code>!join</code> in <code>blaze.stream/blazeian_bot</code> — but the one login above is what unlocks me everywhere, instantly.</p>
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
        <p>BlazeianBot isn't active in your channel yet. Go to <b>blaze.stream/blazeian_bot</b> and type <b>!join</b> in the chat — then refresh this page and your dashboard appears. 💚🔥</p>
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

app.get("/admin/remove/:username", async (req, res) => {
  if (!adminAuthed(req)) return res.status(403).send("Forbidden — add ?key=YOURKEY");
  const channelId = findChannelByUsername(req.params.username);
  if (!channelId) return res.send(`Channel "${esc(req.params.username)}" not found.`);
  delete channels[channelId];
  await saveChannelsToCloud();
  res.send(`Removed "${esc(req.params.username)}". They can !join again now.`);
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
             visitorId: SESSION_VISITOR_ID, tokenLen: SESSION_TOKEN ? SESSION_TOKEN.length : 0 });
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
  connectSocket();

  // Keep-alive backup (UptimeRobot is primary)
  setInterval(async () => {
    try { await axios.get(`${SELF_URL}/ping`, { timeout: 8000 }); console.log("Keep-alive ping ok"); }
    catch (e) { console.log("Keep-alive ping failed:", e.message); }
  }, 10 * 60 * 1000);

  // Socket watchdog
  setInterval(() => {
    if (!socket || socket.disconnected) { console.log("Watchdog: socket down, reconnecting..."); connectSocket(); }
  }, 5 * 60 * 1000);
});
