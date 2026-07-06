import asyncio

from bullmq import Worker

from app.config import settings
from app.queues.names import SCRAPE_HARD_TARGET


async def process(job, token):
    company_id = job.data.get("companyId")
    url = job.data.get("url")
    print(f"[scrape-hard-target] received job {job.id} for company {company_id} ({url})")
    # TODO Phase 4: call app.fetchers.playwright_fetcher.fetch_rendered_page,
    # parse the result, POST normalized jobs back to the NestJS internal API
    # (settings.api_internal_url) rather than writing to Postgres directly —
    # NestJS/Prisma stays the single owner of the schema.
    return {"status": "stub"}


async def main() -> None:
    worker = Worker(SCRAPE_HARD_TARGET, process, {"connection": settings.redis_url})
    print(f"JobIntel scraper worker listening on '{SCRAPE_HARD_TARGET}'")
    try:
        await asyncio.Event().wait()
    finally:
        await worker.close()


if __name__ == "__main__":
    asyncio.run(main())
