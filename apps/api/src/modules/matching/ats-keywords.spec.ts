import { atsKeywordAudit } from './ats-keywords';

const RESUME = `
SKILLS
Backend: JavaScript (ES6+), Node.js, Express.js, RESTful APIs, Socket.io, Strapi
Databases: MySQL
Frontend: React.js, HTML5, CSS3
`;
const SKILLS = ['JavaScript', 'Node.js', 'Express.js', 'RESTful APIs', 'MySQL', 'React.js', 'HTML5', 'CSS3'];

describe('atsKeywordAudit', () => {
  it('marks the JD exact phrase PRESENT when the resume literally contains it', () => {
    const a = atsKeywordAudit(['Node.js', 'React.js', 'MySQL'], [], RESUME, SKILLS);
    expect(a.required.every((k) => k.status === 'PRESENT')).toBe(true);
    expect(a.requiredMatchPct).toBe(100);
    expect(a.addExact).toEqual([]);
  });

  it('urges ADD_EXACT on a real rewording: resume "RESTful APIs", JD "REST API"', () => {
    const a = atsKeywordAudit(['REST API'], [], RESUME, SKILLS);
    expect(a.required[0].status).toBe('ADD_EXACT');
    expect(a.required[0].yourTerm).toBe('RESTful APIs');
    expect(a.addExact).toEqual(['REST API']);
  });

  it('does NOT nag when the difference is trivial: JD "ExpressJS", resume "Express.js"', () => {
    const a = atsKeywordAudit(['ExpressJS'], [], RESUME, SKILLS);
    expect(a.required[0].status).toBe('ACCEPTED_VARIANT');
    expect(a.addExact).toEqual([]);
  });

  it('does NOT nag "React" when the resume says "React.js"', () => {
    const a = atsKeywordAudit(['React'], [], RESUME, SKILLS);
    expect(a.required[0].status).toBe('ACCEPTED_VARIANT');
    expect(a.addExact).toEqual([]);
  });

  it('separates genuinely-missing skills from zero-risk wording fixes', () => {
    const a = atsKeywordAudit(['Docker', 'Kubernetes'], [], RESUME, SKILLS);
    expect(a.required.map((k) => k.status)).toEqual(['MISSING', 'MISSING']);
    // Missing skills are NOT in addExact — you cannot just type a word you lack.
    expect(a.addExact).toEqual([]);
    expect(a.missingRequired).toEqual(['Docker', 'Kubernetes']);
  });

  it('ranks required above preferred and never double-counts a shared keyword', () => {
    const a = atsKeywordAudit(['Docker', 'Node.js'], ['Docker', 'GraphQL'], RESUME, SKILLS);
    expect(a.required.map((k) => k.keyword)).toEqual(['Docker', 'Node.js']);
    // Docker is required, so it is not repeated under preferred.
    expect(a.preferred.map((k) => k.keyword)).toEqual(['GraphQL']);
  });

  it('addExact is only real rewordings of skills you have; missing goes elsewhere', () => {
    const a = atsKeywordAudit(['Docker', 'REST API', 'React'], ['MySQL'], RESUME, SKILLS);
    expect(a.addExact).toEqual(['REST API']); // you have RESTful APIs; match the JD wording
    expect(a.missingRequired).toEqual(['Docker']); // genuine gap
  });

  it('counts accepted variants as covered in the required percentage', () => {
    const a = atsKeywordAudit(['Node.js', 'Docker', 'Redis', 'MySQL'], [], RESUME, SKILLS);
    // Node.js + MySQL covered of 4 = 50%.
    expect(a.requiredMatchPct).toBe(50);
  });
});
