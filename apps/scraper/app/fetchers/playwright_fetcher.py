"""Phase 4 stub. This is where career-page targets that need real browser
rendering, JS-heavy SPAs, or anti-bot handling (e.g. Workday, custom sites)
get fetched — using Playwright with stealth patches, as opposed to the plain
httpx+JSON calls the Node workers make against Greenhouse/Lever/Ashby's
public APIs directly.
"""

from typing import TypedDict


class ScrapeResult(TypedDict):
    url: str
    html: str | None
    status: str  # "ok" | "blocked" | "error"


async def fetch_rendered_page(url: str) -> ScrapeResult:
    # TODO Phase 4: launch Playwright (chromium, stealth context), navigate,
    # wait for network idle / job-list selector, return rendered HTML.
    raise NotImplementedError("Playwright fetcher is implemented in Phase 4")
