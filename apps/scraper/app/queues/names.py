"""Queue name constants shared with apps/workers/src/queues/names.ts.
Both sides must stay in sync — this is the only queue the Python service consumes;
everything else is produced/consumed entirely on the Node side.
"""

SCRAPE_HARD_TARGET = "scrape-hard-target"
