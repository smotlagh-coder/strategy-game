# Nuclear War

> I dedicate this game to my son, **Kian**, whom I love more than anything in this world.
> I made it for him, to learn about strategy and planning.

Turn-based nuclear strategy for **1–5 players**. Twelve countries — **US, UK, France, Russia, China, India, Pakistan, Iran, North Korea, Canada, Brazil, Australia** — five seated per match, with empty seats filled by AI.

Repo: [smotlagh-coder/strategy-game](https://github.com/smotlagh-coder/strategy-game)

**Current GCP / Firebase project:** `personal-planner-api`  
**Firestore database (Native):** `nuclear-war`  
**App URL (after deploy):** `https://personal-planner-api.uc.r.appspot.com`

---

## Rules

| Item | Cost / Effect |
|---|---|
| Starting capital | **$14M** each |
| Base income / round | **$5M** each living nation (from round 2) |
| Rounds | **5** |
| Nuclear Tech | **$4M** once — warheads can be built and fired the same round |
| Nuclear bomb | **$2M** each (max 3 purchased per round) |
| Aerospace Tech | **$2M** once — drone packs can be built and flown the same round |
| Drone pack | **$1M** each (max 3 purchased per round) |
| City shield | **$3M** — blocks one nuke (shield destroyed, city survives). **One install per nation per round** |
| Laser defence | **$2.5M** per city — needs Aerospace Tech; shoots down every drone swarm sent at that city |
| Underground City | **$6M** — one city per nation, permanently: nukes cannot destroy it and it never needs a shield |
| Rebuild city | **$5M** — raise a burnt city from the rubble, bare (no shield, research or bunker) |
| Research center | **$2M** — place on a city; that city earns **+$1.5M**/round. Destroyed with the city. |
| Environment | **$1M** — world health **+10%** (once per round) |
| Sanction | −**10%** total revenue for the target |
| Nuke hit | World environment **−5%** |
| Drone hit | Target owes **$1.5M** in repairs, billed at their next income — halved to **$0.75M** if the city has a shield or is underground, and **$0** if it has laser defence or the city is destroyed in the same round |

Every match seats **5 of the 12 countries**: each player's chosen country always plays, and the empty chairs are dealt at random from the countries nobody picked. In an online lobby a claimed country is locked to that player and greyed out for everyone else.

Each nation has **3 cities**. Unshielded hit = city destroyed. Lose all 3 cities = eliminated — eliminated nations keep their score on the board but **cannot become the superpower**.

Rubble is not final: any burnt city can be **rebuilt for $5M** on a later turn, and it comes back bare — the shield, research center and bunker are gone with the old city. A rebuilt city carries a golden shine so everyone can see it is new. If a nation's *last* city falls while its treasury still holds $5M, the rebuild happens automatically out of that money: the nation loses the cash instead of the war and plays on into the next round.

An **Underground City** is the one city nobody can take from you: bombs are not even selectable against it, and a bomb already in the air when it goes underground breaks against the rock. It cannot be eliminated, so the nation holding one is guaranteed a seat at the final scores — but drone swarms still bill it for repairs (at the halved defended rate), and the other two cities remain exposed.

**Mutual Destruction** only when world environment hits **0%**. Otherwise a living nation always becomes the superpower (ties broken by cities / survival points).

**Laser defence** is the answer to drones. Any city can take a battery for $2.5M once you hold Aerospace Tech, and from then on every swarm aimed at that city is shot out of the sky: no repair bill, and — because there is no swarm left circling — the city's shield stays free to stop a warhead sent in the same volley. The battery burns with the city if a nuke gets through, and a rebuilt city comes back without one.

Drones cannot level a city or break a shield on their own — they run up a repair bill, and a shield or bunker blunts the swarm enough to halve it. Their value is the combo: swarm a city you are also nuking and its shield is too busy to stop the warhead, so the city falls. Targeting runs bombs first, then drones. A repair bill only lands on a city that survives the round: if the warhead levels the city the swarm helped open, there is nothing left to repair and the bill is written off — the owner pays $5M to rebuild instead.

Strikes are queued during turns and resolve together at round end. Survival score awards **10 pts × cities still standing** each round.

**Nothing waits.** Buy Nuclear Tech and a warhead on your first turn and it lands at the end of that same round — the same goes for Aerospace Tech and drone packs. Shields are the one thing you cannot rush: a nation may install **one per round**, so no country walls off all three cities in a single turn and there is always something on the board worth shooting at. Between the $14M opening and $5M a round after it, every round can pay for a real move, which is what keeps the war spread across all five rounds instead of piling up in the last one.

AI nations play to win, not to look busy. They rank every rival by *projected* final score — points banked, cities still earning survival points each remaining round, research income and the arsenal pointed back at them — and aim at whoever is running away with the match, with a finishing shot reserved for anyone down to their last city and too broke to pay for the rebuild. They spend the opening turn on two research centres and a shield on the city they would hate most to lose, and from round 2 on they hold back the price of a warhead before anything else — a rival city left standing banks survival points every round. They rebuild rubble first (a city back on the board is the best value in the game), size their arsenal to the number of cities they can actually level this round (escorting a swarm in when the target is shielded), keep rebuild insurance in the bank when down to one city, and sanction every rival, since sanctions are free.

---

## Prerequisites

Install once on your Mac:

```bash
# Node (LTS)
brew install node

# Google Cloud CLI
brew install --cask google-cloud-sdk
gcloud auth login
gcloud config set project personal-planner-api

# Firebase CLI
npm install -g firebase-tools
firebase login

# GitHub CLI (for secrets / PRs)
brew install gh
gh auth login
```

---

## Local development

```bash
cd NuclearWar
npm install
cp .env.example .env   # then fill values (see Firebase section)
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173`).

Without Firebase env vars, **Single** and **Hot-seat** still work; **Online Multiplayer** stays disabled. Restart `npm run dev` after changing `.env`.

### Leader voices

The summit speeches in `public/sounds/*.wav` are recorded with OpenAI's speech model. Edit a line in `src/data/speeches.ts`, then re-cut the clip:

```bash
echo 'OPENAI_API_KEY=sk-...' >> .env.local   # gitignored
node scripts/record-voices.mjs australia     # or no argument for all twelve
```

Each leader's voice and accent direction lives in `DELIVERY` inside that script.

---

## Full setup (do this again from scratch)

Use one GCP project for App Engine + Firebase. This repo is wired to **`personal-planner-api`**.

### 1. Enable Firebase on the GCP project

1. Open [Firebase Console](https://console.firebase.google.com/) → **Add project** → use existing GCP project `personal-planner-api` (or create a new one).
2. Upgrade the project to **Blaze** (pay-as-you-go) so Auth/Firestore work in production.
3. In GCP Billing, set **budget alerts** at **$5** and **$20**. Light family usage should stay near **$0**/mo inside free quotas.

### 2. Register a Web app and get config

```bash
firebase use personal-planner-api

# List apps (or create one in Console: Project settings → Your apps → Web)
firebase apps:list --project=personal-planner-api

# Print web SDK config (replace APP_ID with the real id, e.g. 1:…:web:…)
firebase apps:sdkconfig WEB YOUR_APP_ID --project=personal-planner-api
```

Do **not** leave `APP_ID` / `$PROJECT_ID` as literal placeholders — that fails with “Failed to get WEB app configuration.”

Write values into `.env` (gitignored):

```bash
VITE_FIREBASE_API_KEY=…
VITE_FIREBASE_AUTH_DOMAIN=personal-planner-api.firebaseapp.com
VITE_FIREBASE_PROJECT_ID=personal-planner-api
VITE_FIREBASE_STORAGE_BUCKET=personal-planner-api.firebasestorage.app
VITE_FIREBASE_MESSAGING_SENDER_ID=…
VITE_FIREBASE_APP_ID=1:…:web:…
VITE_FIREBASE_FIRESTORE_DATABASE=nuclear-war
```

See `.env.example` for the full key list.

### 3. Enable Anonymous Authentication

Firebase Console → **Build → Authentication → Sign-in method** → enable **Anonymous**.

### 4. Cloud Firestore (Native mode)

This app needs **Firestore Native mode**. The Firebase CLI **cannot** manage a project whose **default** database is **Datastore mode**.

`personal-planner-api` already had Datastore-mode `(default)`, so we use a **second** Native database named **`nuclear-war`**:

```bash
gcloud firestore databases create \
  --database=nuclear-war \
  --location=us-central1 \
  --type=firestore-native \
  --project=personal-planner-api
```

- Region is permanent for that database — pick one and keep it.
- The app defaults to database id `nuclear-war` (`src/lib/firebase.ts` + `VITE_FIREBASE_FIRESTORE_DATABASE`).
- `firebase.json` deploys rules to database `nuclear-war`.

**If you start a brand-new Firebase project** with no existing DB: create Firestore in **Native** mode as `(default)`, set `VITE_FIREBASE_FIRESTORE_DATABASE=(default)`, and change `firebase.json` to the default database (or a single `"rules": "firestore.rules"` entry).

**Error you may see** (and the fix above):

```text
This project is using Cloud Firestore in DATASTORE_MODE.
The Firebase CLI can only manage projects using Cloud Firestore in Native mode.
```

### 5. Deploy security rules

From the repo root (`.firebaserc` already points at `personal-planner-api`):

```bash
firebase deploy --only firestore:rules --project=personal-planner-api
```

Rules live in `firestore.rules`.

### 6. App Engine (host the game)

Once per GCP project:

```bash
gcloud config set project personal-planner-api
gcloud app create --region=us-central1   # skip if App Engine already exists
```

Create a deploy service account (or reuse one) with roles:

- **App Engine Admin** (`roles/appengine.appAdmin`)
- **Storage Admin** (`roles/storage.admin`) — staging uploads

```bash
# Example — adjust names as needed
gcloud iam service-accounts create github-deploy \
  --display-name="GitHub Actions App Engine deploy"

gcloud projects add-iam-policy-binding personal-planner-api \
  --member="serviceAccount:github-deploy@personal-planner-api.iam.gserviceaccount.com" \
  --role="roles/appengine.appAdmin"

gcloud projects add-iam-policy-binding personal-planner-api \
  --member="serviceAccount:github-deploy@personal-planner-api.iam.gserviceaccount.com" \
  --role="roles/storage.admin"

gcloud iam service-accounts keys create ./gcloud-service-key.json \
  --iam-account=github-deploy@personal-planner-api.iam.gserviceaccount.com

base64 -i gcloud-service-key.json | pbcopy   # macOS — paste into GitHub secret
rm gcloud-service-key.json                  # do not commit the key
```

### 7. GitHub Actions secrets

Repo → **Settings → Secrets and variables → Actions** (or via `gh`):

```bash
# GCP deploy
gh secret set GCLOUD_PROJECT_ID --body "personal-planner-api"
gh secret set GCLOUD_SERVICE_KEY   # paste base64 when prompted

# Firebase client config (same values as .env)
gh secret set VITE_FIREBASE_API_KEY
gh secret set VITE_FIREBASE_AUTH_DOMAIN
gh secret set VITE_FIREBASE_PROJECT_ID
gh secret set VITE_FIREBASE_STORAGE_BUCKET
gh secret set VITE_FIREBASE_MESSAGING_SENDER_ID
gh secret set VITE_FIREBASE_APP_ID
gh secret set VITE_FIREBASE_FIRESTORE_DATABASE --body "nuclear-war"
```

Workflow: `.github/workflows/deploy-app-engine.yml`  
- Writes `.env` from secrets before App Engine build  
- Deploys with `gcloud app deploy app.yaml`

### 8. Deploy

Push to `main`, or **Actions → Deploy to GCP App Engine → Run workflow**.

App Engine runs `gcp-build` (`npm run build`) then `npm start` (serves `dist` on `$PORT`).

---

## Online multiplayer flow

1. Enter commander name (session / `localStorage`).
2. Choose **Online Multiplayer** → lobby.
3. Create a lobby, invite available players (2–5 humans). Players **In game** are not inviteable.
4. Host starts → nations assigned, AI fills empty seats → shared Firestore game sync.
5. Wins increment the superpower **Leaderboard**.

---

## Play flow

1. Enter your name (session)
2. Choose Single, Hot-seat (2P), or Online Multiplayer
3. Pick nation(s) / invite players
4. Each turn: answer purchase prompts (nuclear tech, aerospace tech, research, bombs, drones, underground city, rebuild, shield, laser defence, environment, sanctions), then lock bomb targets and drone targets
5. After all nations act, watch simultaneous strikes, review treasury + scores on the aftermath board

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Online mode disabled / Firebase errors | Missing or stale `.env`; restart Vite after edits |
| `DATASTORE_MODE` on `firebase deploy` | Default DB is Datastore; use Native DB `nuclear-war` (see §4) |
| `Failed to get WEB app configuration` | Used placeholder `APP_ID`; pass real `1:…:web:…` id |
| `gh: command not found` | `brew install gh` then `gh auth login` |
| Deploy fails missing GCLOUD_* | Set `GCLOUD_PROJECT_ID` + base64 `GCLOUD_SERVICE_KEY` |
| Production online broken, local OK | GitHub `VITE_FIREBASE_*` secrets missing from Actions build |
| Auth fails in browser | Anonymous sign-in not enabled in Firebase Console |
