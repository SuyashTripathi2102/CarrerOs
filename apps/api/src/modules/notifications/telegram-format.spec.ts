import {
  ageLabel,
  cleanJobUrl,
  formatAlert,
  formatBrief,
  formatDigest,
  informativeReasons,
  linkHost,
  PLACEHOLDER_TITLE,
  shorten,
} from './telegram-format';

describe('cleanJobUrl', () => {
  it('removes click-tracking parameters and keeps the ones the page needs', () => {
    expect(
      cleanJobUrl(
        'https://jobs.example.com/job/full-stack-developer-acme-AbC123?utm_medium=xml&utm_content=job-posting&applicationsource=board-feed&utm_source=board.example',
      ),
    ).toBe('https://jobs.example.com/job/full-stack-developer-acme-AbC123');
    expect(
      cleanJobUrl(
        'https://jobs.lever.co/acme/123?lever-source=linkedin&utm_source=x',
      ),
    ).toBe('https://jobs.lever.co/acme/123?lever-source=linkedin');
    expect(
      cleanJobUrl('https://boards.greenhouse.io/acme/jobs/1?gh_jid=1'),
    ).toBe('https://boards.greenhouse.io/acme/jobs/1?gh_jid=1');
  });

  it('returns an unparseable URL as it was', () => {
    expect(cleanJobUrl('not a url')).toBe('not a url');
  });
});

describe('linkHost', () => {
  it('names the host without www', () => {
    expect(linkHost('https://www.board.example/jobs/x')).toBe('board.example');
    expect(linkHost('https://jobs.lever.co/acme/1')).toBe('jobs.lever.co');
    expect(linkHost('nonsense')).toBeNull();
  });
});

describe('PLACEHOLDER_TITLE', () => {
  it.each([
    'Engineering Referral - Dummy ID',
    'DUMMY requisition',
    'Placeholder - Backend',
    'Test Posting',
    'Do not apply - internal',
  ])('matches %s', (t) => expect(PLACEHOLDER_TITLE.test(t)).toBe(true));
  it.each([
    'Software Engineer',
    'QA Test Engineer',
    'Test Automation Engineer',
    'Dummyfield Developer',
  ])('leaves %s alone', (t) => expect(PLACEHOLDER_TITLE.test(t)).toBe(false));
});

describe('informativeReasons', () => {
  it('drops the reasons that appeared on nearly every message', () => {
    expect(
      informativeReasons([
        'experience level fits',
        'strong resume match (82%)',
        'freshly posted — early applicant advantage',
        'solid company signals',
        'missing only typescript — learnable',
        '⚠ 11 skill gaps (python, django…)',
      ]),
    ).toEqual([
      'missing only typescript — learnable',
      '⚠ 11 skill gaps (python, django…)',
    ]);
  });
});

describe('ageLabel', () => {
  const now = new Date('2026-11-23T08:00:00Z');
  it('reads the posting date, or the first sighting when there is none', () => {
    expect(ageLabel(new Date('2026-11-23T01:00:00Z'), new Date(0), now)).toBe(
      'today',
    );
    expect(ageLabel(new Date('2026-11-22T07:00:00Z'), new Date(0), now)).toBe(
      'yesterday',
    );
    expect(ageLabel(null, new Date('2026-11-20T08:00:00Z'), now)).toBe(
      '3d ago',
    );
  });
});

describe('shorten', () => {
  it('keeps short text, cuts long text at a sentence, or else at a word with an ellipsis', () => {
    expect(shorten('Short.', 100)).toBe('Short.');
    expect(
      shorten(
        'First sentence is here. Second one is long and would not fit at all.',
        40,
      ),
    ).toBe('First sentence is here.');
    expect(shorten('one two three four five six seven eight', 20)).toBe(
      'one two three four…',
    );
  });
});

describe('formatAlert', () => {
  // An alert shaped like a real one (fictional company and text), laid out by v2.
  const sample = {
    action: '✅ APPLY',
    fitPct: 82,
    title: 'full stack developer',
    applyUrl:
      'https://jobs.example.com/job/full-stack-developer-acme-AbC123?utm_medium=xml&utm_content=job-posting&applicationsource=board-feed&utm_source=board.example',
    company: 'Acme Labs',
    place: '📍 India',
    age: 'posted 2d ago',
    salary: null,
    reasons: [
      'experience level fits',
      'strong resume match (82%)',
      'freshly posted — early applicant advantage',
      'missing only typescript — learnable',
    ],
    missingSkills: ['typescript'],
    analysis:
      'The core skills match this role well. However, it targets 0-1 years of experience with a very low pay band, so you may be overqualified for it.',
    twinCount: 1,
  };

  it('puts the decision and one score first, the title as the clean apply link on the third line', () => {
    const lines = formatAlert(sample).split('\n');
    expect(lines[0]).toBe('<b>✅ APPLY</b> · fit <b>82%</b>');
    expect(lines[2]).toBe(
      '<a href="https://jobs.example.com/job/full-stack-developer-acme-AbC123"><b>full stack developer</b></a>',
    );
    expect(lines[3]).toBe('Acme Labs · 📍 India · posted 2d ago');
  });

  it('keeps only the reasons specific to the job, the caution in the analysis, and names the link host', () => {
    const text = formatAlert(sample);
    expect(text).toContain('• missing only typescript — learnable');
    expect(text).not.toContain('experience level fits');
    expect(text).not.toContain('freshly posted');
    expect(text).not.toContain('/100');
    expect(text).toContain('overqualified');
    expect(text).toContain('Apply via jobs.example.com');
    expect(text).not.toContain('utm_');
  });

  it('adds a gap line only when no reason already mentions the gaps', () => {
    const text = formatAlert({
      ...sample,
      reasons: ['great team signals'],
      missingSkills: ['go', 'k8s', 'aws'],
    });
    expect(text).toContain('• gaps: go, k8s +1');
  });

  it('escapes the job text', () => {
    const text = formatAlert({
      ...sample,
      title: 'C++ <Dev> & "Ops"',
      company: 'A&B',
    });
    expect(text).toContain('<b>C++ &lt;Dev&gt; &amp; "Ops"</b>');
    expect(text).toContain('A&amp;B');
  });

  it('caps the analysis well below the old 2,500 characters', () => {
    const text = formatAlert({
      ...sample,
      analysis: 'Long sentence here. '.repeat(100),
    });
    expect(text.length).toBeLessThan(900);
  });
});

describe('formatDigest', () => {
  it('lists each job as a link with its facts and labels the low-priority ones', () => {
    const text = formatDigest([
      {
        title: 'Backend Engineer I',
        url: 'https://jobs.lever.co/acme/1',
        company: 'Acme',
        place: '📍 Bengaluru',
        fitPct: 74,
      },
      {
        title: 'Insights Engineer II',
        url: 'https://x.test/2',
        company: 'Globex',
        place: null,
        fitPct: 65,
        note: 'low priority',
      },
    ]);
    expect(text).toContain('🟡 <b>Worth a look · 2</b>');
    expect(text).toContain(
      '1. <a href="https://jobs.lever.co/acme/1"><b>Backend Engineer I</b></a>',
    );
    expect(text).toContain('   Acme · 📍 Bengaluru · fit 74%');
    expect(text).toContain('   Globex · fit 65% · low priority');
  });
});

describe('formatBrief', () => {
  const base = {
    dateLabel: 'Mon, 23 Nov',
    firstName: 'Asha',
    doToday: [],
    worthALook: [],
    closest: [],
    followUps: [],
    newJobs24h: 1129,
    indiaNew24h: 412,
    learnNext: [{ skill: 'typescript', count: 208 }],
    extra: [],
  };

  it('leads with what to apply to today, each a link with fit and gap', () => {
    const text = formatBrief({
      ...base,
      doToday: [
        {
          title: 'React Developer',
          url: 'https://x.test/r',
          company: 'Initech',
          place: '📍 India',
          age: '2d ago',
          fitPct: 86,
          gaps: ['next.js'],
        },
      ],
    });
    expect(text).toContain('☀️ <b>Daily Brief · Mon, 23 Nov</b>');
    expect(text).toContain('<b>Do today</b> · 1 to apply');
    expect(text).toContain(
      '1. <a href="https://x.test/r"><b>React Developer</b></a>',
    );
    expect(text).toContain(
      '   Initech · 📍 India · 2d ago · fit 86% · gap: next.js',
    );
    expect(text).toContain('📊 1,129 new jobs in 24 h · 412 in India');
    expect(text).toContain('🧩 Learn next: typescript (208 matches)');
  });

  it('falls back to the closest matches, and says so, when there is nothing to apply to', () => {
    const text = formatBrief({
      ...base,
      closest: [
        {
          title: 'Fullstack developer',
          url: 'https://x.test/f',
          company: 'Umbrella',
          place: '📍 Bengaluru',
          age: '5d ago',
        },
      ],
    });
    expect(text).toContain('Nothing new to apply to. Closest matches:');
    expect(text).toContain('<b>Fullstack developer</b>');
  });

  it('says plainly when there is nothing at all', () => {
    expect(formatBrief(base)).toContain(
      'Nothing new to apply to; the bar stays high on purpose.',
    );
  });

  it('lists follow-ups and appends the operator lines last', () => {
    const text = formatBrief({
      ...base,
      followUps: [
        { title: 'Backend Engineer', company: 'Acme', daysWaiting: 9 },
      ],
      extra: ['🧹 <b>Large retirements (last 24 h)</b>'],
    });
    expect(text).toContain(
      '<b>Follow up</b> (no reply yet)\n• Backend Engineer · Acme · applied 9d ago',
    );
    expect(
      text.trimEnd().endsWith('🧹 <b>Large retirements (last 24 h)</b>'),
    ).toBe(true);
  });
});
