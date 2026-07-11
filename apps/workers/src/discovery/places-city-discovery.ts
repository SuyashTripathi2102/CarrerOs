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

// Every metro + tier-2 hub with a real software scene. The goal is coverage:
// every company a manual search would never reach, city by city.
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
  'Kolkata',
  'Kochi',
  'Coimbatore',
  'Chandigarh',
  'Nagpur',
  'Vadodara',
  'Trivandrum',
  'Lucknow',
  'Bhubaneswar',
  'Nashik',
  'Visakhapatnam',
];

// Broadened archetypes. The first three found local IT-services shops; these
// add the company types that actually run crawlable ATS boards (startups,
// SaaS, product engineering, fintech/edtech) so conversion improves, not just
// the raw company count.
const QUERIES = [
  'software development company in {city}',
  'IT services company in {city}',
  'software product company in {city}',
  'tech startup in {city}',
  'SaaS company in {city}',
  'product engineering company in {city}',
  'fintech company in {city}',
  'software consulting company in {city}',
];

interface PlaceResult {
  displayName?: { text?: string };
  websiteUri?: string;
}

export interface PlacesDiscoveryOverride {
  /** One-city test (the mandated safety step before the full sweep). */
  cities?: string[];
  queries?: string[];
  /** Result pages per query (Places returns up to 20 each). Default 3 = 60. */
  maxPages?: number;
}

export async function runPlacesCityDiscovery(
  api: ApiClient,
  override: PlacesDiscoveryOverride = {},
): Promise<{ seeded: number; scanned: number }> {
  const key = process.env.PLACES_API_KEY;
  if (!key) {
    console.log('[places-discovery] PLACES_API_KEY not set — skipping');
    return { seeded: 0, scanned: 0 };
  }

  const cities = override.cities ?? CITIES;
  const queries = override.queries ?? QUERIES;
  const maxPages = Math.max(1, Math.min(3, override.maxPages ?? 3));
  console.log(
    `[places-discovery] sweeping ${cities.length} cities × ${queries.length} queries × ${maxPages} pages`,
  );

  const seen = new Map<string, { name: string; website?: string | null; city: string }>();

  for (const city of cities) {
    for (const template of queries) {
      const query = template.replace('{city}', city);
      let pageToken: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        try {
          const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'X-Goog-Api-Key': key,
              // Field mask = you only pay for what you request.
              'X-Goog-FieldMask': 'places.displayName,places.websiteUri,nextPageToken',
            },
            body: JSON.stringify({ textQuery: query, pageSize: 20, ...(pageToken ? { pageToken } : {}) }),
          });
          if (!res.ok) {
            console.warn(`[places-discovery] ${query} p${page}: HTTP ${res.status}`);
            break;
          }
          const data = (await res.json()) as { places?: PlaceResult[]; nextPageToken?: string };
          for (const p of data.places ?? []) {
            const name = p.displayName?.text?.trim();
            if (!name) continue;
            const dedupeKey = name.toLowerCase();
            if (!seen.has(dedupeKey)) {
              seen.set(dedupeKey, { name, website: p.websiteUri ?? null, city });
            }
          }
          pageToken = data.nextPageToken;
          // Gentle pacing — quota is generous but shared with nothing urgent.
          // Places also needs a short delay before a page token is valid.
          await new Promise((r) => setTimeout(r, pageToken ? 800 : 400));
          if (!pageToken) break;
        } catch (err) {
          console.warn(`[places-discovery] ${query} p${page}: ${err instanceof Error ? err.message : err}`);
          break;
        }
      }
    }
  }

  // Only candidates WITH websites are probeable — name-only entries stall.
  const candidates = [...seen.values()]
    .filter((c) => !!c.website)
    .map((c) => ({ name: c.name, website: c.website, country: 'IN', city: c.city }));

  console.log(`[places-discovery] ${seen.size} places seen, ${candidates.length} with websites`);
  if (candidates.length === 0) return { seeded: 0, scanned: seen.size };

  const res = await api.bulkDiscover('places-city', candidates);
  console.log(
    `[places-discovery] ${candidates.length} companies with websites → created ${res.created}, merged ${res.merged}`,
  );
  return { seeded: res.created, scanned: seen.size };
}
