/**
 * QA v5-device-2 B3 («Не забыть 6 дела»): on the phone's JS engine `Intl.PluralRules` may be missing or know no
 * Russian, and i18next then always took the «other» form. A minimal CLDR rule for ru and kk (and en) is installed
 * when the engine's own is absent or wrong, so «1 дело, 2 дела, 5 дел, 21 дело» are right everywhere.
 */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

export function ruPlural(n: number): PluralCategory {
  if (!Number.isInteger(n)) return 'other';
  const m10 = Math.abs(n) % 10;
  const m100 = Math.abs(n) % 100;
  if (m10 === 1 && m100 !== 11) return 'one';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'few';
  return 'many';
}

const oneOther = (n: number): PluralCategory => (n === 1 ? 'one' : 'other');

function engineIsRight(): boolean {
  try {
    const P = (globalThis as { Intl?: typeof Intl }).Intl?.PluralRules;
    if (!P) return false;
    const ru = new P('ru');
    return (
      ru.select(6) === 'many' && ru.select(2) === 'few' && ru.select(21) === 'one' && new P('kk').select(2) === 'other'
    );
  } catch {
    return false;
  }
}

class MiniPluralRules {
  private lang: string;
  constructor(locales?: string | string[]) {
    const first = Array.isArray(locales) ? locales[0] : locales;
    this.lang = (first ?? 'ru').toLowerCase().slice(0, 2);
  }
  select(n: number): PluralCategory {
    return this.lang === 'ru' ? ruPlural(n) : oneOther(n);
  }
  resolvedOptions() {
    return {
      locale: this.lang,
      pluralCategories: this.lang === 'ru' ? ['one', 'few', 'many', 'other'] : ['one', 'other'],
      type: 'cardinal',
    };
  }
  static supportedLocalesOf(l: string | string[]) {
    return Array.isArray(l) ? l : [l];
  }
}

export function ensurePluralRules(): void {
  if (engineIsRight()) return;
  const g = globalThis as { Intl?: object };
  if (!g.Intl) g.Intl = {};
  try {
    Object.defineProperty(g.Intl, 'PluralRules', { value: MiniPluralRules, configurable: true, writable: true });
  } catch {
    // A frozen Intl: i18next keeps its own fallback.
  }
}
