# Nuclear War

Strategy game for **Kian** — turn-based nuclear strategy for **1 or 2 players**. Five nations — **US, UK, France, Russia, China** — with the rest controlled by AI.

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

Strikes are queued during turns and resolve together at round end. Survival score awards **10 pts × cities still standing** each round.

## Run

```bash
npm install
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:5173`).

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

4. Push to `main` (or run the workflow manually). App Engine runs `gcp-build` (`npm run build`) then `npm start` (serves `dist` on `$PORT`).

## Play flow

1. Choose Single Player or Two Players (hot-seat)
2. Enter names (2P) and pick your nation(s)
3. Each turn: answer purchase prompts, then lock strike targets
4. After all nations act, watch simultaneous strikes, then review the aftermath board
