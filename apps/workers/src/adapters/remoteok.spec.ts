import { isPlausibleRemoteOkPosting } from './remoteok';

/**
 * Regression suite for the RemoteOK feed-pollution incident (2026-08-12).
 *
 * RemoteOK's API returned 100 items, of which only ~4 were genuine remote
 * postings. The rest were rows its own crawler lifted off company pages:
 * error screens, nav items, headings, body copy. Each arrived with a valid
 * id/company/URL, so the previous `id && position && company` filter passed
 * them straight through — where they polluted Browse/Today and cost an LLM
 * classification call each (~$0.019).
 *
 * These cases are verbatim from that live feed. The validator must reject
 * them *structurally* — no title blacklist, so tomorrow's differently-worded
 * garbage is caught too.
 */
describe('isPlausibleRemoteOkPosting', () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: 1136342,
    position: 'Senior Node.js Developer',
    company: 'Acme Remote',
    location: '',
    ...over,
  });

  describe('rejects the observed garbage', () => {
    // title + the location RemoteOK actually paired it with
    const garbage: [string, string][] = [
      ['Recognizing the Friction', 'Much Cowarne, '],
      ['HOW APPLY', 'How, '],
      ['How Apply', 'Jabalpur, '],
      ['Corporate', 'Miles, '],
      ['Oops something happened', 'Back, '],
      ['THINK WE COULD BE A GOOD FIT', 'Fort Good Hope, '],
      ['IDEAS THAT\nSTICK.\nliterally', 'Bristol, '],
      ['Stoic', 'Loch Sport, '],
      [
        'Need find out the us border wait times real time both directions https www.lalineaapp.com',
        'Amet, ',
      ],
    ];

    it.each(garbage)('rejects %p', (position, location) => {
      expect(isPlausibleRemoteOkPosting(item({ position, location }))).toBe(false);
    });

    // Same feed, same failure mode — these motivated the structural rules.
    const alsoGarbage: [string, string][] = [
      ['Page Not Found', 'Coral Bay, '],
      ['Job Title', 'Amet, '],
      ['YOUR JOB DESCRIPTION HERE', 'Kharagpur-I, '],
      ['CURRENT JOBS OPENING', 'Swift Current, '],
      ['Driving Directions', 'Lincoln, '],
      ['Come join our team', 'Belfast, '],
      ['12TH PASS', 'Rajkot, '],
      ['Meat Department Manager', 'Bedford, '],
    ];

    it.each(alsoGarbage)('rejects %p', (position, location) => {
      expect(isPlausibleRemoteOkPosting(item({ position, location }))).toBe(false);
    });
  });

  describe('preserves legitimate postings', () => {
    const legit: [string, string][] = [
      ['Senior React Full stack Developer', 'Remote'],
      ['Junior Crypto Trader', ''],
      ['Senior Software QA Engineer', ''],
      ['Sales Development Representative', 'Remote UK'],
      ['Node.js Backend Engineer', 'Worldwide'],
      ['Full Stack Engineer (Node.js & React)', 'Anywhere'],
      ['Staff SRE', 'EMEA'],
      ['Platform Engineer', 'Europe'],
    ];

    it.each(legit)('accepts %p', (position, location) => {
      expect(isPlausibleRemoteOkPosting(item({ position, location }))).toBe(true);
    });

    it('accepts a short all-caps acronym title (QA, SRE are real roles)', () => {
      expect(isPlausibleRemoteOkPosting(item({ position: 'SRE', location: '' }))).toBe(true);
    });
  });

  describe('identity requirements still apply', () => {
    it('rejects a row with no id', () => {
      expect(isPlausibleRemoteOkPosting(item({ id: undefined }))).toBe(false);
    });

    it('rejects a row with no company (no ghost companies in the flywheel)', () => {
      expect(isPlausibleRemoteOkPosting(item({ company: undefined }))).toBe(false);
    });

    it('rejects a row with no position', () => {
      expect(isPlausibleRemoteOkPosting(item({ position: undefined }))).toBe(false);
    });
  });

  describe('structural rules, not a vocabulary list', () => {
    it('rejects an unseen heading in the same shape as the observed ones', () => {
      expect(
        isPlausibleRemoteOkPosting(item({ position: 'WHY WORK WITH US', location: 'Leeds, ' })),
      ).toBe(false);
    });

    it('rejects a question, which no job title is', () => {
      expect(
        isPlausibleRemoteOkPosting(item({ position: 'Looking for your next role?', location: '' })),
      ).toBe(false);
    });

    it('rejects a locality even when the title looks like a real job', () => {
      expect(
        isPlausibleRemoteOkPosting(item({ position: 'Backend Developer', location: 'Bedford, ' })),
      ).toBe(false);
    });
  });
});
