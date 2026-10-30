# Between Us

A word game for 2–8 people: one player knows a secret word, everyone else tries to guess it, and an AI watches the public chat.

## Run

Local play requires Node 22.13 or newer and has no dependencies or database. Hosted play uses GitHub Pages and Supabase.

```sh
cp .env.example .env  # only if you do not already have .env
# Add your OpenAI key to .env
npm start
```

Open http://localhost:5173. Create a room and share its code or invite link.

On phones connected to the same Wi-Fi, use `http://YOUR-COMPUTERS-LAN-IP:5173`. Copying an invite from localhost works only on that computer; open the LAN address first when inviting phones. `HOST` defaults to `0.0.0.0`; use `127.0.0.1` for access only on your computer. For testing two players on one computer, open two independent tabs (sessions are stored per tab).

The server reads `.env` at startup. Restart after changing the key or model. Real `.env` files are ignored by Git and never served to the browser. An OpenAI key is required to generate a new secret word for each round; there is no fixed word-list fallback. A failed AI request produces an unscored round.

## Play

1. The host starts a two-minute round. One player privately receives a word; roles rotate each round.
2. Everyone can chat. Each guesser can **lock an answer at any point during the discussion**, while the timer is running. Answers stay private and cannot be changed. The cluegiver already knows the word and does not submit a guess.
3. As soon as every guesser locks in, chat freezes and the observer makes one guess using the public conversation only. The server does this automatically; no player needs to press reveal.
4. All answers appear together after the observer finishes. Humans win if every guesser matches the word and the AI misses.
5. If time runs out first, the server closes answers and asks the observer to guess. A missing answer counts as a miss.

Capitalization, extra whitespace and trailing punctuation do not matter. After all final guesses are locked, a separate OpenAI Decisions request (`gpt-6-luna`) accepts synonyms, equivalent everyday names, inflected forms and small unambiguous typos. For example, “õhuniisuti” counts for “õhuniisutaja”. Merely related objects or broader categories do not count. The same rules apply to humans and AIs, including the revealed guess timeline, and feed the adaptive difficulty calculation. Exact answers and blanks need no request; other distinct guesses are checked together. If the meaning check fails, the round is unscored, unresolved answers show `?`, and difficulty stays unchanged. The referee sees the target and frozen guesses only; none of its input or output goes to the player models. Saying the actual word is allowed, but will usually give it away to the observer.

## Files

- `server.mjs`: HTTP server, `.env` loading and static files.
- `game.mjs`: rooms in memory, roles, timer, private answers and scoring.
- `observer.mjs`: server-side OpenAI request and optional practice bot.
- `answer-judge.mjs`: independent final answer comparison through the Decisions API.
- `public/`: plain HTML, CSS and JavaScript.
- `tests/`: game and HTTP integration checks (`npm test`).

Rooms disappear when the server restarts and expire after 12 hours without activity. Hosts can remove players between rounds. Host handoff, presence and public-service moderation are beyond this prototype. Limits: 8 players, 30 rounds, 100 messages per round, 1,000 simultaneous rooms. Run a single server process: rooms are not shared across processes.

## Solo mode (Estonian)

Choose **Üksi**, then **Alusta**. AI count is under **Seaded**. You are the observer. One AI knows an Estonian secret word; the others see only the public conversation. They keep talking in Estonian until **you lock your answer**, even if they are confident. There is no solo round timer. Locking immediately freezes chat, stops playback and cancels the pending public reply. Each AI guesser then independently submits a final private guess using the frozen conversation, without your answer or the secret. Results are revealed together. AI cluegiver roles rotate on replay.

Solo mode requires your existing `OPENAI_API_KEY`. **Heli sees / Heli väljas** toggles ElevenLabs audio; audio starts on when ElevenLabs is configured. Set `ELEVENLABS_API_KEY` and `ELEVENLABS_MODEL` (default `eleven_v3`) in `.env`. Optional `ELEVENLABS_VOICE_IDS` accepts three comma-separated IDs; otherwise the server selects distinct default voices from the account. Voice output uses `et` language settings and the model you configure. If speech fails, text continues and the UI shows an audio error. Secret words and private guesses are never sent for speech generation. Only future public replies are voiced when audio is on.

**Peata vestlus** pauses generation; **Jätka vestlust** resumes. Leaving a solo view pauses it. If the browser stops polling for 30 seconds, the server pauses automatically. A maximum of 200 recent messages and their audio are retained in memory in a very long solo round. The original multiplayer mode remains available.

Configured solo voices, in player order: **Martin** (`h4Y9LTN9ES7xSQRnyhC9`), **Liisa** (`xd3ufyLcuKKZZXDZO9H7`), **Rasmus** (`3jMasSOd05IQvSnHSd6B`). Two-AI mode uses Martin and Liisa. Names and voices stay together when cluegiver roles rotate.

### Private guess progression

Each solo guesser now returns a private word guess alongside its public reply. A separate smaller-model request supplies that guess; the dialogue still uses the main model. The server records it only when that reply is actually published, labeled with how many public messages the AI had seen. These intermediate guesses are not sent to other AIs, spoken by ElevenLabs, or included in the browser’s room response during play. After the round, **Millal AI sõna tabas?** shows each guesser’s sequence, correctness and final answer. This records word predictions, not internal reasoning or a measure of certainty. New rounds clear the active progression; previous completed rounds retain theirs. Up to 200 intermediate guesses are retained in a long round.

### Models and generated words

`OPENAI_MODEL` handles natural dialogue and independent word generation. `OPENAI_GUESSER_MODEL` handles only private intermediate and final word guesses (default `gpt-5.4-nano`). A speaking guesser makes two separate requests with the same public evidence: the dialogue model writes the message and the smaller guesser model chooses a word. The dialogue model’s output is never used as the private guess.

Every round, including multiplayer rounds, makes a fresh isolated word-generation request before play starts. The model generates 12 distinct candidates; Node then uses cryptographic randomness to pick one valid, unused word. The shortlist is regenerated every round and is never sent to players. There is no fixed answer pool, hardcoded category, topic rotation or letter restriction. The last 500 selected words are excluded across all rooms, alongside the current room's history. The server also checks for picks made by concurrent rounds and retries once if the model returns only unusable or repeated candidates. This recent-word memory resets when the server restarts; no database or history file is added. Selection is uniform over the valid shortlist, not over the entire dictionary; model vocabulary preferences can still affect the candidates.

The word request has no conversation ID, public chat or player context. It receives only the language, difficulty, exclusion list and a fresh nonce. Only the selected cluegiver receives the single chosen word. The other players never receive the shortlist. Generation errors return to the lobby with a visible error; no fallback secret is selected.

Difficulty adapts on a numeric 1–10 scale, starting at 5. A correct human answer raises the next round by 1 (including when everyone is correct). If only any AI guesses correctly it stays the same. If no one gets it right it decreases by 1. Failed/unscored rounds do not change it. Values stay within 1–10. In multiplayer, any correct human guess raises difficulty; otherwise the observer's correct guess holds it steady. **Seaded → Algraskus** selects the starting level. The completed round's level and the next level appear inside the collapsed guess history.

### Compact interface

The play screen keeps only the conversation, a small sound/pause/leave toolbar and the answer dock. The dock stays visible while messages scroll inside their own panel, including at a 390×680 viewport. Solo setup starts the round in one tap; AI count and word difficulty are under **Seaded**. Results show the word, submitted answers and **Järgmine voor**; guess history and the transcript are collapsed until requested. Repeated role, mode, status and explanation panels have been removed.


## Hosting: GitHub Pages + Supabase

The frontend runs on GitHub Pages; Supabase Edge Functions run the game and provider requests. Rooms are stored in private Postgres tables and audio in a private Storage bucket. OpenAI and ElevenLabs keys stay in Edge Function secrets. The local `npm start` server still uses rooms in memory and needs no Supabase access.

### Backend deployment

1. Add `SUPABASE_ACCESS_TOKEN` to your existing `.env` (create a personal token at https://supabase.com/dashboard/account/tokens). The project defaults to `jqxtqditbnuggbkronng`; set `SUPABASE_PROJECT_REF` to use another project.
2. Keep the existing OpenAI and ElevenLabs settings in `.env`.
3. Run `npm run deploy:backend`. It applies SQL migrations once, uploads only provider settings, and deploys `game` and `audio` with the official Supabase CLI. Node and network access are required; Docker is not.

To limit browser origins, set `ALLOWED_ORIGINS=https://martin-arusalu.github.io,http://localhost:5173` before redeploying. The prototype otherwise permits any origin and uses each player's random bearer token for their seat. New rooms are limited to 40 per IP per hour. There are no user accounts.

### Frontend deployment

Add these public settings to your local `.env`:

- `PUBLIC_SUPABASE_URL=https://jqxtqditbnuggbkronng.supabase.co`
- `PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the project's publishable key (or legacy `anon` key), never a secret or service-role key.

With GitHub CLI (`gh`) signed in and the repository set as `origin`, run:

```sh
npm test
npm run deploy:pages
```

The command builds `dist/`, pushes only its six static files to `gh-pages`, and configures GitHub Pages to serve that branch. The source stays on `main`. No Actions workflow permission is needed. The initial Pages site must already exist in repository **Settings → Pages**; this project has been configured.

The site is `https://martin-arusalu.github.io/between-us/`. `.env`, backend source and provider keys are excluded from the published site. `public/config.js` stays empty for local Node play; `dist/config.js` contains only the public Supabase endpoint and publishable key. Use `npm run build` to produce static files without publishing.

### Hosted runtime

Each browser poll can reserve one short job: create a word, generate one spoken turn, or resolve the round. A database revision and expiring job lease prevent concurrent browsers from generating duplicate turns. Locking an answer or pausing invalidates the previous job, so late replies cannot enter the transcript. A provider request already in progress may finish after pausing, but its result is discarded. Lost workers can retry after their two-minute lease expires.

Discussions continue while the observer's browser polls. Closing it stops further turn generation; reopening after 30 seconds pauses the round until resumed. Multiplayer deadlines resolve on the first request after expiry. Rooms expire after 12 inactive hours and expired rows are removed on new-room creation. Selected-word exclusions persist across workers (last 500 words). Audio from the preceding round is deleted when the next round starts; final-round audio remains in private Storage until cleaned up. For extended public hosting, add scheduled expired-audio cleanup.

Run `npm test` for both backends and Pages packaging. With Deno installed, `deno check --node-modules-dir=auto supabase/functions/game/index.ts supabase/functions/audio/index.ts` checks Edge entry points.
