import type { NoteColor } from '@/api/types';
import type { LocalRecord } from '@/db';
import { recordTitle, sourceLine, statusLine } from '@/records/format';
import { unverifiedCount } from '@/records/review';

/** «Стикер, жёлтый, приколот. Код домофона 4512. Сегодня» (template-screens 5). */
export function stickerLabel(
  record: LocalRecord,
  o: { color: NoteColor | null; pinned: boolean; index: number; total: number },
  t: (k: string, x?: Record<string, unknown>) => string,
  lang: string,
): string {
  return [
    t('notes.sticker_a11y', { n: o.index + 1, total: o.total }),
    t(`notes.colors_a11y.${o.color ?? 'white'}`),
    o.pinned ? t('notes.pinned_a11y') : null,
    recordTitle(record, t),
    sourceLine(record, lang, t),
    statusLine(record, t),
    unverifiedCount(record) > 0 ? t('check.badge') : null,
  ]
    .filter(Boolean)
    .join('. ');
}
