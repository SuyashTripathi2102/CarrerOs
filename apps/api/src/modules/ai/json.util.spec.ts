import { parseModelJson } from './json.util';

describe('parseModelJson', () => {
  it('parses clean JSON', () => {
    expect(parseModelJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips markdown fences', () => {
    expect(parseModelJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  // The 2026-07-09 outage: duplicated closers aborted a 312-job reconcile,
  // because lastIndexOf('}') grabbed the trailing garbage.
  it('recovers from duplicated trailing closers', () => {
    const broken = '{\n "scores": [\n {"jobId": "a", "overallScore": 30}\n ]\n}\n ]\n}';
    expect(parseModelJson<{ scores: { jobId: string }[] }>(broken)).toEqual({
      scores: [{ jobId: 'a', overallScore: 30 }],
    });
  });

  it('ignores braces inside string values', () => {
    const s = '{"reasoning": "we use {} and \\" quotes", "score": 5} trailing junk }';
    expect(parseModelJson<{ score: number }>(s).score).toBe(5);
  });

  it('drops prose before and after the object', () => {
    expect(parseModelJson<{ a: number }>('Here you go:\n{"a":1}\nHope that helps!')).toEqual({ a: 1 });
  });

  it('throws with head and tail when nothing is salvageable', () => {
    expect(() => parseModelJson('absolutely not json')).toThrow(/invalid JSON/);
  });
});
