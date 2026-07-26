# CareerOS Render Service (Phase 4)

A headless-browser render service. It loads a JS-only career page in a real
Chromium and returns the rendered HTML. That HTML then flows through the **exact
same** deterministic pipeline as every other source in CareerOS:

```
render service → rendered HTML → extractCareerPage (SAME extractor)
  → validate → snapshot (replayable) → ingest (fingerprint dedup, embed)
  → Opportunity Score → Browse / Today / Telegram
```

There is **no new extraction logic here** — this service only produces DOM. The
workers do the rest, identically to a static fetch. Adding a renderer is adding a
source, not a pipeline.

## Why a separate service?

Chromium needs far more RAM than the 1 vCPU / 2 GB API box has. Running it here,
on its own box, keeps the API/worker box light. The workers call this over HTTP
and stay unchanged.

## API

- `POST /render` — body `{ "url": "https://acme.com/careers", "waitUntil": "networkidle" }`
  → `{ "html": "<!doctype html>…", "status": 200, "finalUrl": "…" }`
  Requires header `x-render-token: <RENDER_SERVICE_TOKEN>` if that env var is set.
- `GET /health` → `{ "ok": true, "pages": <in-flight> }`

## Run it

```bash
docker build -t careeros-renderer services/renderer
docker run -d --name careeros-renderer -p 4000:4000 \
  -e RENDER_SERVICE_TOKEN=choose-a-secret \
  --shm-size=1g \
  careeros-renderer
```

Then, on the **workers** box, set and restart:

```bash
RENDER_SERVICE_URL=http://<renderer-host>:4000
RENDER_SERVICE_TOKEN=choose-a-secret   # must match the renderer
```

That's the entire activation. Until `RENDER_SERVICE_URL` is set, the `render-extract`
worker is a clean no-op — nothing to undo, nothing to break.

## Config (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | `4000` | HTTP port |
| `RENDER_SERVICE_TOKEN` | _(none)_ | shared secret; if set, `/render` requires the header |
| `RENDER_MAX_CONCURRENCY` | `2` | max simultaneous page renders (guards RAM) |
| `RENDER_NAV_TIMEOUT_MS` | `30000` | navigation timeout |
| `RENDER_SETTLE_MS` | `1200` | extra wait after networkidle, for late XHR-driven job lists |

## How pages reach the render tier

The static `career-extract` worker flags a company (`needsRender = true`) when it
fetches a page that is an obvious JS app shell — a framework root marker, almost
no anchors, almost no text (`looksJsRendered`, precision-first). The
`render-extract` worker then claims those flagged pages (rotating by
`lastRenderedAt`), renders them here, and runs the same extractor. Jobs found
this way carry the source `career-render-<extractorVersion>` and get their own
Source-Trust baseline.
