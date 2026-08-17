# BlazeianBot 🤖💚

A live AI chat agent for [Blaze.stream](https://blaze.stream) — built for the **Blaze Builder Challenge**.

**Live:** [blazeian-bot.onrender.com](https://blazeian-bot.onrender.com) · **Add it to your channel:** [blaze.stream/blazeian_bot_ai](https://blaze.stream/blazeian_bot_ai) (type `!join`)

## What it does

BlazeianBot isn't a canned-response bot — it actually reads what people say and replies in character, using a real LLM (via Groq) grounded in the official Blaze API.

- **Real conversation** — tag `@blazeian_bot_ai` and it understands and replies contextually, in the language it was addressed in
- **Live web search** — for real, current-world questions (news, scores, results) it looks them up live and answers honestly, citing what it found
- **Stream alerts with personality** — follows, subs, gifted subs, votes, tips and raids are all celebrated with a fresh, AI-generated shoutout, never a repeated line
- **Live translation** — `!explain [language]` translates recent chat into 18 languages
- **Live weather** — ask for any city and get it back in both °C and °F, so nobody has to convert anything
- **Knows its limits** — asked about Blaze-internal status (verification progress, how many subs someone still needs), it answers honestly and cheers you on instead of pretending to look it up or inventing numbers
- **Per-channel custom commands** — streamers add their own via a dashboard, no code required
- **Streaming schedule** — owner sets it once with `!setschedule`, viewers check it anytime with `!schedule`
- **Tip-for-a-reward tiers** — owners running a "tip $X for Y" promo set their own tiers with `!settiptier`, and the bot calls out the actual reward earned in the celebration
- **Stats tracking** — `!stats` shows votes, subs, chat activity, top emote per channel
- **Adjustable chat volume** — owner sets `!setcommentmode silent/low/regular/heavy` to control how chatty the bot is; `silent` = it only ever speaks when directly @tagged (no auto-chat, greetings or event shoutouts), for streamers who want it fully out of the way during busy games
- **Resettable game lock** — `!game NAME` locks in the current game; `!game off` clears it again so the bot stops assuming a stale game
- **BlazeianBot Adventures comics** — an evolving comic series unlocked for crew members at `/comics`, with a free weekly giveaway entry for using the bot
- **Crew leaderboards** — ask "who has the most votes/subs in the crew?" and it answers with real, current numbers across every channel it's in, never a guessed name
- **Public crew leaderboard** — a live, ranked "Most Active Blazeian Users" board right on the homepage, updated automatically from real chat/vote/sub activity
- **Free OBS overlays** — an animated emote wall, a live viewer counter, an animated running/reacting mascot, and a live Blaze chat overlay, all as simple Browser Source URLs
- **Blaze chat overlay** — your Blaze chat pops onto stream as transient, styled popups straight from a Browser Source URL (`/overlay/chat/NAME`, tunable size/duration/max-lines/position); a robust, self-hosted alternative to tools that scrape Blaze's web page and break on every Blaze update, since the bot rides Blaze's real event connection instead
- **Self-learning channel profiles** — the bot quietly picks up on each community's own slang and vibe over time, so it sounds like a regular, not a guest
- **Automatic follow-back & channel onboarding** — one `!join` (or one follow) sets a streamer up completely, including followers-only chat access
- **Personal opt-out** — anyone can type `!ignoreme` to stop the bot replying to them specifically, in any channel, no streamer involvement needed
- **Person memory** — the bot recognises crew streamers everywhere automatically, and quietly builds up short notes on the regulars it talks to, so it knows who it's speaking to without anyone maintaining a list
- **Setup nudges** — once per channel, on a quiet moment, it offers the owner a feature they haven't set up yet instead of waiting to be read about
- **Giveaway awareness** — it knows the real details of the weekly crew giveaway (entries, prizes, past winners) and drops a fitting one into conversation, never invented
- **Knows when to stay quiet** — tell it to leave you alone and it actually does, it won't welcome people who were already in chat, and it won't name someone the conversation never mentioned
- **Ignore list** — the operator can have the bot completely ignore a specific person everywhere (no greeting, no smalltalk, no reply), with one exception: a direct insult at the bot unlocks a single sharp, witty clap-back

Every streamer manages only their own channel from their own dashboard — the bot never mixes context between channels.

## How it's built

- **Node.js + Express**, talking to the [official Blaze API](https://dev.blaze.stream/) over both REST and a real-time Socket.IO event stream
- **Two independent Socket.IO sessions** — one for app-token events (chat, raids, stream status), one for user-token-only events (follows, votes, subs, gifts, tips) — so a problem on one can never take down the other
- **Groq** — GPT-OSS-120B for real chat replies, GPT-OSS-20B for background work & event shoutouts (both at low reasoning effort)
- **Tavily Search API** for live, current-world facts
- State (channels, stats, settings) is persisted to this same repo's `state.json` via the GitHub API — no separate database

## Status

Actively developed and running live 24/7 across 55+ Blaze channels, completely free for every streamer who joins.

Built by [Brachial513](https://x.com/BRACHIAL513) — founder of the GMC (Geile Menschen Community) — steering the product with an AI coding assistant as build partner.
