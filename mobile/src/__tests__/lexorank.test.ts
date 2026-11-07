import fs from 'fs';
import path from 'path';

import { between, compareRank, isValidRank, RankError, sequence } from '@/pages/lexorank';

/** The same file the server's tests read: any drift between the two ports fails here. */
const vectorsPath = path.resolve(__dirname, '../../../docs/spec/vectors/lexorank.json');
type Vectors = {
  alphabet: string;
  between: { a: string | null; b: string | null; expect: string }[];
  invalid: { a: string | null; b: string | null }[];
  sequence: { n: number; expect: string[] }[];
  sequence_samples: { n: number; len: number; first: string; last: string; at_index_n_div_2: string }[];
  chain: { insert_at: number; expect: string }[];
  chain_sorted: string[];
  sort_check: { input: string[]; bytewise: string[] };
};
const vectors = JSON.parse(fs.readFileSync(vectorsPath, 'utf8')) as Vectors;

describe('LexoRank shared vectors', () => {
  it.each(vectors.between.map((v) => [v.a, v.b, v.expect] as const))('between(%s, %s) = %s', (a, b, expect_) => {
    expect(between(a, b)).toBe(expect_);
  });

  it.each(vectors.sequence.map((v) => [v.n, v.expect] as const))('sequence(%i)', (n, expect_) => {
    expect(sequence(n)).toEqual(expect_);
  });

  it.each(vectors.sequence_samples.map((v) => [v.n, v] as const))('sequence(%i), samples', (n, v) => {
    const keys = sequence(n);
    expect(keys).toHaveLength(v.len);
    expect(keys[0]).toBe(v.first);
    expect(keys[keys.length - 1]).toBe(v.last);
    expect(keys[Math.floor(n / 2)]).toBe(v.at_index_n_div_2);
  });

  it.each(vectors.invalid.map((v) => [v.a, v.b] as const))('between(%j, %j) is an error', (a, b) => {
    expect(() => between(a, b)).toThrow(RankError);
  });

  it('chain of inserts gives the same keys and the same order', () => {
    const keys: string[] = [];
    for (const step of vectors.chain) {
      const k = between(keys[step.insert_at - 1] ?? null, keys[step.insert_at] ?? null);
      expect(k).toBe(step.expect);
      keys.splice(step.insert_at, 0, k);
    }
    expect(keys).toEqual(vectors.chain_sorted);
  });

  it('sorts by bytes like the server', () => {
    expect([...vectors.sort_check.input].sort(compareRank)).toEqual(vectors.sort_check.bytewise);
  });
});

describe('LexoRank properties', () => {
  it('stays strictly between, valid, in ASCII order, also deep in one gap', () => {
    let low: string | null = 'V';
    const high = 'W';
    for (let i = 0; i < 200; i++) {
      const k: string = between(low, high);
      expect(isValidRank(k)).toBe(true);
      expect(low! < k && k < high).toBe(true);
      low = k;
    }
  });

  it('rejects bad bounds and keys', () => {
    expect(() => between('W', 'V')).toThrow(RankError);
    expect(() => between('V', 'V')).toThrow(RankError);
    expect(() => between('V0', null)).toThrow(RankError);
    expect(() => between('я', null)).toThrow(RankError);
  });

  it('compares by bytes, null last (uppercase before lowercase, unlike localeCompare)', () => {
    expect(['a', null, 'Z', '1'].sort(compareRank)).toEqual(['1', 'Z', 'a', null]);
  });
});
