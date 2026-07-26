import { adaptiveTier, TIER_INTERVAL_MS, type CrawlActivity } from './crawl-scheduling';

const base: CrawlActivity = {
  newJobs14d: 0,
  activeJobs: 0,
  daysSinceLastNewJob: null,
  crawlAttempts: 10,
};

describe('adaptiveTier', () => {
  it('marks a long-empty, well-crawled company DORMANT', () => {
    expect(adaptiveTier(base)).toBe('DORMANT');
    expect(adaptiveTier({ ...base, daysSinceLastNewJob: 200 })).toBe('DORMANT');
  });

  it('does NOT write off a freshly discovered company after few crawls', () => {
    expect(adaptiveTier({ ...base, crawlAttempts: 2 })).toBe('COLD');
  });

  it('keeps a company with live jobs out of DORMANT', () => {
    expect(adaptiveTier({ ...base, activeJobs: 4, daysSinceLastNewJob: 300 })).toBe('COLD');
  });

  it('is HOT when shipping several roles in two weeks', () => {
    expect(adaptiveTier({ ...base, newJobs14d: 5, activeJobs: 5, daysSinceLastNewJob: 1 })).toBe(
      'HOT',
    );
  });

  it('is WARM on light-but-recent activity', () => {
    expect(adaptiveTier({ ...base, newJobs14d: 1, activeJobs: 2, daysSinceLastNewJob: 5 })).toBe(
      'WARM',
    );
    expect(adaptiveTier({ ...base, newJobs14d: 0, activeJobs: 3, daysSinceLastNewJob: 20 })).toBe(
      'WARM',
    );
  });

  it('is COLD when quiet but not provably dead', () => {
    expect(adaptiveTier({ ...base, activeJobs: 2, daysSinceLastNewJob: 60 })).toBe('COLD');
  });

  it('crawls DORMANT far less often than HOT', () => {
    expect(TIER_INTERVAL_MS.DORMANT).toBeGreaterThan(TIER_INTERVAL_MS.HOT * 100);
  });
});
