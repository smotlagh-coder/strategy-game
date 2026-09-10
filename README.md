# Nuclear War

Turn-based strategy game for **1 or 2 players**. Five nations — **US, UK, France, Russia, China** — with the rest controlled by AI.

## Rules

| Item | Cost / Effect |
|---|---|
| Starting capital | **$10M** each |
| Base income / round | **$3.5M** each living nation |
| Rounds | **5** |
| Nuclear Tech | **$5M** once — required before buying bombs |
| Nuclear bomb | **$2M** each |
| City shield | **$3M** — blocks one nuke (shield destroyed, city survives) |
| Research center | **$2M** — place on a city; that city earns **+$1.5M**/round (on top of base). Destroyed with the city. |
| Environment | **$1M** — world health **+10%** |
| Sanction | −**20%** total revenue for the target |
| Nuke used | World environment **−5%**, attacker env score hurt |

Meet the Leaders plays each nation’s voice briefing (they may be lying).

Each nation has **3 cities**. Unshielded hit = city destroyed. Lose all 3 cities = eliminated.

End-of-round score weights cities, research, shields, and environment contribution (green investments vs bomb use).

## Run

```bash
cd NuclearWar
npm install
npm run dev
```

Open the local URL Vite prints (usually `http://localhost:5173`).

## Play flow

1. Choose Single Player or Two Players (hot-seat)
2. Pick your nation(s)
3. Each turn: **Buy** → **Attack / Sanction** → End turn
4. After all nations act, review the scoreboard and continue

AI rivals prioritize nuclear tech, research income, shields, striking the score leader, and sanctioning the top nation.
