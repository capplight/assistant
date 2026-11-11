import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';

import { Gallery } from '@/components/Gallery';
import { DEFAULT_SET, startWithPages } from '@/onboarding/service';
import { DEFAULT_PREMARKED, TEMPLATES, type TemplateKey } from '@/pages/templates';
import { useSavedLine } from '@/store/connectivity';
import { premarksFor, useOnboarding } from '@/store/onboarding';

const isTemplateKey = (s: string): s is TemplateKey => TEMPLATES.some((t) => t.key === s);

/**
 * S35 in the first launch (R-48, US-23).
 * from=phrase (path 3): Notes + Tasks premarked (+ Documents / Expenses from the phrase and welcome picks).
 * Otherwise (path 1): only the tapped card (if any) + welcome picks.
 * «Подходит» makes the pages on the phone at once; the server gets them in one `POST /pages/batch`.
 * «Пропустить»: path 3 keeps what was premarked, path 1 gets the default set (Заметки + Дела).
 */
export default function GalleryScreen() {
  const savedLine = useSavedLine();
  const params = useLocalSearchParams<{ mark?: string; from?: string }>();
  const fromPhrase = params.from === 'phrase';
  const interests = useOnboarding((s) => s.interests);
  const complete = useOnboarding((s) => s.complete);
  const [initial] = useState<TemplateKey[]>(() => {
    const marks = (params.mark ?? '').split(',').filter(isTemplateKey);
    // Path 3: the ticks of the phrase rule (≤3); path 1: the tapped card + the welcome picks.
    return fromPhrase ? (marks.length > 0 ? marks : [...DEFAULT_PREMARKED]) : premarksFor(interests, marks);
  });

  const finish = async (keys: TemplateKey[]) => {
    const pages = await startWithPages(keys, fromPhrase ? 'phrase_first' : 'gallery');
    complete();
    // Path 1: open the first chosen page (S04b comes after the first saved record).
    // Path 3: the first result exists already, so S04b now, then «Сегодня».
    if (fromPhrase) router.replace({ pathname: '/phone', params: { next: 'home' } });
    else if (pages[0]) router.replace({ pathname: '/page/[id]', params: { id: pages[0].id } });
    else router.replace('/');
  };

  return (
    <Gallery
      mode={fromPhrase ? 'phrase' : 'gallery'}
      initial={initial}
      doneLine={fromPhrase ? savedLine : null}
      onDone={(keys) => void finish(keys)}
      onSkip={() => void finish(fromPhrase ? initial : [...DEFAULT_SET])}
    />
  );
}
