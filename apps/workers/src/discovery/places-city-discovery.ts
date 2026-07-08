/**
 * City-based company discovery via the official Google Places API (ROADMAP
 * D-2b). This is the ToS-clean version of "scrape Google Maps": Places Text
 * Search is a paid GCP product — billed to the same trial credits as Vertex.
 *
 * Flow: for each (city × query) → Places Text Search → {name, website} →
 * POST /internal/discovery/bulk → the existing flywheel probes career pages,
 * detects ATS boards, and crawls forever. Places gives us the front door;
 * the prober finds the jobs.
 *
 * Requires PLACES_API_KEY (Cloud Console → enable "Places API (New)" →
 * Credentials → API key). Skips silently when the key is absent so the
 * workers boot fine without it.
 */
import { ApiClient } from '../api-client';

const CITIES = [
  'Indore',
  'Bangalore',
  'Pune',
  'Hyderabad',
  'Mumbai',
  'Ahmedabad',
  'Gandhinagar',
  'Surat',
  'Jaipur',
  'Noida',
  'Gurgaon',
  'Chennai',
  'Bhopal',
];

const QUERIES = [
  'software development company in {city}',
  'IT services company in {city}',
  'software product company in {city}',
];

interface PlaceResult {
  displayName?: { text?: string };
  websiteUri?: string;
}

export async function runPlacesCityDiscovery(api: ApiClient): Promise<{ seeded: number }> {
  const key = process.env.PLACES_API_KEY;
  if (!key) {
    console.log('[places-discovery] PLACES_API_KEY not set — skipping');
    return { seeded: 0 };
  }

  const seen = new Map<string, { name: string; website?: string | null; city: string }>();

  for (const city of CITIES) {
    for (const template of QUERIES) {
      const query = template.replace('{city}', city);
      try {
        const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Goog-Api-Key': key,
            // Field mask = you only pay for what you request.
            'X-Goog-FieldMask': 'places.displayName,places.websiteUri',
          },
          body: JSON.stringify({ textQuery: query, pageSize: 20 }),
        });
        if (!res.ok) {
          console.warn(`[places-discovery] ${query}: HTTP ${res.status}`);
          continue;
        }
        const data = (await res.json()) as { places?: PlaceResult[] };
        for (const p of data.places ?? []) {
          const name = p.displayName?.text?.trim();
          if (!name) continue;
          const dedupeKey = name.toLowerCase();
          if (!seen.has(dedupeKey)) {
            seen.set(dedupeKey, { name, website: p.websiteUri ?? null, city });
          }
        }
        // Gentle pacing — quota is generous but shared with nothing urgent.
        await new Promise((r) => setTimeout(r, 400));
      } catch (err) {
        console.warn(`[places-discovery] ${query}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  // Only candidates WITH websites are probeable — name-only entries stall.
  const candidates = [...seen.values()]
    .filter((c) => !!c.website)
    .map((c) => ({ name: c.name, website: c.website, country: 'IN', city: c.city }));

  if (candidates.length === 0) return { seeded: 0 };

  const res = await api.bulkDiscover('places-city', candidates);
  console.log(
    `[places-discovery] ${candidates.length} companies with websites → created ${res.created}, merged ${res.merged}`,
  );
  return { seeded: res.created };
}
