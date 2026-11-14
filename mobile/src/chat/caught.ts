import { looksLikeReminder, wantsAlarm } from '@/alarms/format';

/**
 * «Поймал так» (design-system v2 AssistantCapsule «ввод»): while the person types a reminder phrase, the line shows
 * what it understood — «Будильник · завтра, 08:00 · Дела». A preview only, read by code on the phone: nothing is set
 * from it; the server reads the sent phrase as before (ConfirmCard). Unknown parts are left out, never guessed.
 */
export type Caught = { alarm: boolean; day: string | null; time: string | null; parts: string[] };

const DAYS: [RegExp, string][] = [
  [/(^|\s)послезавтра(\s|$)/u, 'day_after'],
  [/(^|\s)завтра(\s|$)|(^|\s)ертең(\s|$)/u, 'tomorrow'],
  [/(^|\s)сегодня(\s|$)|(^|\s)бүгін(\s|$)/u, 'today'],
  [/(^|\s)в понедельник/u, 'mon'],
  [/(^|\s)во вторник/u, 'tue'],
  [/(^|\s)в среду/u, 'wed'],
  [/(^|\s)в четверг/u, 'thu'],
  [/(^|\s)в пятницу/u, 'fri'],
  [/(^|\s)в субботу/u, 'sat'],
  [/(^|\s)в воскресенье/u, 'sun'],
];

export function caught(text: string): Caught | null {
  const t = text.trim().toLowerCase();
  if (!looksLikeReminder(t)) return null;
  const parts: string[] = [];
  let day: string | null = null;
  for (const [re, key] of DAYS) {
    const m = re.exec(t);
    if (m) {
      day = key;
      parts.push(m[0].trim());
      break;
    }
  }
  let time: string | null = null;
  const tm = /(?:^|\s)в\s(\d{1,2})(?:[:.](\d{2}))?(?:\s(утра|вечера|дня))?(?=\s|$)/u.exec(t) ?? /(?:^|\s)(\d{1,2}):(\d{2})(?=\s|$)/u.exec(t);
  if (tm) {
    let h = Number(tm[1]);
    const min = tm[2] ? Number(tm[2]) : 0;
    if (tm[3] === 'вечера' && h < 12) h += 12;
    if (tm[3] === 'дня' && h < 12) h += 12;
    if (h <= 23 && min <= 59) {
      time = `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
      parts.push(tm[0].trim());
    }
  }
  return { alarm: wantsAlarm(t), day, time, parts };
}
