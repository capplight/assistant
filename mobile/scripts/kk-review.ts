/**
 * KK native-speaker review (week 17, 2-design §7.3, F-22 / R-39).
 *
 *   node scripts/kk-review.ts check                 automated checks, exit 1 on a blocking problem
 *   node scripts/kk-review.ts export [file]         → ../docs/i18n/kk-review.csv (UTF-8 with BOM, «;»)
 *   node scripts/kk-review.ts import <file> [--dry-run]
 *                                                   apply the reviewer's «kk_new» column to kk.json
 *   node scripts/kk-review.ts fix-latin             replace Latin look-alike letters inside KK words
 *
 * Run from `mobile/` (Node ≥ 22.18 runs .ts directly). Self-contained on purpose: only node built-ins,
 * so the same file is imported by Jest (`src/__tests__/i18n.test.ts`) and run by Node without a build.
 * Blocking (check exits 1, the Jest test fails): a KK key missing for a RU key, a broken {{variable}},
 * a missing plural form for kk (i18next: one / other). Everything else is a note for the reviewer.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type Dict = { [k: string]: string | Dict };
export type Flat = Record<string, string>;

const PLURAL_SUFFIXES = ['zero', 'one', 'two', 'few', 'many', 'other'] as const;
/** i18next takes the forms from Intl.PluralRules: kk has one / other, ru one / few / many / other. */
export const KK_PLURALS = ['one', 'other'] as const;
export const RU_PLURALS = ['one', 'few', 'many', 'other'] as const;
/** KK = RU is right here (a language's own name, brand names). */
export const SAME_AS_RU_OK = new Set<string>(['lang.ru', 'lang.kk', 'voice.kk_beta']);
/** A KK string this many times longer than RU is flagged for a 200% layout check. */
export const LONG_RATIO = 1.5;

// ---------- files ----------

export function mobileRoot(): string {
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, 'src', 'i18n', 'locales', 'ru.json'))) return cwd;
  const nested = path.join(cwd, 'mobile');
  if (fs.existsSync(path.join(nested, 'src', 'i18n', 'locales', 'ru.json'))) return nested;
  throw new Error('Run from mobile/ (src/i18n/locales/ru.json not found)');
}
export const localePath = (lang: 'ru' | 'kk', root = mobileRoot()) => path.join(root, 'src', 'i18n', 'locales', `${lang}.json`);
export const defaultReviewPath = (root = mobileRoot()) => path.join(root, '..', 'docs', 'i18n', 'kk-review.csv');

export function readLocale(lang: 'ru' | 'kk', root = mobileRoot()): Dict {
  return JSON.parse(fs.readFileSync(localePath(lang, root), 'utf8')) as Dict;
}

/** The line ending a file already uses (git checks it out as LF on Linux, CRLF on Windows). */
export function eolOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

/** Same layout as the file in the repo: 2 spaces, the file's own line ending, final newline (checked in Jest). */
export function serializeLocale(d: Dict, eol = '\n'): string {
  return (JSON.stringify(d, null, 2) + '\n').replace(/\n/g, eol);
}

// ---------- shape ----------

export function flatten(d: Dict, prefix = '', out: Flat = {}): Flat {
  for (const [k, v] of Object.entries(d)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else flatten(v, key, out);
  }
  return out;
}

/** Sets an existing or new leaf; keeps the order of existing keys (a new key goes last in its object). */
export function setLeaf(d: Dict, key: string, value: string): void {
  const parts = key.split('.');
  let node: Dict = d;
  for (const p of parts.slice(0, -1)) {
    const next = node[p];
    if (next === undefined) node[p] = {};
    else if (typeof next === 'string') throw new Error(`${key}: «${p}» is a string, not an object`);
    node = node[p] as Dict;
  }
  node[parts[parts.length - 1]!] = value;
}

const isMeta = (key: string) => key === '_meta' || key.startsWith('_meta.');

/** `exp.count_one` → `{ base: 'exp.count', form: 'one' }` when a sibling plural form exists. */
export function pluralOf(key: string, all: Flat): { base: string; form: string } | null {
  const m = /^(.*)_(zero|one|two|few|many|other)$/.exec(key);
  if (!m) return null;
  const base = m[1]!;
  const siblings = PLURAL_SUFFIXES.filter((f) => `${base}_${f}` in all);
  return siblings.length >= 2 ? { base, form: m[2]! } : null;
}

export function pluralBases(all: Flat): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const key of Object.keys(all)) {
    const p = pluralOf(key, all);
    if (p) out.set(p.base, [...(out.get(p.base) ?? []), p.form]);
  }
  return out;
}

// ---------- text checks ----------

/** `{{n}}`, `{{ count }}`, `{{amount, number}}` → n, count, amount; also `$t(key)` nesting. */
export function variables(s: string): string[] {
  const vars = new Set<string>();
  for (const m of s.matchAll(/\{\{\s*-?\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g)) vars.add(m[1]!);
  for (const m of s.matchAll(/\$t\(\s*([\w.:-]+)/g)) vars.add(`$t:${m[1]!}`);
  return [...vars].sort();
}

const KAZAKH_ONLY = /[әғқңөұүһіӘҒҚҢӨҰҮҺІ]/u;
const CYRILLIC = /\p{Script=Cyrillic}/u;
const LATIN = /\p{Script=Latin}/u;

/** Latin letter → its Cyrillic twin (Kazakh і for i). */
export const LATIN_TO_CYRILLIC: Record<string, string> = {
  a: 'а', c: 'с', e: 'е', h: 'һ', i: 'і', k: 'к', o: 'о', p: 'р', x: 'х', y: 'у',
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', I: 'І', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
};

/** Text without {{variables}}, so `{{page}}` never counts as a Latin word. */
const plain = (s: string) => s.replace(/\{\{[^}]*\}\}/g, ' ').replace(/\$t\([^)]*\)/g, ' ');

/** Words that mix Latin and Cyrillic letters, e.g. «бeт» with a Latin «e». */
export function mixedWords(s: string): string[] {
  return (plain(s).match(/[\p{L}\p{M}]+/gu) ?? []).filter((w) => CYRILLIC.test(w) && LATIN.test(w));
}

/** Fixes a mixed word only when every Latin letter in it has a Cyrillic twin and most of it is Cyrillic. */
export function fixLatin(s: string): string {
  return s.replace(/[\p{L}\p{M}]+/gu, (w) => {
    if (!(CYRILLIC.test(w) && LATIN.test(w))) return w;
    const letters = [...w];
    const latin = letters.filter((ch) => LATIN.test(ch));
    if (latin.length * 2 >= letters.length || latin.some((ch) => !(ch in LATIN_TO_CYRILLIC))) return w;
    return letters.map((ch) => (LATIN.test(ch) ? LATIN_TO_CYRILLIC[ch]! : ch)).join('');
  });
}

/** Visible length, without {{variables}} (they are filled at run time). */
export const visibleLength = (s: string) => [...s.replace(/\{\{[^}]*\}\}/g, '')].length;

// ---------- the checks ----------

export type Issue = { key: string; detail: string };
export type Report = {
  ruKeys: number;
  kkKeys: number;
  missing: Issue[];
  extra: Issue[];
  untranslated: Issue[];
  possiblyRussian: Issue[];
  variables: Issue[];
  plurals: Issue[];
  latin: Issue[];
  tooLong: Issue[];
  unusedPluralForms: Issue[];
  /** Spacing, «» pairs, «...», end punctuation unlike RU. */
  typography: Issue[];
  /** RU names a screen or button in «»; KK does not use that screen's KK name. */
  uiNames: Issue[];
};

export const blocking = (r: Report) => r.missing.length + r.variables.length + r.plurals.length;

export function check(ru: Dict, kk: Dict): Report {
  const R = flatten(ru);
  const K = flatten(kk);
  const r: Report = {
    ruKeys: 0, kkKeys: 0, missing: [], extra: [], untranslated: [], possiblyRussian: [],
    variables: [], plurals: [], latin: [], tooLong: [], unusedPluralForms: [], typography: [], uiNames: [],
  };
  const ruPlural = pluralBases(R);
  const kkPlural = pluralBases(K);
  const ruKeys = Object.keys(R).filter((k) => !isMeta(k));
  const kkKeys = Object.keys(K).filter((k) => !isMeta(k));
  r.ruKeys = ruKeys.length;
  r.kkKeys = kkKeys.length;

  // Plural groups: kk needs one + other; their variables are the RU group's.
  for (const [base, forms] of ruPlural) {
    const ruVars = new Set(forms.flatMap((f) => variables(R[`${base}_${f}`]!)));
    for (const f of RU_PLURALS) if (!forms.includes(f)) r.plurals.push({ key: `${base}_${f}`, detail: 'RU plural form missing' });
    for (const f of KK_PLURALS) {
      const k = `${base}_${f}`;
      if (!(k in K)) {
        r.plurals.push({ key: k, detail: 'KK plural form missing (i18next uses one / other for kk)' });
        continue;
      }
      const kv = variables(K[k]!);
      const lost = [...ruVars].filter((v) => !kv.includes(v) && !(f === 'one' && v === 'count'));
      const added = kv.filter((v) => !ruVars.has(v));
      if (lost.length || added.length)
        r.variables.push({ key: k, detail: `RU {${[...ruVars].join(', ')}} · KK {${kv.join(', ')}}` });
    }
    for (const f of kkPlural.get(base) ?? []) {
      if (!(KK_PLURALS as readonly string[]).includes(f))
        r.unusedPluralForms.push({ key: `${base}_${f}`, detail: 'never shown in kk (one / other only)' });
    }
  }

  for (const key of ruKeys) {
    const p = pluralOf(key, R);
    if (p) continue; // plural groups above
    const ruText = R[key]!;
    const kkText = K[key];
    if (kkText === undefined) {
      r.missing.push({ key, detail: ruText });
      continue;
    }
    const rv = variables(ruText);
    const kv = variables(kkText);
    if (rv.join('|') !== kv.join('|')) r.variables.push({ key, detail: `RU {${rv.join(', ')}} · KK {${kv.join(', ')}}` });
  }

  for (const key of kkKeys) {
    if (!(key in R) && !pluralOf(key, K)) r.extra.push({ key, detail: K[key]! });
  }

  for (const key of kkKeys) {
    const kkText = K[key]!;
    const p = pluralOf(key, K);
    const ruText = R[key] ?? (p ? R[`${p.base}_other`] : undefined);
    if (p && !(KK_PLURALS as readonly string[]).includes(p.form)) continue;
    if (ruText !== undefined && kkText === ruText && CYRILLIC.test(plain(ruText)) && !SAME_AS_RU_OK.has(key))
      r.untranslated.push({ key, detail: kkText });
    else if (
      ruText !== undefined &&
      CYRILLIC.test(plain(kkText)) &&
      !KAZAKH_ONLY.test(kkText) &&
      visibleLength(kkText) >= 25 &&
      !SAME_AS_RU_OK.has(key)
    )
      r.possiblyRussian.push({ key, detail: kkText });
    const mixed = mixedWords(kkText);
    if (mixed.length) r.latin.push({ key, detail: mixed.join(', ') });
    if (ruText !== undefined) {
      const a = visibleLength(ruText);
      const b = visibleLength(kkText);
      if (a > 0 && b > a * LONG_RATIO && b - a >= 4) r.tooLong.push({ key, detail: `RU ${a} → KK ${b} (×${(b / a).toFixed(1)})` });
      const typo = typography(ruText, kkText);
      if (typo.length) r.typography.push({ key, detail: typo.join('; ') });
    }
  }

  // «Удалённые записи» in a RU sentence is the name of a screen: KK should quote that screen's KK name.
  const byValue = new Map<string, string[]>();
  for (const [k, v] of Object.entries(R)) if (v.length <= 30 && !v.includes('{{')) byValue.set(v, [...(byValue.get(v) ?? []), k]);
  for (const key of kkKeys) {
    const ruText = R[key];
    const kkText = K[key]!;
    if (ruText === undefined) continue;
    for (const m of ruText.matchAll(/«([^«»]+)»/g)) {
      const named = byValue.get(m[1]!);
      if (!named || named.some((k) => K[k] !== undefined && kkText.includes(K[k]!))) continue;
      const names = [...new Set(named.map((k) => K[k]).filter(Boolean))].join(' / ');
      r.uiNames.push({ key, detail: `«${m[1]}» is «${names}» in KK (${named.join(', ')})` });
    }
  }
  return r;
}

export function typography(ru: string, kk: string): string[] {
  const out: string[] = [];
  if (/ {2}/.test(kk)) out.push('double space');
  if (kk !== kk.trim()) out.push('space at an edge');
  if ((kk.match(/«/g) ?? []).length !== (kk.match(/»/g) ?? []).length) out.push('«» not paired');
  if (kk.includes('...')) out.push('«...» instead of «…»');
  const end = (s: string) => /[.?!:…]$/.exec(s.trim())?.[0] ?? '';
  // RU «дн.» / «мин.» are abbreviations, not sentence ends.
  if (end(ru) !== end(kk) && !/\s\p{L}{1,4}\.$/u.test(ru.trim())) out.push(`ends «${end(ru)}» in RU, «${end(kk)}» in KK`);
  return out;
}

export function formatReport(r: Report): string {
  const lines = [
    `RU keys: ${r.ruKeys}, KK keys: ${r.kkKeys}`,
    `missing in KK: ${r.missing.length}`,
    `extra in KK (not in RU): ${r.extra.length}`,
    `KK = RU (untranslated): ${r.untranslated.length}`,
    `no Kazakh letter in a long KK string (maybe Russian): ${r.possiblyRussian.length}`,
    `variable mismatch: ${r.variables.length}`,
    `plural forms missing: ${r.plurals.length}`,
    `Latin letters inside Cyrillic words: ${r.latin.length}`,
    `KK > ${LONG_RATIO}× RU (layout check at 200%): ${r.tooLong.length}`,
    `unused KK plural forms (few/many): ${r.unusedPluralForms.length}`,
    `typography (spaces, «», end punctuation): ${r.typography.length}`,
    `a screen name quoted in RU, another name in KK: ${r.uiNames.length}`,
  ];
  const section = (title: string, list: Issue[], max = 400) =>
    list.length ? [``, `## ${title}`, ...list.slice(0, max).map((i) => `  ${i.key}: ${i.detail}`)] : [];
  return [
    ...lines,
    ...section('missing', r.missing),
    ...section('variables', r.variables),
    ...section('plurals', r.plurals),
    ...section('untranslated', r.untranslated),
    ...section('maybe Russian', r.possiblyRussian),
    ...section('latin', r.latin),
    ...section('extra', r.extra),
    ...section('typography', r.typography),
    ...section('screen names', r.uiNames),
    ...section('too long', r.tooLong),
  ].join('\n');
}

// ---------- where a key is used ----------

const SOURCE_EXT = /\.(tsx?|jsx?)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === '__tests__' || e.name === 'testing' || e.name === 'node_modules') continue;
      walk(p, out);
    } else if (SOURCE_EXT.test(e.name)) out.push(p);
  }
  return out;
}

/** `src/app/(main)/page/[id].tsx` → `screen /page/[id]`; a component → its file name. */
export function contextName(rel: string): string {
  const r = rel.replace(/\\/g, '/');
  if (r.startsWith('app/')) {
    const route = r.slice(4).replace(SOURCE_EXT, '').replace(/\([^)]*\)\//g, '').replace(/(^|\/)index$/, '$1').replace(/^_layout$/, 'layout');
    return `screen /${route}`;
  }
  return r.replace(SOURCE_EXT, '');
}

/** key → files that name it, literally (`t('a.b')`) or by a template prefix (`t(\`kp.err_${code}\`)`). */
export function keyUsage(root = mobileRoot()): Map<string, string[]> {
  const src = path.join(root, 'src');
  const literal = new Map<string, Set<string>>();
  const prefixes: { prefix: string; file: string }[] = [];
  for (const file of walk(src)) {
    const rel = contextName(path.relative(src, file));
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/['"`]([a-z_][\w-]*(?:\.[\w-]+)+)['"`]/g)) {
      const set = literal.get(m[1]!) ?? new Set<string>();
      set.add(rel);
      literal.set(m[1]!, set);
    }
    // Top-level keys (`t('saved')`) have no dot.
    for (const m of text.matchAll(/\bt\(\s*['"]([a-z_]\w*)['"]/g)) {
      const set = literal.get(m[1]!) ?? new Set<string>();
      set.add(rel);
      literal.set(m[1]!, set);
    }
    for (const m of text.matchAll(/`([a-z_][\w-]*\.[\w.-]*)\$\{/g)) prefixes.push({ prefix: m[1]!, file: rel });
  }
  const out = new Map<string, string[]>([...literal].map(([k, v]) => [k, [...v]]));
  // Template-literal prefixes ride along under a key no translation can have.
  out.set('__prefixes__', prefixes.map((p) => `${p.prefix}\u0000${p.file}`));
  return out;
}

export function usedIn(key: string, usage: Map<string, string[]>, all: Flat): string[] {
  const p = pluralOf(key, all);
  const base = p ? p.base : key;
  const direct = usage.get(base) ?? usage.get(key);
  if (direct?.length) return direct;
  const viaPrefix = (usage.get('__prefixes__') ?? [])
    .map((s) => s.split('\u0000') as [string, string])
    .filter(([prefix]) => base.startsWith(prefix))
    .map(([, file]) => file);
  return [...new Set(viaPrefix)];
}

// ---------- §7.3 of the design spec ----------

/** KK values of the §7.3 table (the spec's own drafts) and the native-speaker questions under it. */
export function specDrafts(root = mobileRoot()): Set<string> {
  const file = path.join(root, '..', 'docs', 'spec', 'final', '2-design.md');
  if (!fs.existsSync(file)) return new Set();
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf('### 7.3');
  const end = text.indexOf('### 7.4', start);
  if (start < 0) return new Set();
  const out = new Set<string>();
  for (const line of text.slice(start, end).split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5 || !/^\d+$/.test(cells[1] ?? '')) continue;
    for (const v of (cells[3] ?? '').split(/ \/ | · /)) if (v) out.add(v.trim());
  }
  return out;
}

/** The questions of 2-design §7.3 for the native speaker, by key. */
export const SPEC_QUESTIONS: Record<string, string> = {
  'common.undo': '«Болдырмау» или «Қайтару» для «Отменить»?',
  'tpl.tasks': '«Істер» или «Тапсырмалар» для «Дела»?',
  'tpl.short.tasks': '«Істер» или «Тапсырмалар» для «Дела»?',
  'mic.understood': 'Естественно ли «Былай түсіндім»?',
  'consent.no_ai': 'Понятно ли «ЖИ» людям 45+ или писать полностью «жасанды интеллект»?',
  'ai.label': 'Понятно ли «ЖИ» людям 45+ или писать полностью «жасанды интеллект»?',
  'pages.my': '«бет» для «страница» понятно (или «парақ»)?',
  'tabs.more': '«Тағы» или «Басқасы» для «Ещё»?',
  'chat.title': '«Хат алмасу» или «Сөйлесу» для «Переписка»?',
  'tpl.documents': '«КҰ» (коммерциялық ұсыныс) — понятное ли сокращение?',
  'gallery.ok': '«Жарайды» для «Подходит»?',
};

// ---------- the review file ----------

export const COLUMNS = ['key', 'where', 'ru', 'kk', 'kk_new', 'comment', 'checks', 'length', 'source'] as const;
export type Column = (typeof COLUMNS)[number];
export type Row = Record<Column, string>;

/** Length note: what the place on screen can take at 200% on a 320 pt phone. */
export function lengthNote(key: string, ru: string, kk: string): string {
  const a = visibleLength(ru);
  const b = visibleLength(kk);
  const base = `RU ${a} / KK ${b}`;
  if (/a11y|_spoken|spoken_/.test(key)) return `${base} · только для чтения с экрана, длина свободна`;
  if (key.startsWith('tpl.short.') || key.startsWith('tabs.'))
    return `${base} · подпись вкладки: при 200% ~4–5 букв в строке, переносится; короче — лучше`;
  if (/^(common\.|line\.(send|write|open)|answer\.(open|close))/.test(key) || /(_btn|\.ok|\.yes|\.no|\.cancel|\.save|\.done)$/.test(key))
    return `${base} · кнопка: при 200% ~12 букв в строке, переносится`;
  if (b > a * LONG_RATIO && b - a >= 4) return `${base} · длиннее RU в ${(b / a).toFixed(1)} раза — проверить при 200%`;
  return base;
}

export function buildRows(ru: Dict, kk: Dict, usage: Map<string, string[]>, drafts: Set<string>): Row[] {
  const R = flatten(ru);
  const K = flatten(kk);
  const report = check(ru, kk);
  const notes = new Map<string, string[]>();
  const note = (key: string, s: string) => notes.set(key, [...(notes.get(key) ?? []), s]);
  for (const i of report.untranslated) note(i.key, 'KK = RU: не переведено или заимствованное слово — подтвердить');
  for (const i of report.typography) note(i.key, `типографика: ${i.detail}`);
  for (const i of report.uiNames) note(i.key, `название экрана: ${i.detail}`);
  for (const i of report.possiblyRussian) note(i.key, 'нет казахских букв — возможно, по-русски');
  for (const i of report.latin) note(i.key, `латинские буквы в словах: ${i.detail}`);
  for (const i of report.variables) note(i.key, `переменные не совпадают: ${i.detail}`);
  for (const i of report.tooLong) note(i.key, `длиннее RU: ${i.detail}`);
  for (const i of report.missing) note(i.key, 'нет в KK — показывается по-русски');

  const rows: Row[] = [];
  const keys = Object.keys(R).filter((k) => !isMeta(k));
  for (const key of keys) {
    const p = pluralOf(key, R);
    // kk shows one / other only: the reviewer sees those two, each with the RU «other» form.
    if (p && !(KK_PLURALS as readonly string[]).includes(p.form)) continue;
    const ruText = R[key]!;
    const kkText = K[key] ?? '';
    const where = usedIn(key, usage, R);
    const checks = [...(notes.get(key) ?? [])];
    if (p) checks.push(`форма «${p.form}» (${p.form === 'one' ? 'при 1, 21, 31…' : 'остальные числа'}); {{count}} — число`);
    if (variables(ruText).length) checks.push(`оставить как есть: ${variables(ruText).map((v) => `{{${v}}}`).join(' ')}`);
    rows.push({
      key,
      where: where.length ? where.slice(0, 4).join(', ') + (where.length > 4 ? ` +${where.length - 4}` : '') : 'не найдено в коде (сервер / динамический ключ)',
      ru: ruText,
      kk: kkText,
      kk_new: '',
      comment: SPEC_QUESTIONS[key] ?? '',
      checks: checks.join(' · '),
      length: lengthNote(key, ruText, kkText),
      source: drafts.has(kkText) ? 'ТЗ §7.3 (черновик)' : 'черновик разработчика',
    });
  }
  // The `where` file gives the screen; sort by it so a reviewer goes screen by screen.
  return rows.sort((a, b) => (a.where === b.where ? 0 : a.where < b.where ? -1 : 1) || 0);
}

// ---------- CSV (RFC 4180, Excel-friendly) ----------

export const BOM = '﻿';

/** Excel reads a cell starting with = + - @ as a formula: such cells get a leading «'», removed on import. */
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(v: string, delimiter: string): string {
  const s = FORMULA_START.test(v) ? `'${v}` : v;
  return /["\r\n]/.test(s) || s.includes(delimiter) || s !== s.trim() ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: Row[], delimiter = ';'): string {
  const lines = [COLUMNS.join(delimiter), ...rows.map((r) => COLUMNS.map((c) => cell(r[c], delimiter)).join(delimiter))];
  return BOM + lines.join('\r\n') + '\r\n';
}

export function parseCsv(text: string): string[][] {
  const s = text.startsWith(BOM) ? text.slice(1) : text;
  const firstLine = s.slice(0, s.search(/\r?\n|$/));
  const delimiter = [';', ',', '\t'].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c !== ''));
}

const unprotect = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);

/** Decodes the reviewer's file; refuses a file Excel re-saved in a Windows code page (Kazakh letters lost). */
export function decodeReview(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    throw new Error('The file is not UTF-8. In Excel save as «CSV UTF-8 (разделители — запятые)», or export from Google Sheets as CSV.');
  }
}

export type Change = { key: string; from: string; to: string };
export type ImportResult = { next: Dict; changed: Change[]; rejected: { key: string; reason: string }[]; unchanged: number };

/** Applies the `kk_new` column: only filled cells that differ; unknown keys and broken variables are refused. */
export function applyReview(ru: Dict, kk: Dict, table: string[][]): ImportResult {
  const header = table[0]?.map((h) => h.trim().replace(/^﻿/, '')) ?? [];
  const col = (name: Column) => header.indexOf(name);
  if (col('key') < 0 || col('kk_new') < 0) throw new Error('The file has no «key» / «kk_new» columns (first line).');
  const R = flatten(ru);
  const next = JSON.parse(JSON.stringify(kk)) as Dict;
  const K = flatten(next);
  const changed: Change[] = [];
  const rejected: { key: string; reason: string }[] = [];
  let unchanged = 0;
  for (const line of table.slice(1)) {
    const key = (line[col('key')] ?? '').trim();
    const raw = unprotect(line[col('kk_new')] ?? '');
    if (!key || raw.trim() === '') continue;
    const value = raw.replace(/\r\n/g, '\n');
    if (!(key in R) || isMeta(key)) {
      rejected.push({ key, reason: 'no such RU key' });
      continue;
    }
    const p = pluralOf(key, R);
    const ruVars = p
      ? [...new Set(RU_PLURALS.flatMap((f) => (R[`${p.base}_${f}`] ? variables(R[`${p.base}_${f}`]!) : [])))].sort()
      : variables(R[key]!);
    const kv = variables(value);
    const lost = ruVars.filter((v) => !kv.includes(v) && !(p?.form === 'one' && v === 'count'));
    const added = kv.filter((v) => !ruVars.includes(v));
    if (lost.length || added.length) {
      rejected.push({ key, reason: `variables: need {${ruVars.join(', ')}}, got {${kv.join(', ')}}` });
      continue;
    }
    if (K[key] === value) {
      unchanged++;
      continue;
    }
    changed.push({ key, from: K[key] ?? '', to: value });
    setLeaf(next, key, value);
  }
  return { next, changed, rejected, unchanged };
}

// ---------- CLI ----------

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const root = mobileRoot();
  const ru = readLocale('ru', root);
  const kk = readLocale('kk', root);
  if (cmd === 'check') {
    const r = check(ru, kk);
    console.log(formatReport(r));
    return blocking(r) ? 1 : 0;
  }
  if (cmd === 'export') {
    const file = rest.find((a) => !a.startsWith('--')) ?? defaultReviewPath(root);
    const delimiter = rest.includes('--comma') ? ',' : ';';
    const rows = buildRows(ru, kk, keyUsage(root), specDrafts(root));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, toCsv(rows, delimiter), 'utf8');
    console.log(`${rows.length} rows → ${file}`);
    return 0;
  }
  if (cmd === 'import') {
    const file = rest.find((a) => !a.startsWith('--'));
    if (!file) {
      console.error('usage: node scripts/kk-review.ts import <file.csv> [--dry-run]');
      return 2;
    }
    const result = applyReview(ru, kk, parseCsv(decodeReview(fs.readFileSync(file))));
    for (const c of result.changed) console.log(`~ ${c.key}\n    было:  ${c.from}\n    стало: ${c.to}`);
    for (const x of result.rejected) console.log(`! ${x.key}: ${x.reason}`);
    console.log(`changed ${result.changed.length}, same ${result.unchanged}, refused ${result.rejected.length}`);
    if (!rest.includes('--dry-run') && result.changed.length) {
      fs.writeFileSync(localePath('kk', root), serializeLocale(result.next, eolOf(fs.readFileSync(localePath('kk', root), 'utf8'))), 'utf8');
      console.log(`written ${localePath('kk', root)}`);
    }
    return result.rejected.length ? 1 : 0;
  }
  if (cmd === 'fix-latin') {
    const K = flatten(kk);
    let n = 0;
    for (const [key, v] of Object.entries(K)) {
      const fixed = fixLatin(v);
      if (fixed !== v) {
        setLeaf(kk, key, fixed);
        console.log(`~ ${key}: ${v} → ${fixed}`);
        n++;
      }
    }
    if (n) fs.writeFileSync(localePath('kk', root), serializeLocale(kk, eolOf(fs.readFileSync(localePath('kk', root), 'utf8'))), 'utf8');
    console.log(`fixed ${n}`);
    return 0;
  }
  console.error('usage: node scripts/kk-review.ts check | export [file] [--comma] | import <file> [--dry-run] | fix-latin');
  return 2;
}

if (/kk-review\.ts$/.test(process.argv[1] ?? '')) process.exitCode = main(process.argv.slice(2));
