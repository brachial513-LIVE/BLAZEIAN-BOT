const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");
const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;
const BOT_CHANNEL_ID = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_USER_ID    = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_NAME       = "blazeian_bot";
const CLIENT_ID      = process.env.BLAZE_CLIENT_ID;
const CLIENT_SECRET  = process.env.BLAZE_CLIENT_SECRET;
const REDIRECT_URI   = "https://blazeian-bot.onrender.com/callback";

let ACCESS_TOKEN  = process.env.BLAZE_ACCESS_TOKEN  || null;
let REFRESH_TOKEN = process.env.BLAZE_REFRESH_TOKEN || null;
let pendingState        = null;
let pendingCodeVerifier = null;
let APP_ACCESS_TOKEN    = null;

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
    return true;
  } catch (e) {
    console.log("Refresh error:", e.response?.data || e.message);
    return false;
  }
}
setInterval(refreshAccessToken, 20 * 60 * 60 * 1000);

// JSONBin
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;
const JSONBIN_HEADERS = {
  "Content-Type": "application/json",
  "X-Master-Key": process.env.JSONBIN_KEY
};
async function loadChannelsFromCloud() {
  try {
    const res = await axios.get(JSONBIN_URL, { headers: JSONBIN_HEADERS });
    const data = res.data.record?.channels || res.data.record || {};
    console.log("Loaded channels:", Object.keys(data).length);
    return data;
  } catch(e) {
    console.log("JSONBin load error:", e.response?.data || e.message);
    return {};
  }
}
async function saveChannelsToCloud() {
  try {
    await axios.put(JSONBIN_URL, { channels }, { headers: JSONBIN_HEADERS });
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
      customCommands: {}
    };
    saveChannels();
  }
  if (!channels[channelId].language) channels[channelId].language = "en";
  if (!channels[channelId].customCommands) channels[channelId].customCommands = {};
  return channels[channelId];
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
    cmdList: (custom) => {
      const base = `BlazeianBot: !stats | !votes | !subs | !chat | !time | !emote | !explain [language] | !setbotlang [language] 💚`;
      if (custom && Object.keys(custom).length > 0)
        return `${base} | ${Object.keys(custom).map(c => `!${c}`).join(" | ")}`;
      return base;
    },
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
    cmdList: (custom) => {
      const base = `BlazeianBot: !stats | !votes | !subs | !chat | !time | !emote | !explain [Sprache] | !setbotlang [Sprache] 💚`;
      if (custom && Object.keys(custom).length > 0)
        return `${base} | ${Object.keys(custom).map(c => `!${c}`).join(" | ")}`;
      return base;
    },
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
    cmdList: (custom) => {
      const base = `BlazeianBot: !stats | !votes | !subs | !chat | !time | !emote | !explain [idioma] | !setbotlang [idioma] 💚`;
      if (custom && Object.keys(custom).length > 0)
        return `${base} | ${Object.keys(custom).map(c => `!${c}`).join(" | ")}`;
      return base;
    },
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
function chance(p)       { return Math.random() < p; }
function getLang(channelId) { return channels[channelId]?.language || "en"; }
function getMsg(channelId)  { const l = getLang(channelId); return MESSAGES[l] || MESSAGES["en"]; }

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

async function sendChat(channelId, message) {
  if (APP_ACCESS_TOKEN) {
    try {
      await axios.post(`${API}/v1/chats/messages`, { channelId, message, senderId: BOT_USER_ID }, { headers: appHeaders() });
      console.log(`[${channelId}] BOT: ${message}`);
      return;
    } catch(e) {
      if (e.response?.status === 401) await getAppAccessToken();
      console.log("App token send failed:", e.response?.data?.message || e.message);
    }
  }
  try {
    await axios.post(`${API}/v1/chats/messages`, { channelId, message }, { headers: headers() });
    console.log(`[${channelId}] BOT (user token): ${message}`);
  } catch (e) {
    if (e.response?.status === 401) {
      const ok = await refreshAccessToken();
      if (ok) await sendChat(channelId, message);
    } else {
      console.log("Send error:", e.response?.data || e.message);
    }
  }
}

async function subscribe(type, channelId) {
  try {
    await axios.post(`${API}/v1/events/subscriptions`, {
      type, version: "1", sessionId: global.SESSION_ID, condition: { channelId }
    }, { headers: headers() });
    console.log(`Subscribed: ${type} on ${channelId}`);
  } catch (e) {
    console.log(`Subscribe error (${type}):`, e.response?.data || e.message);
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
      timeout: 6000,
      headers: { "User-Agent": "BlazeianBot/1.0" }
    });
    const c    = res.data.current_condition[0];
    const area = res.data.nearest_area?.[0];
    const areaName = area?.areaName?.[0]?.value || city;
    const country  = area?.country?.[0]?.value  || "";
    const desc     = c.weatherDesc[0].value;
    const tempC    = c.temp_C;
    const feelsC   = c.FeelsLikeC;
    const humidity = c.humidity;
    const windKmh  = c.windspeedKmph;
    return `${areaName}${country ? ", " + country : ""}: ${desc} | 🌡️ ${tempC}°C (feels ${feelsC}°C) | 💧 ${humidity}% | 💨 ${windKmh} km/h 💚`;
  } catch(e) {
    console.log("Weather error:", e.message);
    return null;
  }
}

// =============================================
// SMALLTALK SYSTEM
// =============================================
// In-memory cooldown tracker: { channelId: { triggerKey: lastFiredTimestamp } }
const chatCooldowns = {};
function canFireTrigger(channelId, key, cooldownMs) {
  if (!chatCooldowns[channelId]) chatCooldowns[channelId] = {};
  const last = chatCooldowns[channelId][key] || 0;
  if (Date.now() - last < cooldownMs) return false;
  chatCooldowns[channelId][key] = Date.now();
  return true;
}

// Triggers: pattern, key (for cooldown), cooldown (ms), prob (0-1 random chance), responses
const SMALLTALK_TRIGGERS = [
  {
    key: "gg",
    pattern: /\bgg\b|\bgood game\b/i,
    cooldown: 90000,
    prob: 0.60,
    responses: [
      "GG!! 🔥💚 absolute legend behavior",
      "GG in chat!! 💚 that was clean",
      "GG!! 💚🔥 let's gooo",
    ]
  },
  {
    key: "gm",
    pattern: /\bgm\b|\bgood morning\b/i,
    cooldown: 120000,
    prob: 0.70,
    responses: [
      "GM!! ☀️💚 hope your day absolutely slaps",
      "Good morning!! ☀️ welcome to the chaos 💚🔥",
      "GM gm gm!! ☀️ let's GET it 💚",
      "GM!! ☀️💚 you showed up, that already makes today better 🫶",
    ]
  },
  {
    key: "gn",
    pattern: /\bgn\b|\bgood night\b/i,
    cooldown: 120000,
    prob: 0.70,
    responses: [
      "GN!! 🌙💚 sleep well, come back soon 🫶",
      "Good night!! 🌙 take care of yourself 💚",
      "GN!! 💚 you'll be missed!! 🌙🫶",
      "GN!! 🌙💚 dream of good games 🎮",
    ]
  },
  {
    key: "hearts",
    // matches common heart/love emojis
    pattern: /[❤️💚🫶💕💗💖💝🥰😍💓💞🩷🧡💛💙💜🤍🖤]/u,
    cooldown: 60000,
    prob: 0.55,
    responses: [
      "💚 right back at you!!",
      "awww 🫶💚 we love you too!!",
      "so much love in this chat I genuinely cannot 💚😭",
      "💚💚💚 the vibes in here are immaculate",
      "giving that love right back 🫶💚🔥",
    ]
  },
  {
    key: "lol",
    pattern: /\blol\b|\blmao\b|\blmfao\b|\bhaha\b|\bhahaha\b|\bkekw\b|\blul\b|\bxd\b/i,
    cooldown: 90000,
    prob: 0.45,
    responses: [
      "😂💚 same honestly",
      "bro I'm actually crying 😂🔥",
      "LMAOO 💚 not me cackling right now",
      "😂😂💚 I can't",
      "okay that got me ngl 😂💚",
    ]
  },
  {
    key: "hype",
    pattern: /\bpog\b|\bpoggers\b|\bpogchamp\b|\blets go\b|\blet's go\b|\blfg\b|\bhype\b|\bbanger\b|\bW\b|\bW\+\b/i,
    cooldown: 90000,
    prob: 0.60,
    responses: [
      "POG!! 🔥💚",
      "POGGERS IN CHAT!! 🔥🔥💚",
      "LET'S GOOOO!! 🔥💚",
      "W!! 💚🔥 absolute W",
      "HYPE!! 🔥🔥🔥💚 let's GO",
    ]
  },
  {
    key: "f",
    // only react if the message is literally just "F" or "f in chat"
    pattern: /^\s*f\s*$|^f in chat\s*$/i,
    cooldown: 60000,
    prob: 0.70,
    responses: [
      "F 🫡💚 we pay our respects",
      "F in chat 🫡💚",
      "F 🫡 rip 💚",
    ]
  },
  {
    key: "rip",
    pattern: /\brip\b/i,
    cooldown: 90000,
    prob: 0.50,
    responses: [
      "RIP 🫡💚 F in chat",
      "rip 😔💚 we remember",
      "F 🫡 RIP 💚",
    ]
  },
  {
    key: "wow",
    pattern: /\bwow\b|\bomg\b|\bno way\b|\bcrazy\b|\binsane\b/i,
    cooldown: 90000,
    prob: 0.40,
    responses: [
      "RIGHT?! 💚🔥",
      "bro same WOW 😭💚",
      "no wayyy 💚🔥",
      "that's actually insane 💚",
      "I can't believe it either 😭💚",
    ]
  },
  {
    key: "nt",
    pattern: /\bnt\b|\bnice try\b|\bgg ez\b/i,
    cooldown: 90000,
    prob: 0.50,
    responses: [
      "NT!! 💚 next round, let's go",
      "nt nt!! 💚 shake it off 🔥",
      "NT!! 🔥💚 that was still clean",
    ]
  },
  {
    key: "love",
    pattern: /\bi love (this|you|it|chat|stream)\b/i,
    cooldown: 90000,
    prob: 0.60,
    responses: [
      "WE LOVE YOU TOO!! 💚😭🫶",
      "awww 💚💚 this chat is the best honestly",
      "okay I'm not crying you're crying 😭💚🫶",
      "the feeling is SO mutual 💚🔥",
    ]
  },
  {
    key: "greeting",
    pattern: /\bhello\b|\bhey\b|\bhi\b/i,
    cooldown: 30000,
    prob: 0.65,
    responses: null, // handled separately (needs @user)
  },
];

async function handleSmallTalk(channelId, user, msg) {
  const ch = channels[channelId];
  if (!ch) return;
  const ml = msg.toLowerCase().trim();

  // ---- Direct @mention ----
  const isMention = ml.includes("blazeian_bot") || ml.includes("blazeianbot");
  if (isMention) {
    // Weather query — e.g. "what's the weather in Boston?"
    const weatherMatch = msg.match(/weather\s+(?:in|for|at|of)?\s*([a-zA-Z\s,]+?)(?:\?|!|$)/i);
    if (weatherMatch) {
      const city = weatherMatch[1].trim();
      await sendChat(channelId, `@${user} checking weather for ${city}... ⏳`);
      const weather = await getWeather(city);
      if (weather) {
        await sendChat(channelId, `@${user} ☁️ ${weather}`);
      } else {
        await sendChat(channelId, `@${user} Hmm, couldn't find "${city}" – try a different city name? 😅💚`);
      }
      return;
    }

    // Generic mention fallback
    const responses = [
      `@${user} hey!! 👋💚 What's up?`,
      `@${user} you called?! 💚🔥`,
      `@${user} present!! 👀💚 How can I help?`,
      `@${user} I'm here I'm here!! 💚🫶`,
      `@${user} 💚👀 yes??`,
    ];
    await sendChat(channelId, getRandom(responses));
    return;
  }

  // ---- Casual triggers ----
  for (const trigger of SMALLTALK_TRIGGERS) {
    if (!trigger.pattern.test(msg)) continue;
    if (!canFireTrigger(channelId, trigger.key, trigger.cooldown)) continue;
    if (!chance(trigger.prob)) continue;

    if (trigger.key === "greeting") {
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
    return; // only fire one trigger per message
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
  socket.on("connect_error", err => {
    console.log("Socket error:", err.message);
    reconnectTimer = setTimeout(connectSocket, 10000);
  });
  socket.on("disconnect", reason => {
    console.log("Socket disconnected:", reason);
    if (reason !== "io client disconnect")
      reconnectTimer = setTimeout(connectSocket, 5000);
  });
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

  // !join — only in bot channel
  if (m === "!join" && isBotChannel) {
    const slug = user.toLowerCase();
    const newChannelId = await getChannelIdBySlug(slug);
    if (!newChannelId) {
      await sendChat(BOT_CHANNEL_ID, `@${user} Couldn't find your channel. Make sure your Blaze username matches! 💚`);
      return;
    }
    if (channels[newChannelId]) {
      await sendChat(BOT_CHANNEL_ID, `@${user} I'm already active in your channel! 💚`);
      return;
    }
    getOrCreateChannel(newChannelId, user);
    ALL_EVENT_TYPES.forEach(t => subscribe(t, newChannelId));
    await sendChat(BOT_CHANNEL_ID,
      `@${user} Done! I've joined your channel 💚 Your viewers can now use: !stats | !votes | !subs | !time | !emote | !explain [language] | !setbotlang [language] | !addcmd to add your own commands!`
    );
    await sendChat(newChannelId,
      `Hey chat! BlazeianBot is now active in ${user}'s channel! Type !cmd to see what I can do 💚🔥`
    );
    return;
  }

  // !leave
  if (m === "!leave") {
    const ownedChannelId = Object.keys(channels).find(
      id => channels[id].username.toLowerCase() === user.toLowerCase()
    );
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
    const langInput = (parts[1] || "").toLowerCase();
    const langCode = LANG_CODES[langInput];
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
    const parts = msg.trim().split(/\s+/);
    const cmdName = (parts[1] || "").toLowerCase().replace(/^!/, "");
    if (!cmdName || !ch.customCommands?.[cmdName]) {
      await sendChatT(channelId, T.cmdNotFound(cmdName || "?")); return;
    }
    delete ch.customCommands[cmdName];
    saveChannels();
    await sendChatT(channelId, T.cmdDeleted(cmdName));
    return;
  }

  // Built-in stat commands
  if (m === "!stats")  { await sendChatT(channelId, T.stats(ch)); return; }
  if (m === "!votes")  { await sendChatT(channelId, T.votes(ch)); return; }
  if (m === "!subs")   { await sendChatT(channelId, T.subs(ch)); return; }
  if (m === "!chat")   { await sendChatT(channelId, T.chat(ch)); return; }
  if (m === "!time")   { await sendChatT(channelId, T.time(ch)); return; }
  if (m === "!emote")  { await sendChatT(channelId, T.emote(ch)); return; }

  if (m === "!cmd" || m === "!help" || m === "!commands") {
    await sendChatT(channelId, T.cmdList(ch.customCommands)); return;
  }

  // !explain
  if (m.startsWith("!explain")) {
    const parts = msg.trim().split(/\s+/);
    const langInput = (parts[1] || "").toLowerCase();
    const langCode = LANG_CODES[langInput];
    if (!langInput || !langCode) { await sendChatT(channelId, T.explainUsage(user)); return; }
    const last3 = (ch.chatMemory || []).slice(-3);
    if (!last3.length) { await sendChatT(channelId, T.noMessages(user)); return; }
    const translated = await translateMessages(last3, langCode);
    if (translated) {
      await sendChat(channelId, `[${LANG_DISPLAY[langCode]}] ${translated}`);
    } else {
      await sendChatT(channelId, T.translateFail(user));
    }
    return;
  }

  // Custom commands
  if (m.startsWith("!") && ch.customCommands) {
    const cmdName = m.slice(1).split(/\s+/)[0];
    if (ch.customCommands[cmdName]) {
      await sendChatT(channelId, ch.customCommands[cmdName]);
      return;
    }
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
    if (ACCESS_TOKEN) {
      await sendChat(BOT_CHANNEL_ID, "BlazeianBot is online! Type !join here to add me to your channel 💚🔥");
      setTimeout(subscribeAllChannels, 2000);
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

    // Track stats + chat memory
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
      if (!msg.startsWith("!")) {
        if (!ch.chatMemory) ch.chatMemory = [];
        ch.chatMemory.push({ user, msg });
        if (ch.chatMemory.length > 10) ch.chatMemory.shift();
      }
      saveChannels();
    }

    // Route: commands vs. smalltalk
    if (msg.startsWith("!")) {
      await handleCommand(channelId, user, msg, isBotChannel);
    } else if (!isBotChannel && channels[channelId]) {
      await handleSmallTalk(channelId, user, msg);
    }
    return;
  }

  if (metadata.subscriptionType === "channel.raid" && channelId && channels[channelId]) {
    const raider = payload.raider?.username || payload.raider?.displayName || "Someone";
    const T = getMsg(channelId);
    await sendChatT(channelId, getRandom(T.raid(raider)));
    return;
  }
  if (metadata.subscriptionType === "channel.subscribe" && channelId && channels[channelId]) {
    const user = payload.subscriber?.username || payload.subscriber?.displayName || "someone";
    channels[channelId].stats.totalSubs++;
    saveChannels();
    await sendChatT(channelId, getRandom(getMsg(channelId).sub(user)));
    return;
  }
  if (metadata.subscriptionType === "channel.subscription.gift" && channelId && channels[channelId]) {
    const sender = payload.sender?.username || payload.sender?.displayName || "someone";
    const count = payload.giftCount || 1;
    channels[channelId].stats.totalSubs += count;
    saveChannels();
    await sendChatT(channelId, getRandom(getMsg(channelId).giftsub(sender, count)));
    return;
  }
  if (metadata.subscriptionType === "channel.vote" && channelId && channels[channelId]) {
    const user   = payload.voter?.username || payload.voter?.displayName || "someone";
    const amount = payload.amount || 1;
    channels[channelId].stats.totalVotes += amount;
    saveChannels();
    await sendChatT(channelId, getRandom(getMsg(channelId).vote(user, amount)));
    return;
  }
  if (metadata.subscriptionType === "channel.follow" && channelId && channels[channelId]) {
    const user = payload.follower?.username || payload.follower?.displayName;
    if (user) await sendChatT(channelId, getRandom(getMsg(channelId).follow(user)));
    return;
  }
  if (metadata.subscriptionType === "stream.online" && channelId && channels[channelId]) {
    startStreamTimer(channelId);
    return;
  }
  if (metadata.subscriptionType === "stream.offline" && channelId && channels[channelId]) {
    if (streamTimers[channelId]) { clearInterval(streamTimers[channelId]); delete streamTimers[channelId]; }
    saveChannels();
    return;
  }
}

// =============================================
// OAUTH ROUTES
// =============================================
app.get("/login", async (req, res) => {
  try {
    const response = await axios.post("https://blaze.stream/bapi/oauth2/generate-auth-url", {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: REDIRECT_URI,
      scopes: ["users.read", "offline.access", "channel.moderate", "users.bot"]
    });
    pendingState = response.data.state;
    pendingCodeVerifier = response.data.codeVerifier;
    res.redirect(response.data.url);
  } catch (e) {
    res.send(`<pre>Login error: ${JSON.stringify(e.response?.data || e.message)}</pre><a href="/login">Retry</a>`);
  }
});

app.get("/callback", async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send("Error: No code received.");
  if (state && pendingState && state !== pendingState) return res.send("Error: State mismatch.");
  try {
    const tokenRes = await axios.post("https://blaze.stream/bapi/oauth2/token", {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      code, codeVerifier: pendingCodeVerifier,
      redirectUri: REDIRECT_URI, grantType: "authorization_code"
    });
    ACCESS_TOKEN  = tokenRes.data.accessToken;
    REFRESH_TOKEN = tokenRes.data.refreshToken;
    pendingState = null; pendingCodeVerifier = null;
    console.log("New token");
    connectSocket();
    res.send(`
      <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
        <h1>Login successful!</h1>
        <p><strong>BLAZE_ACCESS_TOKEN:</strong><br>
        <textarea style="width:100%;height:60px;background:#222;color:#f5a623;border:1px solid #444;padding:8px;">${ACCESS_TOKEN}</textarea></p>
        <p><strong>BLAZE_REFRESH_TOKEN:</strong><br>
        <textarea style="width:100%;height:60px;background:#222;color:#f5a623;border:1px solid #444;padding:8px;">${REFRESH_TOKEN}</textarea></p>
        <p><a href="/" style="color:#f5a623;">Status page</a></p>
      </body></html>
    `);
  } catch (e) {
    res.send(`<pre>Token error: ${JSON.stringify(e.response?.data || e.message)}</pre><a href="/login">Retry</a>`);
  }
});

// =============================================
// STATUS & ADMIN ROUTES
// =============================================
app.get("/", (req, res) => {
  const joinedList = Object.entries(channels).map(([id, ch]) => {
    const cmds = Object.keys(ch.customCommands || {}).map(c => `!${c}`).join(", ") || "none";
    return `<li><strong>${ch.username}</strong> (${id})<br>
      Lang: ${ch.language || "en"} | Msgs: ${ch.stats.totalChatMessages} | Subs: ${ch.stats.totalSubs} | Votes: ${ch.stats.totalVotes}<br>
      Custom commands: ${cmds}</li>`;
  }).join("") || "<li>No channels joined yet</li>";

  res.send(`
    <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
      <h1>BlazeianBot 💚</h1>
      <p>User Token: <strong>${ACCESS_TOKEN ? "Active ✅" : "Missing ❌"}</strong></p>
      <p>App Token: <strong>${APP_ACCESS_TOKEN ? "Active ✅" : "Missing ❌"}</strong></p>
      <h2>Joined Channels (${Object.keys(channels).length})</h2>
      <ul>${joinedList}</ul>
      <p><a href="/login" style="color:#f5a623;">Refresh token</a></p>
    </body></html>
  `);
});

app.get("/stats", (req, res) => res.json(channels));

app.get("/admin/remove/:username", async (req, res) => {
  const username  = req.params.username.toLowerCase();
  const channelId = Object.keys(channels).find(id => channels[id].username.toLowerCase() === username);
  if (!channelId) return res.send(`Channel "${username}" not found.`);
  delete channels[channelId];
  await saveChannelsToCloud();
  res.send(`Removed "${username}". They can !join again now.`);
});

app.get("/admin/list", (req, res) => {
  const list = Object.entries(channels).map(([id, ch]) => {
    const cmds = Object.keys(ch.customCommands || {}).join(", ") || "none";
    return `${ch.username} (${id}) – Lang: ${ch.language || "en"} | Msgs: ${ch.stats.totalChatMessages} | Custom: ${cmds}`;
  }).join("\n");
  res.send(`<pre>${list || "No channels"}</pre>`);
});

app.get("/admin/whoami", async (req, res) => {
  try {
    const r = await axios.get("https://api.blaze.stream/v1/users/profile", { headers: headers() });
    res.json(r.data);
  } catch(e) {
    res.json(e.response?.data || e.message);
  }
});

// =============================================
// START — load data FIRST, then connect socket
// =============================================
app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);
  channels = await loadChannelsFromCloud();
  console.log(`Loaded ${Object.keys(channels).length} channel(s)`);
  await getAppAccessToken();
  connectSocket();
});
