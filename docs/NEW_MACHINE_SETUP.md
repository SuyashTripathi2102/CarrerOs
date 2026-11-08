# New Machine Setup

Two paths: **moving an existing CareerOS** to a new laptop (keeps all your data), or a **fresh
install** with an empty database. On macOS/Linux, skip the WSL/winget specifics and install
Node/Python/Docker natively; the migration scripts are Windows-only.

## 1. Install prerequisites (both paths)

```powershell
winget install -e --id Git.Git
winget install -e --id Python.Python.3.12   # 3.12 specifically: 3.14 cannot build pydantic-core

# WSL2 (needs admin; REBOOT required after)
wsl --install --no-launch

# Docker Desktop (needs admin)
winget install -e --id Docker.DockerDesktop
```

Install **Node 24** from nodejs.org (the version CareerOS runs on today).

**Reboot**, then launch Docker Desktop once: accept the license and wait until the whale icon in
the tray is steady.

## 2A. Moving an existing install

On the **old** laptop, with the API and workers stopped and Docker running:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/backup.ps1
powershell -ExecutionPolicy Bypass -File scripts/verify-restore.ps1
powershell -ExecutionPolicy Bypass -File scripts/migrate-export.ps1 -Destination D:\CareerOS-Transfer
```

The export contains live credentials, so encrypt the card first: in File Explorer, right-click
the card → **Turn on BitLocker**. Then copy `CareerOS-Transfer` onto it.

On the **new** laptop, copy the folder off the card and run this from inside it:

```powershell
powershell -ExecutionPolicy Bypass -File .\migrate-import.ps1 -RepoRoot D:\CarrerOs
```

Use any other path if there is no D: drive. The import clones the repo, restores your files,
installs dependencies, restores Postgres and MinIO, checks every table against the old laptop,
and registers the scheduled tasks. It is safe to re-run and never overwrites a database that
already has tables.

Wait for `IMPORT VERIFIED` before wiping anything. Then:

1. On the old laptop, stop CareerOS and disable its tasks. Two running copies send duplicate
   Telegram messages and double the AI spend:
   ```powershell
   'CareerOS-Backup','CareerOS-Phase0-Baseline','CareerOS-Stack-Watchdog' | ForEach-Object { Disable-ScheduledTask -TaskName $_ }
   docker compose stop
   ```
2. On the new laptop, sign in to OneDrive so backups leave the machine, and start the stack:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/ensure-stack.ps1
   ```
3. Smoke test: `curl http://localhost:3001/api/health` → `{"status":"ok",...}`.
4. Telegram's **Applied** button needs a public URL registered with Telegram's `setWebhook`. That
   URL points at whatever exposed the old laptop, so register a new one if you use the button.

## 2B. Fresh install (empty database)

Use the pinned npm. Bare `npm` at 11.16+ silently skips the Prisma, bcrypt and sharp postinstalls
and produces a broken Prisma client.

```powershell
git clone https://github.com/SuyashTripathi2102/CarrerOs.git
cd CarrerOs
npx --yes npm@11.12.1 ci
npx --yes npm@11.12.1 run build --workspace=@careeros/shared   # api imports its built output

Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/workers/.env.example apps/workers/.env
Copy-Item apps/scraper/.env.example apps/scraper/.env

npm run docker:up        # Postgres+pgvector :5432, Redis :6379, MinIO :9000/:9001
cd apps/api
npx prisma generate
npx prisma migrate deploy   # deploy, not dev: applies committed migrations only
```

Never run `.env.example` over an existing `.env`, and never run `migrate deploy` before restoring
a dump: restore into the empty database first, then migrate.

## 3. Run by hand

```bash
# api (localhost:3001, routes under /api)
cd apps/api && npm run start:dev

# web (localhost:3000)
cd apps/web && npm run dev

# workers
cd apps/workers && npm run dev

# scraper (Python 3.12)
cd apps/scraper
py -3.12 -m venv .venv && ./.venv/Scripts/activate
pip install -r requirements.txt
python -m app.worker
```

Redis does not need to be moved. Workers re-register every schedule at boot
(`apps/workers/src/index.ts`).

## 4. Resuming work with Claude

The import restores Claude's memory, session history, skills and claude-mem database. Reinstall
the claude-mem plugin and the CLIs listed in `~/.claude/INSTALLED_TOOLS.md`, then open Claude Code
in the repo and say: read `docs/HANDOFF.md` and continue. On a fresh install the handoff document
is the only context available.
