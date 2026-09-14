# Nuclear War

Strategy game for **Kian** — turn-based nuclear strategy for **1–5 players**. Five nations — **US, UK, France, Russia, China** — with empty seats filled by AI.

Repo: [smotlagh-coder/strategy-game](https://github.com/smotlagh-coder/strategy-game)

## Rules

| Item | Cost / Effect |
|---|---|
| Starting capital | **$10M** each |
| Base income / round | **$3.5M** each living nation (from round 2) |
| Rounds | **5** |
| Nuclear Tech | **$5M** once — bombs available the following round |
| Nuclear bomb | **$2M** each (max 3 purchased per round) |
| City shield | **$3M** — blocks one nuke (shield destroyed, city survives) |
| Research center | **$2M** — place on a city; that city earns **+$1.5M**/round. Destroyed with the city. |
| Environment | **$1M** — world health **+10%** (once per round) |
| Sanction | −**20%** total revenue for the target |
| Nuke hit | World environment **−5%** |

Each nation has **3 cities**. Unshielded hit = city destroyed. Lose all 3 cities = eliminated — eliminated nations keep their score on the board but **cannot become the superpower**.

**Mutual Destruction** only when world environment hits **0%**. Otherwise a living nation always becomes the superpower (ties broken by cities / survival points).

Strikes are queued during turns and resolve together at round end. Survival score awards **10 pts × cities still standing** each round.

## Run

```bash
npm install
cp .env.example .env   # fill Firebase web config for online play
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:5173`).

Without Firebase env vars, **Single** and **Hot-seat** still work; **Online Multiplayer** stays disabled.

## Firebase (online multiplayer)

Used for sessions, presence, invites, live games, and the superpower leaderboard.

1. Create a Firebase project (or use GCP project `personal-planner-api`).
2. Enable **Anonymous Authentication** and **Cloud Firestore**.
3. Deploy rules from the repo root:

```bash
firebase deploy --only firestore:rules
```

4. Copy the web app config into `.env` (`VITE_FIREBASE_*` — see `.env.example`).
5. Enable **Blaze** (pay-as-you-go) so Auth/Firestore work in production; set GCP **budget alerts** at $5 and $20. Light family usage should stay near **$0**/mo inside free quotas.

### Online flow

1. Enter commander name (stored in session / `localStorage`).
2. Choose **Online Multiplayer** → lobby.
3. Create a lobby, invite available players (2–5 humans). Players **In game** are marked and not inviteable.
4. Host starts → nations assigned, AI fills empty seats → shared Firestore game sync.
5. Wins increment the superpower **Leaderboard**.

## Deploy (GCP App Engine)

Pushes to `main` (or a manual **Actions → Deploy to GCP App Engine** run) build and deploy via GitHub Actions.

Auth matches the Personal-planner GCP pattern: a base64 service-account key plus project id.

### One-time setup

1. In GCP, create/select a project and enable **App Engine** (`gcloud app create --region=us-central1` if needed).
2. Create a service account with **App Engine Admin** and **Storage Admin** (for staging uploads), and download a JSON key.
3. In the GitHub repo → **Settings → Secrets and variables → Actions**, add:
   - `GCLOUD_PROJECT_ID` — your GCP project id
   - `GCLOUD_SERVICE_KEY` — the service-account JSON, base64-encoded:

```bash
base64 -i service-account.json | pbcopy   # macOS
```

4. For production online play, also set the `VITE_FIREBASE_*` values in the GitHub Actions build (repository variables or secrets) so the client bundle includes Firebase config.
5. Push to `main` (or run the workflow manually). App Engine runs `gcp-build` (`npm run build`) then `npm start` (serves `dist` on `$PORT`).

## Play flow

1. Enter your name (session)
2. Choose Single, Hot-seat (2P), or Online Multiplayer
3. Pick nation(s) / invite players
4. Each turn: answer purchase prompts (tech, research, bombs, shield, environment, sanctions), then lock strike targets
5. After all nations act, watch simultaneous strikes, review treasury + scores on the aftermath board
