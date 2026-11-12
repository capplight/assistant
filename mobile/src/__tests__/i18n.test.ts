import fs from 'fs';

import i18n from '@/i18n';

import {
  applyReview,
  blocking,
  buildRows,
  check,
  decodeReview,
  fixLatin,
  flatten,
  formatReport,
  keyUsage,
  localePath,
  mixedWords,
  parseCsv,
  readLocale,
  eolOf,
  serializeLocale,
  toCsv,
  type Dict,
} from '../../scripts/kk-review';

/**
 * Week 17: KK strings (2-design §7.3, F-22). Blocking: a missing KK key, a {{variable}} KK lost or
 * invented, a kk plural form i18next needs (one / other). Wording is the native speaker's
 * (`node scripts/kk-review.ts export` → docs/i18n/kk-review.csv → `import`).
 */

const ru = readLocale('ru');
const kk = readLocale('kk');

describe('KK locale: automated checks', () => {
  it('no missing keys, no variable mismatch, every kk plural form present', () => {
    const r = check(ru, kk);
    if (blocking(r)) throw new Error(formatReport(r));
    expect(r.missing).toEqual([]);
    expect(r.variables).toEqual([]);
    expect(r.plurals).toEqual([]);
    expect(r.extra).toEqual([]);
  });

  it('no Latin look-alike letters inside Kazakh words', () => {
    expect(check(ru, kk).latin).toEqual([]);
    expect(mixedWords('Жазбалар бeті')).toEqual(['бeті']);
    expect(fixLatin('Жазбалар бeті, WhatsApp')).toBe('Жазбалар беті, WhatsApp');
    expect(fixLatin('{{page}} бетi')).toBe('{{page}} беті');
  });

  it('the check finds what it should', () => {
    const r = check(
      { a: { x: 'Привет, {{name}}', y: 'Файл', n_one: '{{count}} запись', n_few: '{{count}} записи', n_many: '{{count}} записей', n_other: '{{count}} записи' } },
      { a: { x: 'Сәлем, {{nam}}', y: 'Файл', n_other: '{{count}} жазба' } },
    );
    expect(r.variables.map((i) => i.key)).toEqual(['a.x']);
    expect(r.plurals.map((i) => i.key)).toEqual(['a.n_one']);
    expect(r.untranslated.map((i) => i.key)).toEqual(['a.y']);
  });

  it('i18next uses one / other for kk', () => {
    expect(new Intl.PluralRules('kk').resolvedOptions().pluralCategories.sort()).toEqual(['one', 'other']);
    const K = flatten(kk);
    expect(i18n.t('exp.count', { lng: 'kk', count: 5 })).toBe(K['exp.count_other']!.replace('{{count}}', '5'));
    expect(i18n.t('exp.count', { lng: 'kk', count: 1 })).toBe(K['exp.count_one']!.replace('{{count}}', '1'));
  });

  it('the locale files keep their layout, so an import changes only the cells it touches', () => {
    for (const lang of ['ru', 'kk'] as const) {
      const text = fs.readFileSync(localePath(lang), 'utf8');
      expect(serializeLocale(readLocale(lang), eolOf(text))).toBe(text);
    }
  });
});

describe('the review file: export → Excel → import', () => {
  const rows = buildRows(ru, kk, keyUsage(), new Set());

  it('one row per string the kk screen can show, with RU, KK, where and a length note', () => {
    const K = flatten(kk);
    const keys = new Set(rows.map((r) => r.key));
    for (const key of Object.keys(K)) {
      if (key.startsWith('_meta') || /_(few|many)$/.test(key)) continue;
      expect(keys.has(key)).toBe(true);
    }
    const tab = rows.find((r) => r.key === 'tabs.more')!;
    expect(tab.length).toMatch(/вкладк/);
    expect(tab.comment).toMatch(/Тағы/);
    expect(rows.find((r) => r.key === 'line.about')!.where).toMatch(/AssistantLine/);
  });

  it('UTF-8 with BOM, «;», formula-looking cells protected; a file with no edits changes nothing', () => {
    const csv = toCsv(rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1).split('\r\n')[0]).toBe('key;where;ru;kk;kk_new;comment;checks;length;source');
    const table = parseCsv(csv);
    expect(table.length).toBe(rows.length + 1);
    const res = applyReview(ru, kk, table);
    expect(res.changed).toEqual([]);
    expect(res.rejected).toEqual([]);
    // Every RU/KK cell survives the round trip (quotes, «;», new lines, a leading «+»).
    const back = new Map(table.slice(1).map((r) => [r[0], r[3]]));
    for (const r of rows) expect(back.get(r.key)?.replace(/^'(?=[=+\-@])/, '')).toBe(r.kk);
  });

  it('applies only the filled «kk_new» cells, keeps keys and order, refuses broken variables', () => {
    const table = [
      ['key', 'kk_new', 'comment'],
      ['common.undo', 'Қайтару', ''],
      ['tabs.more', '', 'ok'],
      ['line.about', '{{page}} бойынша', ''],
      ['exp.count_other', '{{n}} шығын', ''],
      ['no.such', 'x', ''],
    ];
    const res = applyReview(ru, kk, table);
    expect(res.changed.map((c) => c.key)).toEqual(['common.undo']);
    expect(res.rejected.map((r) => r.key)).toEqual(['exp.count_other', 'no.such']);
    const next = flatten(res.next);
    expect(next['common.undo']).toBe('Қайтару');
    expect(Object.keys(next)).toEqual(Object.keys(flatten(kk)));
    // The source is untouched.
    expect(flatten(kk)['common.undo']).not.toBe('Қайтару');
  });

  it('a leading «+» typed in Excel comes back without the protecting apostrophe', () => {
    const key = Object.entries(flatten(ru)).find(([, v]) => v.startsWith('+'))?.[0];
    if (!key) return;
    const res = applyReview(ru, kk as Dict, [['key', 'kk_new'], [key, `'+ ${flatten(ru)[key]!.slice(1).trim()} (тест)`]]);
    expect(flatten(res.next)[key]!.startsWith('+ ')).toBe(true);
  });

  it('refuses a file Excel saved in a Windows code page', () => {
    expect(() => decodeReview(new Uint8Array([0x6b, 0x65, 0x79, 0x3b, 0xc6, 0xe0]))).toThrow(/UTF-8/);
    expect(decodeReview(new TextEncoder().encode('key;kk_new\r\n'))).toBe('key;kk_new\r\n');
  });
});
