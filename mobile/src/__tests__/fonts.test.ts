/**
 * Kazakh glyph check, automated part (2-design §2.2, criterion 1: the glyph is in the font itself).
 * Parses the cmap table of each Onest TTF we ship and asserts every required code point is mapped.
 * Criteria 2–4 (metrics match, tails not clipped at 1.3, iOS + Xiaomi/Samsung at 100%/200%) remain a
 * MANUAL release-blocker check on devices — TODO before store submission.
 */
import fs from 'fs';
import path from 'path';

import { KAZAKH_GLYPH_TEST_LINE } from '@/theme';

const REQUIRED = 'әӘғҒқҚңҢөӨұҰүҮһҺіІ₸№«»';
const WEIGHTS = ['400Regular', '500Medium', '600SemiBold', '700Bold'];

function cmapCodepoints(buf: Buffer): Set<number> {
  const numTables = buf.readUInt16BE(4);
  let cmapOffset = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString('ascii', rec, rec + 4) === 'cmap') cmapOffset = buf.readUInt32BE(rec + 8);
  }
  if (cmapOffset < 0) throw new Error('no cmap');
  const out = new Set<number>();
  const n = buf.readUInt16BE(cmapOffset + 2);
  for (let i = 0; i < n; i++) {
    const sub = cmapOffset + buf.readUInt32BE(cmapOffset + 4 + i * 8 + 4);
    const format = buf.readUInt16BE(sub);
    if (format === 4) {
      const segX2 = buf.readUInt16BE(sub + 6);
      const ends = sub + 14;
      const starts = ends + segX2 + 2;
      for (let s = 0; s < segX2; s += 2) {
        const end = buf.readUInt16BE(ends + s);
        const start = buf.readUInt16BE(starts + s);
        for (let c = start; c <= end && c !== 0xffff; c++) out.add(c);
      }
    } else if (format === 12) {
      const groups = buf.readUInt32BE(sub + 12);
      for (let g = 0; g < groups; g++) {
        const start = buf.readUInt32BE(sub + 16 + g * 12);
        const end = buf.readUInt32BE(sub + 16 + g * 12 + 4);
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

describe('Onest covers Kazakh glyphs', () => {
  const dir = path.dirname(require.resolve('@expo-google-fonts/onest/package.json'));
  it.each(WEIGHTS)('%s has ә ғ қ ң ө ұ ү һ і (both cases), ₸ № « »', (w) => {
    const cps = cmapCodepoints(fs.readFileSync(path.join(dir, w, `Onest_${w}.ttf`)));
    const missing = [...REQUIRED].filter((ch) => !cps.has(ch.codePointAt(0)!));
    expect(missing).toEqual([]);
  });

  it('every character of the spec test line is in Regular', () => {
    const cps = cmapCodepoints(fs.readFileSync(path.join(dir, '400Regular', 'Onest_400Regular.ttf')));
    const missing = [...new Set(KAZAKH_GLYPH_TEST_LINE)].filter((ch) => ch !== ' ' && !cps.has(ch.codePointAt(0)!));
    expect(missing).toEqual([]);
  });
});
