# BlazeianBot 🤖💚

A live AI chat agent for [Blaze.stream](https://blaze.stream) — built for the **Blaze Builder Challenge**.

**Live:** [blazeian-bot.onrender.com](https://blazeian-bot.onrender.com) · **Add it to your channel:** [blaze.stream/blazeian_bot_ai](https://blaze.stream/blazeian_bot_ai) (type `!join`)

## What it does

BlazeianBot isn't a canned-response bot — it actually reads what people say and replies in character, using a real LLM (Groq/Llama) grounded in the official Blaze API.

- **Real conversation** — tag `@blazeian_bot_ai` and it understands and replies contextually, in the language it was addressed in
- **Live web search** — for real, current-world questions (news, scores, results) it looks them up live and answers honestly, citing what it found
- **Stream alerts with personality** — follows, subs, gifted subs, votes, tips and raids are all celebrated with a fresh, AI-generated shoutout, never a repeated line
- **Live translation** — `!explain [language]` translates recent chat into 18 languages
- **Per-channel custom commands** — streamers add their own via a dashboard, no code required
- **Streaming schedule** — owner sets it once with `!setschedule`, viewers check it anytime with `!schedule`
- **Tip-for-a-reward tiers** — owners running a "tip $X for Y" promo set their own tiers with `!settiptier`, and the bot calls out the actual reward earned in the celebration
- **Stats tracking** — `!stats` shows votes, subs, chat activity, top emote per channel
- **Adjustable chat volume** — owner sets `!setcommentmode low/regular/heavy` to control how often event celebrations post a message, for quieter chat during busy streams
- **BlazeianBot Adventures comics** — an evolving comic series unlocked for crew members at `/comics`, with a free weekly giveaway entry for using the bot
- **Crew leaderboards** — ask "who has the most votes/subs in the crew?" and it answers with real, current numbers across every channel it's in, never a guessed name
- **Public crew leaderboard** — a live, ranked "Most Active Blazeian Users" board right on the homepage, updated automatically from real chat/vote/sub activity
- **Free OBS overlays** — an animated emote wall, a live viewer counter, and an animated running/reacting mascot, all as simple Browser Source URLs
- **Self-learning channel profiles** — the bot quietly picks up on each community's own slang and vibe over time, so it sounds like a regular, not a guest
- **Automatic follow-back & channel onboarding** — one `!join` (or one follow) sets a streamer up completely, including followers-only chat access

Every streamer manages only their own channel from their own dashboard — the bot never mixes context between channels.

## How it's built

- **Node.js + Express**, talking to the [official Blaze API](https://dev.blaze.stream/) over both REST and a real-time Socket.IO event stream
- **Two independent Socket.IO sessions** — one for app-token events (chat, raids, stream status), one for user-token-only events (follows, votes, subs, gifts, tips) — so a problem on one can never take down the other
- **Groq (Llama 3.3 / 3.1)** for the conversational brain and event shoutouts
- **Tavily Search API** for live, current-world facts
- State (channels, stats, settings) is persisted to this same repo's `state.json` via the GitHub API — no separate database

## Status

Actively developed and running live 24/7 across 45+ Blaze channels, completely free for every streamer who joins.

Built by [Brachial513](https://x.com/BRACHIAL513) — founder of the GMC (Geile Menschen Community) — steering the product with an AI coding assistant as build partner.
