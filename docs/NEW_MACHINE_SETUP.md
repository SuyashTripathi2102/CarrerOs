# New Machine Setup

Checklist for getting JobIntel running on a fresh Windows PC. (On macOS/Linux, skip the
WSL/winget specifics — install Node/Python/Docker natively.)

## 1. Install prerequisites

```powershell
# Node.js 22+ and Git (skip any already installed)
winget install -e --id OpenJS.NodeJS.LTS
winget install -e --id Git.Git
winget install -e --id Python.Python.3.12

# WSL2 (needs admin; REBOOT required after)
wsl --install --no-launch

# Docker Desktop (needs admin)
winget install -e --id Docker.DockerDesktop
```

**Reboot**, then launch Docker Desktop once — accept the license, wait until the whale icon in
the tray is steady.

## 2. Clone and install

```bash
git clone https://github.com/SuyashTripathi2102/JobIntel.git
cd JobIntel
npm install
npm run build --workspace=@jobintel/shared   # api imports its built output
```

## 3. Environment files (NOT in git)

Every service has a committed `.env.example` — copy each to `.env`:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/workers/.env.example apps/workers/.env
cp apps/scraper/.env.example apps/scraper/.env
```

Defaults work for local dev as-is. Secrets (JWT secret, AI API keys, SMTP creds) get added to
`apps/api/.env` from Phase 3 onward — those are never committed; keep a copy in a password
manager when they exist.

## 4. Infra + database

```bash
npm run docker:up        # Postgres+pgvector :5432, Redis :6379, MinIO :9000/:9001
cd apps/api
npx prisma generate
npx prisma migrate deploy   # applies committed migrations (deploy, not dev — no new migration)
```

## 5. Run

```bash
# api (localhost:3001, routes under /api)
cd apps/api && npm run start:dev

# web (localhost:3000)
cd apps/web && npm run dev

# workers
cd apps/workers && npm run dev

# scraper (Python)
cd apps/scraper
python -m venv .venv && ./.venv/Scripts/activate
pip install -r requirements.txt
python -m app.worker
```

Smoke test: `curl http://localhost:3001/api/health` → `{"status":"ok",...}`.

## 6. Resuming work with Claude

Claude's memory directory is per-machine and does not follow you. On the new PC, start Claude
Code in the repo and ask it to read `docs/PROJECT_LOG.md` and `ARCHITECTURE.md` before doing
anything — together they contain the full project state, decisions, and the phase-gate process.
