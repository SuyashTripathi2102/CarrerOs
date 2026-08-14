/**
 * Country normalization — every job's `country` becomes an ISO 3166-1 alpha-2
 * code, or null.
 *
 * Why this exists (2026-08-15): every surface filters on
 * `country = 'IN' OR workMode = 'REMOTE'`. Workable and Recruitee pass their
 * source's locale string straight through, so 567 active India jobs were stored
 * as the literal string `'India'` and were invisible to Browse, Today, matching
 * and notifications alike. One of them was an evaluated APPLY at 77.3 that the
 * user could never see. Singapore (246), Malaysia (212) and the United States
 * (203) had the same problem, and Recruitee even emits German locale names
 * ("Deutschland").
 *
 * This runs at the single ingest choke point rather than in each adapter, so a
 * new source cannot reintroduce the bug: a source is an adapter, not a new
 * pipeline.
 */

/** ISO 3166-1 alpha-2. Guards against storing arbitrary two-letter junk. */
const ISO_ALPHA2 = new Set(
  ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR ' +
    'BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ ' +
    'EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW ' +
    'GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY ' +
    'KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV ' +
    'MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY ' +
    'QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG ' +
    'TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW')
    .split(' '),
);

/**
 * Country names → ISO. Covers every value observed in the corpus plus the
 * aliases sources commonly emit. Localized names are included because
 * Recruitee returns them ("Deutschland").
 */
const NAME_TO_ISO: Record<string, string> = {
  albania: 'AL',
  algeria: 'DZ',
  argentina: 'AR',
  armenia: 'AM',
  australia: 'AU',
  belgium: 'BE',
  brazil: 'BR',
  brasil: 'BR',
  bulgaria: 'BG',
  canada: 'CA',
  colombia: 'CO',
  czechia: 'CZ',
  'czech republic': 'CZ',
  deutschland: 'DE',
  germany: 'DE',
  egypt: 'EG',
  france: 'FR',
  honduras: 'HN',
  'hong kong': 'HK',
  hungary: 'HU',
  india: 'IN',
  bharat: 'IN',
  indonesia: 'ID',
  ireland: 'IE',
  israel: 'IL',
  italy: 'IT',
  italia: 'IT',
  japan: 'JP',
  luxembourg: 'LU',
  malaysia: 'MY',
  mexico: 'MX',
  méxico: 'MX',
  nepal: 'NP',
  netherlands: 'NL',
  nederland: 'NL',
  'the netherlands': 'NL',
  'new zealand': 'NZ',
  philippines: 'PH',
  poland: 'PL',
  polska: 'PL',
  portugal: 'PT',
  romania: 'RO',
  'saudi arabia': 'SA',
  singapore: 'SG',
  slovakia: 'SK',
  'south africa': 'ZA',
  'south korea': 'KR',
  'korea, republic of': 'KR',
  spain: 'ES',
  españa: 'ES',
  espana: 'ES',
  taiwan: 'TW',
  thailand: 'TH',
  turkey: 'TR',
  türkiye: 'TR',
  turkiye: 'TR',
  'united arab emirates': 'AE',
  uae: 'AE',
  'united kingdom': 'GB',
  uk: 'GB',
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'united states': 'US',
  'united states of america': 'US',
  usa: 'US',
  'u.s.': 'US',
  'u.s.a.': 'US',
  america: 'US',
  vietnam: 'VN',
  'viet nam': 'VN',
  switzerland: 'CH',
  austria: 'AT',
  sweden: 'SE',
  norway: 'NO',
  denmark: 'DK',
  finland: 'FI',
  greece: 'GR',
  china: 'CN',
  pakistan: 'PK',
  bangladesh: 'BD',
  'sri lanka': 'LK',
  kenya: 'KE',
  nigeria: 'NG',
  chile: 'CL',
  peru: 'PE',
  ukraine: 'UA',
  serbia: 'RS',
  croatia: 'HR',
  slovenia: 'SI',
  estonia: 'EE',
  latvia: 'LV',
  lithuania: 'LT',
  qatar: 'QA',
  bahrain: 'BH',
  kuwait: 'KW',
  oman: 'OM',
  jordan: 'JO',
  morocco: 'MA',
  tunisia: 'TN',
};

/**
 * Values that are NOT countries. "worldwide" appears as a country in the corpus
 * — it is a remote scope, and mapping it to any code would silently place jobs
 * in a market they are not in.
 */
const NOT_A_COUNTRY = new Set([
  'worldwide',
  'global',
  'anywhere',
  'remote',
  'international',
  'multiple',
  'various',
  'emea',
  'apac',
  'latam',
  'eu',
  'europe',
  'asia',
  'africa',
  'americas',
  'north america',
  'south america',
  'n/a',
  'na',
  'unknown',
  'none',
  'null',
  '-',
]);

/** Lowercase, collapse whitespace, drop surrounding punctuation. */
function key(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’“”]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^a-z0-9.]+|[^a-z0-9.]+$/g, '')
    .trim();
}

/**
 * `raw` → ISO alpha-2, or null when it is absent, unrecognised, or not a
 * country at all.
 *
 * Composite strings ("Bengaluru, India", "Remote - India") are split and each
 * segment is tested against the name table.
 *
 * **A bare two-letter code is only honoured when it is the ENTIRE input.**
 * Inside a composite it is ambiguous with a subdivision code — "Indianapolis,
 * IN" is Indiana in the United States, not India — and guessing there would
 * reintroduce exactly the class of false positive this function exists to
 * prevent. A composite must name its country in words to be recognised.
 */
export function normalizeCountry(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const whole = key(String(raw));
  if (!whole) return null;
  if (NOT_A_COUNTRY.has(whole)) return null;

  // Names and aliases are consulted BEFORE the bare-code branch: "UK" is two
  // letters but is not an ISO code (Britain is GB), so testing the code branch
  // first would reject it outright.
  const direct = NAME_TO_ISO[whole];
  if (direct) return direct;

  // Whole input is already a code.
  if (/^[a-z]{2}$/.test(whole)) {
    const iso = whole.toUpperCase();
    return ISO_ALPHA2.has(iso) ? iso : null;
  }

  // Composite: prefer a named country in any segment. Longest name first so
  // "united states" wins over a hypothetical "states" entry.
  const segments = whole
    .split(/[,/|·–—]|\s+-\s+|\s+—\s+/)
    .map((s) => key(s))
    .filter(Boolean);

  if (segments.length > 1) {
    const named = segments
      .filter((s) => NAME_TO_ISO[s])
      .sort((a, b) => b.length - a.length)[0];
    if (named) return NAME_TO_ISO[named];
  }

  // Last resort: a multi-word string whose tail is a known name
  // ("greater london area united kingdom").
  for (const [name, iso] of Object.entries(NAME_TO_ISO)) {
    if (name.includes(' ') && new RegExp(`(^|\\s)${name}($|\\s)`).test(whole)) return iso;
  }

  return null;
}
