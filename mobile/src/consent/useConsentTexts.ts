import { useEffect, useState } from 'react';

import type { Locale } from '@/api/types';
import { getApi } from '@/services';

import { bundledConsentTextsSync, loadConsentTexts, type ConsentTexts } from './texts';

/**
 * The consent texts in `language`: the bundled snapshot at once (offline-first), the server's texts when they
 * arrive (hash checked). Whatever is returned when the person presses the button is what gets recorded.
 */
export function useConsentTexts(language: Locale): ConsentTexts {
  const [fetched, setFetched] = useState<{ lang: string; texts: ConsentTexts } | null>(null);
  useEffect(() => {
    let alive = true;
    void loadConsentTexts(getApi(), language).then((x) => {
      if (alive && Object.values(x).some((t) => t.source === 'server')) setFetched({ lang: language, texts: x });
    });
    return () => {
      alive = false;
    };
  }, [language]);
  return fetched?.lang === language ? fetched.texts : bundledConsentTextsSync(language);
}
