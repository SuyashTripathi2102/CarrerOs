from fastapi import FastAPI

from app.config import settings

app = FastAPI(title="JobIntel Scraper Service")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


# This service's real "entrypoint" for scraping is app/worker.py (a BullMQ
# consumer), not HTTP routes — FastAPI here just exposes health/ops endpoints
# for container orchestration and manual debugging.
