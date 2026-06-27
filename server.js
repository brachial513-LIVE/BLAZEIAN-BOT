const express = require("express");
const axios = require("axios");
const { io } = require("socket.io-client");
const crypto = require("crypto");

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

// ===============================
// CONFIG
// ===============================
const BOT_CHANNEL_ID = "514160a7-fd05-4d7b-9932-a0143aa40d1c";
const BOT_NAME       = "blazeian_bot";
const CLIENT_ID      = process.env.BLAZE_CLIENT_ID;
const CLIENT_SECRET  = process.env.BLAZE_CLIENT_SECRET;
const REDIRECT_URI   = "https://blazeian-bot.onrender.com/callback";

// ===============================
// TOKEN STATE
// ===============================
let ACCESS_TOKEN  = process.env.BLAZE_ACCESS_TOKEN  || null;
let REFRESH_TOKEN = process.env.BLAZE_REFRESH_TOKEN || null;
let pendingState        = null;
let pendingCodeVerifier = null;

async function refreshAccessToken() {
  if (!REFRESH_TOKEN) { console.log("No refresh token – need /login"); return false; }
  try {
    const res = await axios.post("https://blaze.stream/bapi/oauth2/refresh", {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, refreshToken: REFRESH_TOKEN
    });
    ACCESS_TOKEN  = res.data.accessToken;
    REFRESH_TOKEN = res.data.refreshToken || REFRESH_TOKEN;
    console.log("Token refreshed ✅");
    return true;
  } catch (e) {
    console.log("Refresh error:", e.response?.data || e.message);
    return false;
  }
}
setInterval(refreshAccessToken, 20 * 60 * 60 * 1000);

// ===============================
// JSONBIN PERSISTENCE
// ===============================
const JSONBIN_URL = `https://api.jsonbin.io/v3/b/${process.env.JSONBIN_BIN_ID}`;
const JSONBIN_HEADERS = {
  "Content-Type": "application/json",
  "X-Master-Key": process.env.JSONBIN_KEY
};

async function loadChannelsFromCloud() {
  try {
    const res = await axios.get(JSONBIN_URL, { headers: JSONBIN_HEADERS });
    const data = res.data.record?.channels || res.data.record || {};
    console.log("Loaded channels from JSONBin:", Object.keys(data).length);
    return data;
  } catch(e) {
    console.log("JSONBin load error:", e.response?.data || e.message);
    return {};
  }
}

async function saveChannelsToCloud() {
  try {
    await axios.put(JSONBIN_URL, { channels }, { headers: JSONBIN_HEADERS });
    console.log("Channels saved to JSONBin ✅");
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
      chatMemory: []
    };
    saveChannels();
  }
  // Ensure language field exists for old entries
  if (!channels[channelId].language) channels[channelId].language = "en";
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

// ===============================
// LANGUAGE SYSTEM
// ===============================
const LANG_CODES = {
  german: "de", deutsch: "de",
  english: "en", englisch: "en",
  spanish: "es", spanisch: "es", español: "es",
  french: "fr", französisch: "fr", francais: "fr",
  portuguese: "pt", portugiesisch: "pt",
  italian: "it", italienisch: "it",
  dutch: "nl", niederländisch: "nl",
  russian: "ru", russisch: "ru",
  japanese: "ja", japanisch: "ja",
  korean: "ko", koreanisch: "ko",
  chinese: "zh", chinesisch: "zh",
  arabic: "ar", arabisch: "ar",
  turkish: "tr", türkisch: "tr",
  polish: "pl", polnisch: "pl",
  swedish: "sv", schwedisch: "sv",
  ukrainian: "uk", ukrainisch: "uk",
  romanian: "ro", rumänisch: "ro",
  hindi: "hi",
};

const LANG_DISPLAY = {
  de: "German", en: "English", es: "Spanish", fr: "French",
  pt: "Portuguese", it: "Italian", nl: "Dutch", ru: "Russian",
  ja: "Japanese", ko: "Korean", zh: "Chinese", ar: "Arabic",
  tr: "Turkish", pl: "Polish", sv: "Swedish", uk: "Ukrainian",
  ro: "Romanian", hi: "Hindi",
};

// ===============================
// BOT MESSAGES per language
// 70% warm & loving, 30% loveable crazy
// ===============================
const MESSAGES = {
  en: {
    raid: (raider) => [
      `WAIT— HOLD ON— 💚🔥 ...okay I'm fine. WELCOME ${raider} and your amazing crew!! You just made this place so much better by showing up 🫶 We love every single one of you!!`,
      `OH?! OH WOW— ${raider} just raided us?! I'm not crying you're crying 😭💚 Welcome welcome WELCOME to the family, every single one of you belongs here 🔥`,
      `SOMEONE TELL ME I'M NOT DREAMING— ${raider} brought the whole squad?! 🔥💚 Come in, sit down, we saved you a spot. You're home now. 🫶`,
    ],
    sub: (user) => [
      `${user} just subscribed?! I— 💚 ...I need a moment. Thank you so much, genuinely. You beautiful human being 🫶🔥`,
      `WAIT ${user} SUBBED?! Okay okay okay— 💚💚 I love you, the streamer loves you, CHAT loves you. Best decision of your life honestly 😭🔥`,
      `${user}!! You subscribed!! I'm putting your name in my heart right now 💚 No seriously, thank you so much. You're incredible 🫶`,
    ],
    giftsub: (sender, count) => [
      `${sender} just gifted ${count} sub(s)?! WHO DOES THAT?! 💚🔥 An absolute LEGEND, that's who. Chat, show some love RIGHT NOW 🫶`,
      `GIFTED SUBS?! ${sender} said "everyone gets love today" and dropped ${count} sub(s)!! 😭💚 We don't deserve you but we're SO glad you're here 🔥`,
    ],
    vote: (user, amount) => [
      `${user} voted with ${amount}! 🗳️💚 Every single vote means the world here, thank you for showing up 🔥`,
      `OH ${user} VOTED?! ${amount} power coming in hot!! 🔥💚 You're literally fueling this whole thing, we see you and we LOVE you 🫶`,
      `${user} dropped ${amount} votes like it's nothing?! 💚 Absolute legend behavior. Thank you so much 🔥🫶`,
    ],
    follow: (user) => [
      `❤️ @${user} just followed!! Welcome to the family 💚 So glad you're here, stay a while 🫶`,
      `@${user} FOLLOWED?! 💚🔥 Best decision today honestly. Welcome welcome welcome!! 🫶`,
    ],
    langSet: (lang) => `✅ Bot language set to ${lang}! I'll speak ${lang} in this channel from now on 💚`,
    langInvalid: `❌ That language isn't supported yet! Try: English, German, Spanish, French, Portuguese, Italian, Dutch, Russian, Japanese, Korean, Chinese, Arabic, Turkish, Polish, Swedish, Ukrainian, Romanian or Hindi 💚`,
    cmdList: `🤖 BlazeianBot commands: !stats | !votes | !subs | !chat | !time | !emote | !explain [language] | !setbotlang [language] — Example: !explain German`,
    noMessages: (user) => `@${user} No recent messages to translate yet! Chat a bit first 💚`,
    translateFail: (user) => `@${user} Translation failed, please try again! 💚`,
    explainUsage: (user) => `@${user} Please specify a language! Example: !explain German | !explain Spanish | !explain Japanese 💚`,
    greeting: (user, streamer) => `Hey @${user}! 👋💚 Welcome to ${streamer}'s stream! So glad you're here 🫶`,
  },
  de: {
    raid: (raider) => [
      `WARTE— ICH— 💚🔥 ...okay alles gut. WILLKOMMEN ${raider} und eure ganze Crew!! Ihr macht diesen Ort so viel besser 🫶 Wir lieben euch alle!!`,
      `OH?! OH WOW— ${raider} hat uns geraided?! Ich weine nicht, du weinst 😭💚 Willkommen willkommen WILLKOMMEN in der Familie, ihr gehört alle hier her 🔥`,
      `JEMAND SAGT MIR ICH TRÄUME NICHT— ${raider} hat die ganze Gang mitgebracht?! 🔥💚 Kommt rein, setzt euch, wir haben Platz für euch. Ihr seid zuhause. 🫶`,
    ],
    sub: (user) => [
      `${user} hat subscribed?! Ich— 💚 ...ich brauch kurz. Danke so sehr, wirklich. Du wunderbarer Mensch 🫶🔥`,
      `WARTE ${user} HAT GESUBBT?! Okay okay okay— 💚💚 Ich liebe dich, der Streamer liebt dich, CHAT liebt dich. Beste Entscheidung deines Lebens ehrlich gesagt 😭🔥`,
      `${user}!! Du hast subscribed!! Ich schreibe deinen Namen gerade in mein Herz 💚 Ernsthaft, danke so sehr. Du bist unglaublich 🫶`,
    ],
    giftsub: (sender, count) => [
      `${sender} hat gerade ${count} Sub(s) verschenkt?! WER MACHT DAS?! 💚🔥 Eine absolute LEGENDE, das ist wer. Chat, zeigt jetzt Liebe 🫶`,
      `GESCHENKTE SUBS?! ${sender} hat gesagt "heute kriegen alle Liebe" und ${count} Sub(s) rausgehauen!! 😭💚 Wir verdienen dich nicht aber wir sind SO froh dass du hier bist 🔥`,
    ],
    vote: (user, amount) => [
      `${user} hat mit ${amount} gevotet! 🗳️💚 Jeder einzelne Vote bedeutet hier die Welt, danke dass du da bist 🔥`,
      `OH ${user} HAT GEVOTET?! ${amount} Power kommt rein!! 🔥💚 Du treibst das hier buchstäblich an, wir sehen dich und wir LIEBEN dich 🫶`,
      `${user} hat ${amount} Votes hingeworfen als wär's nix?! 💚 Absolute Legende. Danke so sehr 🔥🫶`,
    ],
    follow: (user) => [
      `❤️ @${user} ist gefolgt!! Willkommen in der Familie 💚 So froh dass du hier bist 🫶`,
      `@${user} HAT GEFOLGT?! 💚🔥 Beste Entscheidung heute ehrlich. Willkommen willkommen willkommen!! 🫶`,
    ],
    langSet: (lang) => `✅ Bot-Sprache auf ${lang} gesetzt! Ich spreche ab jetzt ${lang} in diesem Kanal 💚`,
    langInvalid: `❌ Diese Sprache wird noch nicht unterstützt! Versuch: English, German, Spanish, French, Portuguese, Italian, Dutch, Russian, Japanese, Korean, Chinese, Arabic, Turkish, Polish, Swedish, Ukrainian, Romanian oder Hindi 💚`,
    cmdList: `🤖 BlazeianBot Befehle: !stats | !votes | !subs | !chat | !time | !emote | !explain [Sprache] | !setbotlang [Sprache] — Beispiel: !explain German`,
    noMessages: (user) => `@${user} Noch keine Nachrichten zum Übersetzen! Chattet erst etwas 💚`,
    translateFail: (user) => `@${user} Übersetzung fehlgeschlagen, versuch's nochmal! 💚`,
    explainUsage: (user) => `@${user} Bitte gib eine Sprache an! Beispiel: !explain German | !explain Spanish | !explain Japanese 💚`,
    greeting: (user, streamer) => `Hey @${user}! 👋💚 Willkommen in ${streamer}'s Stream! So froh dass du hier bist 🫶`,
  },
  es: {
    raid: (raider) => [
      `ESPERA— YO— 💚🔥 ...bien estoy bien. ¡BIENVENIDOS ${raider} y toda su crew!! Hacéis este lugar mucho mejor 🫶 ¡Os amamos a todos!!`,
      `¿OH?! ¡OH WOW— ${raider} nos ha hecho raid?! Yo no estoy llorando, tú estás llorando 😭💚 ¡Bienvenidos bienvenidos BIENVENIDOS a la familia! 🔥`,
    ],
    sub: (user) => [
      `¿${user} acaba de subscribirse?! Yo— 💚 ...necesito un momento. Gracias de verdad, ser humano maravilloso 🫶🔥`,
      `¡¿${user} SE HA SUBSCRITO?! Okay okay okay— 💚💚 Te quiero, el streamer te quiere, el CHAT te quiere. La mejor decisión de tu vida 😭🔥`,
    ],
    giftsub: (sender, count) => [
      `¿${sender} acaba de regalar ${count} sub(s)?! ¡¿QUIÉN HACE ESO?! 💚🔥 Una LEYENDA absoluta, eso es. Chat, ¡mostrad amor AHORA! 🫶`,
    ],
    vote: (user, amount) => [
      `¡${user} votó con ${amount}! 🗳️💚 Cada voto importa muchísimo aquí, gracias por estar 🔥`,
      `¿${user} VOTÓ?! ¡${amount} de poder entrando fuerte!! 🔥💚 Te vemos y te AMAMOS 🫶`,
    ],
    follow: (user) => [
      `❤️ ¡@${user} acaba de seguir!! Bienvenido a la familia 💚 Qué alegría que estés aquí 🫶`,
    ],
    langSet: (lang) => `✅ ¡Idioma del bot configurado a ${lang}! Hablaré ${lang} en este canal 💚`,
    langInvalid: `❌ ¡Ese idioma no está soportado aún! Prueba: English, German, Spanish, French, Portuguese, Italian, Dutch, Russian, Japanese, Korean, Chinese, Arabic, Turkish, Polish, Swedish, Ukrainian, Romanian o Hindi 💚`,
    cmdList: `🤖 Comandos de BlazeianBot: !stats | !votes | !subs | !chat | !time | !emote | !explain [idioma] | !setbotlang [idioma] — Ejemplo: !explain German`,
    noMessages: (user) => `@${user} ¡Aún no hay mensajes para traducir! Chatea un poco primero 💚`,
    translateFail: (user) => `@${user} ¡Traducción fallida, inténtalo de nuevo! 💚`,
    explainUsage: (user) => `@${user} ¡Especifica un idioma! Ejemplo: !explain German | !explain Spanish | !explain Japanese 💚`,
    greeting: (user, streamer) => `¡Hola @${user}! 👋💚 ¡Bienvenido al stream de ${streamer}! Qué alegría tenerte aquí 🫶`,
  },
};

// Fallback to English for languages without full translation set
function getMsg(channelId) {
  const lang = channels[channelId]?.language || "en";
  return MESSAGES[lang] || MESSAGES["en"];
}

function getRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ===============================
// BLAZE API HELPERS
// ===============================
const API = "https://api.blaze.stream";
const headers = () => ({
  authorization: `Bearer ${ACCESS_TOKEN}`,
  "client-id": CLIENT_ID,
  "content-type": "application/json"
});

async function sendChat(channelId, message) {
  try {
    await axios.post(`${API}/v1/chats/messages`, { channelId, message }, { headers: headers() });
    console.log(`[${channelId}] BOT: ${message}`);
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

// ===============================
// TRANSLATE
// ===============================
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

// ===============================
// SOCKET
// ===============================
let socket = null;

function connectSocket() {
  if (socket) { try { socket.disconnect(); } catch(_) {} }
  socket = io("https://blaze.stream", { path: "/ws", transports: ["websocket"] });
  socket.on("connect", () => console.log("Socket connected ✅"));
  socket.on("connect_error", err => console.log("Socket error:", err.message));
  socket.on("eventsub", handleEvent);
}

const VALID_EVENT_TYPES = ["channel.chat.message", "channel.follow", "channel.vote"];

function subscribeAllChannels() {
  VALID_EVENT_TYPES.forEach(t => subscribe(t, BOT_CHANNEL_ID));
  const joined = Object.keys(channels).filter(id => id !== BOT_CHANNEL_ID);
  if (joined.length > 0) {
    console.log(`Auto-rejoining ${joined.length} channel(s)...`);
    joined.forEach(channelId => {
      console.log(`  -> ${channels[channelId].username}`);
      const allTypes = [
        "channel.chat.message", "channel.follow", "channel.vote",
        "channel.subscribe", "channel.subscription.gift",
        "channel.raid", "stream.online", "stream.offline"
      ];
      allTypes.forEach(t => subscribe(t, channelId));
    });
  }
}

// ===============================
// COMMAND HANDLER
// ===============================
async function handleCommand(channelId, user, msg, isBotChannel) {
  const m = msg.toLowerCase().trim();
  const ch = channels[channelId];
  const T = getMsg(channelId);

  // !join – only in bot channel
  if (m === "!join" && isBotChannel) {
    const slug = user.toLowerCase();
    const newChannelId = await getChannelIdBySlug(slug);

    if (!newChannelId) {
      await sendChat(BOT_CHANNEL_ID,
        `@${user} Couldn't find your channel. Make sure your Blaze username matches your channel slug!`
      );
      return;
    }

    if (channels[newChannelId]) {
      await sendChat(BOT_CHANNEL_ID,
        `@${user} I'm already active in your channel! Use !stats, !votes, !subs, !time, !emote, !explain [language] or !setbotlang [language] there 💚`
      );
      return;
    }

    getOrCreateChannel(newChannelId, user);
    const eventTypes = [
      "channel.chat.message", "channel.follow", "channel.vote",
      "channel.subscribe", "channel.subscription.gift",
      "channel.raid", "stream.online", "stream.offline"
    ];
    eventTypes.forEach(t => subscribe(t, newChannelId));

    await sendChat(BOT_CHANNEL_ID,
      `✅ @${user} Done! I've joined your channel 💚 Your viewers can now use: !stats | !votes | !subs | !time | !emote | !explain [language] | !setbotlang [language]`
    );
    await sendChat(newChannelId,
      `🤖 Hey chat! BlazeianBot is now active in ${user}'s channel! Type !cmd to see what I can do 💚🔥`
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
      if (isBotChannel) await sendChat(BOT_CHANNEL_ID, `👋😢 @${user} Done! I've left your channel... I'll miss you so much!! 💚`);
      delete channels[ownedChannelId];
      saveChannels();
    } else if (isBotChannel) {
      await sendChat(BOT_CHANNEL_ID, `@${user} I'm not in your channel. Use !join first!`);
    }
    return;
  }

  // Commands below only work in joined channels
  if (isBotChannel || !ch) return;

  // !setbotlang [language] – owner only
  if (m.startsWith("!setbotlang")) {
    const parts = msg.trim().split(/\s+/);
    const langInput = (parts[1] || "").toLowerCase();
    const langCode = LANG_CODES[langInput];

    if (!langCode) {
      await sendChat(channelId, T.langInvalid);
      return;
    }

    channels[channelId].language = langCode;
    saveChannels();
    const newT = MESSAGES[langCode] || MESSAGES["en"];
    await sendChat(channelId, newT.langSet(LANG_DISPLAY[langCode]));
    return;
  }

  // !stats
  if (m === "!stats") {
    const s = ch.stats;
    await sendChat(channelId,
      `📊 ${ch.username}'s Stats | 🗳️ Votes: ${s.totalVotes} | ⭐ Subs: ${s.totalSubs} | 💬 Msgs: ${s.totalChatMessages} | 🕐 Stream Time: ${formatTime(s.totalStreamMinutes)} | 🏆 Top Emote: ${getTopEmote(s)}`
    );
    return;
  }

  if (m === "!votes") { await sendChat(channelId, `🗳️ Total votes for ${ch.username}: ${ch.stats.totalVotes} 💚`); return; }
  if (m === "!subs")  { await sendChat(channelId, `⭐ Total subs for ${ch.username}: ${ch.stats.totalSubs} 💚`); return; }
  if (m === "!chat")  { await sendChat(channelId, `💬 Total chat messages tracked: ${ch.stats.totalChatMessages} 💚`); return; }
  if (m === "!time")  { await sendChat(channelId, `🕐 Total stream time for ${ch.username}: ${formatTime(ch.stats.totalStreamMinutes)} 💚`); return; }
  if (m === "!emote") { await sendChat(channelId, `🏆 Most used emote in ${ch.username}'s chat: ${getTopEmote(ch.stats)} 💚`); return; }

  // !cmd / !help
  if (m === "!cmd" || m === "!help") {
    await sendChat(channelId, T.cmdList);
    return;
  }

  // !explain [language]
  if (m.startsWith("!explain")) {
    const parts = msg.trim().split(/\s+/);
    const langInput = (parts[1] || "").toLowerCase();
    const langCode = LANG_CODES[langInput];

    if (!langInput || !langCode) {
      await sendChat(channelId, T.explainUsage(user));
      return;
    }

    const last3 = (ch.chatMemory || []).slice(-3);
    if (!last3.length) {
      await sendChat(channelId, T.noMessages(user));
      return;
    }

    const translated = await translateMessages(last3, langCode);
    const langName = LANG_DISPLAY[langCode] || langInput;

    if (translated) {
      await sendChat(channelId, `🌍 [${langName}] ${translated}`);
    } else {
      await sendChat(channelId, T.translateFail(user));
    }
    return;
  }

  // Greeting
  if (m.includes("hello") || m.includes("hi ") || m === "hi" || m.includes("hey ") || m === "hey") {
    await sendChat(channelId, T.greeting(user, ch.username));
    return;
  }
}

// ===============================
// EVENT HANDLER
// ===============================
async function handleEvent(message) {
  const { metadata, payload } = message;

  // SESSION START
  if (metadata.messageType === "session_welcome") {
    global.SESSION_ID = payload.sessionId;
    console.log("SESSION:", global.SESSION_ID);
    if (ACCESS_TOKEN) {
      await sendChat(BOT_CHANNEL_ID, "🤖💚 BlazeianBot is online! Type !join here to add me to your channel 🔥");
      setTimeout(subscribeAllChannels, 2000);
    } else {
      console.log("No token – visit /login");
    }
    return;
  }

  const channelId = payload.channelId || payload.condition?.channelId;

  // CHAT MESSAGE
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

      if (!msg.startsWith("!")) {
        if (!ch.chatMemory) ch.chatMemory = [];
        ch.chatMemory.push({ user, msg });
        if (ch.chatMemory.length > 10) ch.chatMemory.shift();
      }

      saveChannels();
    }

    if (msg.startsWith("!") || msg.toLowerCase().includes("hello") || msg.toLowerCase().includes("hi") || msg.toLowerCase().includes("hey")) {
      await handleCommand(channelId, user, msg, isBotChannel);
    }
    return;
  }

  // RAID
  if (metadata.subscriptionType === "channel.raid" && channelId && channels[channelId]) {
    const raider = payload.raider?.username || payload.raider?.displayName || "Someone";
    const T = getMsg(channelId);
    await sendChat(channelId, getRandom(T.raid(raider)));
    return;
  }

  // SUBSCRIPTION
  if (metadata.subscriptionType === "channel.subscribe" && channelId && channels[channelId]) {
    const user = payload.subscriber?.username || payload.subscriber?.displayName || "someone";
    channels[channelId].stats.totalSubs++;
    saveChannels();
    const T = getMsg(channelId);
    await sendChat(channelId, getRandom(T.sub(user)));
    return;
  }

  // GIFT SUBSCRIPTION
  if (metadata.subscriptionType === "channel.subscription.gift" && channelId && channels[channelId]) {
    const sender = payload.sender?.username || payload.sender?.displayName || "someone";
    const count = payload.giftCount || 1;
    channels[channelId].stats.totalSubs += count;
    saveChannels();
    const T = getMsg(channelId);
    await sendChat(channelId, getRandom(T.giftsub(sender, count)));
    return;
  }

  // VOTE
  if (metadata.subscriptionType === "channel.vote" && channelId && channels[channelId]) {
    const user = payload.voter?.username || payload.voter?.displayName || "someone";
    const amount = payload.amount || 1;
    channels[channelId].stats.totalVotes += amount;
    saveChannels();
    const T = getMsg(channelId);
    await sendChat(channelId, getRandom(T.vote(user, amount)));
    return;
  }

  // FOLLOW
  if (metadata.subscriptionType === "channel.follow" && channelId && channels[channelId]) {
    const user = payload.follower?.username || payload.follower?.displayName;
    if (user) {
      const T = getMsg(channelId);
      await sendChat(channelId, getRandom(T.follow(user)));
    }
    return;
  }

  // STREAM ONLINE
  if (metadata.subscriptionType === "stream.online" && channelId && channels[channelId]) {
    startStreamTimer(channelId);
    return;
  }

  // STREAM OFFLINE
  if (metadata.subscriptionType === "stream.offline" && channelId && channels[channelId]) {
    if (streamTimers[channelId]) { clearInterval(streamTimers[channelId]); delete streamTimers[channelId]; }
    saveChannels();
    return;
  }
}

// ===============================
// OAUTH ROUTES
// ===============================
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
  if (state && pendingState && state !== pendingState) return res.send("Error: State mismatch. Try /login again.");

  try {
    const tokenRes = await axios.post("https://blaze.stream/bapi/oauth2/token", {
      clientId: CLIENT_ID, clientSecret: CLIENT_SECRET,
      code, codeVerifier: pendingCodeVerifier,
      redirectUri: REDIRECT_URI, grantType: "authorization_code"
    });

    ACCESS_TOKEN  = tokenRes.data.accessToken;
    REFRESH_TOKEN = tokenRes.data.refreshToken;
    pendingState = null; pendingCodeVerifier = null;

    console.log("New token ✅");
    connectSocket();

    res.send(`
      <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
        <h1>✅ Login successful!</h1>
        <p>Save these in <strong>Render Environment Variables</strong>:</p>
        <p><strong>BLAZE_ACCESS_TOKEN:</strong><br>
        <textarea style="width:100%;height:60px;background:#222;color:#f5a623;border:1px solid #444;padding:8px;">${ACCESS_TOKEN}</textarea></p>
        <p><strong>BLAZE_REFRESH_TOKEN:</strong><br>
        <textarea style="width:100%;height:60px;background:#222;color:#f5a623;border:1px solid #444;padding:8px;">${REFRESH_TOKEN}</textarea></p>
        <p><a href="/" style="color:#f5a623;">→ Status page</a></p>
      </body></html>
    `);
  } catch (e) {
    res.send(`<pre>Token error: ${JSON.stringify(e.response?.data || e.message)}</pre><a href="/login">Retry</a>`);
  }
});

app.get("/", (req, res) => {
  const joinedList = Object.entries(channels)
    .map(([id, ch]) => `<li><strong>${ch.username}</strong> (${id}) – Lang: ${ch.language || "en"} | Msgs: ${ch.stats.totalChatMessages}, Subs: ${ch.stats.totalSubs}, Votes: ${ch.stats.totalVotes}</li>`)
    .join("") || "<li>No channels joined yet</li>";

  res.send(`
    <html><body style="background:#111;color:#fff;font-family:sans-serif;padding:40px;">
      <h1>🤖 BlazeianBot</h1>
      <p>Token: <strong>${ACCESS_TOKEN ? "✅ Active" : '❌ Missing – <a href="/login" style="color:#f5a623;">Login here</a>'}</strong></p>
      <h2>Joined Channels (${Object.keys(channels).length})</h2>
      <ul>${joinedList}</ul>
      <p><a href="/login" style="color:#f5a623;">🔑 Refresh token</a></p>
    </body></html>
  `);
});

app.get("/stats", (req, res) => res.json(channels));

// Admin: remove a channel by username
// Usage: https://blazeian-bot.onrender.com/admin/remove/mistersupercool
app.get("/admin/remove/:username", async (req, res) => {
  const username = req.params.username.toLowerCase();
  const channelId = Object.keys(channels).find(
    id => channels[id].username.toLowerCase() === username
  );
  if (!channelId) {
    return res.send(`❌ Channel "${username}" not found in database.`);
  }
  delete channels[channelId];
  await saveChannelsToCloud();
  res.send(`✅ Removed "${username}" (${channelId}) from database. They can !join again now.`);
});

// Admin: list all channels
app.get("/admin/list", (req, res) => {
  const list = Object.entries(channels).map(([id, ch]) =>
    `${ch.username} (${id}) – Lang: ${ch.language || "en"} | Msgs: ${ch.stats.totalChatMessages}`
  ).join("\n");
  res.send(`<pre>${list || "No channels"}</pre>`);
});

// ===============================
// START
// ===============================
app.listen(PORT, "0.0.0.0", async () => {
  console.log("Server running on port", PORT);
  channels = await loadChannelsFromCloud();
  console.log(`Loaded ${Object.keys(channels).length} channel(s) from cloud`);
  connectSocket();
});
