/**
 * Colour tokens — «Бумага и чернила» (2-design §2.1).
 * Contrast ratios are documented in the spec; keep values in sync with it.
 */
export type ColorTokens = {
  bg: string;
  surface: string;
  ink: string;
  ink2: string;
  line: string;
  lineStrong: string;
  accent: string;
  onAccent: string;
  alarm: string;
  onAlarm: string;
  done: string;
  marker: string;
  markerSoft: string;
  warnText: string;
  focus: string;
  /** Sheet scrim (2-design §2.4). */
  scrim: string;
};

export type NoteColorKey = 'yellow' | 'pink' | 'green' | 'blue' | 'peach' | 'white';

/** The order of the colour picker: «Жёлтый» first (the classic sticky note). */
export const NOTE_COLOR_KEYS: readonly NoteColorKey[] = ['yellow', 'pink', 'green', 'blue', 'peach', 'white'];

export const lightColors: ColorTokens = {
  bg: '#F6F3EC',
  surface: '#FFFDF8',
  ink: '#1F1D1A',
  ink2: '#5E5A52',
  line: '#E3DDD0',
  lineStrong: '#8A8478',
  accent: '#2F4BD8',
  onAccent: '#FFFFFF',
  alarm: '#B4361E',
  onAlarm: '#FFFFFF',
  done: '#1E7A4C',
  marker: '#F2C94C',
  markerSoft: '#FBEFC4',
  warnText: '#7A5A00',
  focus: '#2F4BD8',
  scrim: 'rgba(31,29,26,0.4)',
};

/**
 * Week 11а, `color.note.*` (template-screens 3): six pastel sticker colours, `white` = `surface`.
 * Ink and ink2 on each are checked by a test (≥4.5:1). No violet (close to the «ИИ» look, §2.5).
 */
export const lightNoteColors: Record<NoteColorKey, string> = {
  yellow: '#FFF0A6',
  pink: '#FBDDE0',
  green: '#D9F0D3',
  blue: '#D8E6FA',
  peach: '#FDE3C8',
  white: '#FFFDF8',
};

/** Dark theme — warm graphite, not black. Tokens absent in the spec table fall back to sensible equivalents. */
export const darkColors: ColorTokens = {
  bg: '#16151A',
  surface: '#201F25',
  ink: '#ECE8DF',
  ink2: '#A9A49A',
  line: '#2E2C33',
  lineStrong: '#7E7A72',
  accent: '#8FA2FF',
  onAccent: '#16151A',
  alarm: '#FF8A70',
  onAlarm: '#16151A',
  done: '#5FCB95',
  marker: '#F2C94C',
  markerSoft: '#4A3F12',
  // Not specified for dark in 2-design §2.1 — marker is ≥7:1 on bg; TODO confirm with design.
  warnText: '#F2C94C',
  focus: '#8FA2FF',
  scrim: 'rgba(0,0,0,0.5)',
};

export const darkNoteColors: Record<NoteColorKey, string> = {
  yellow: '#4A4220',
  pink: '#4A2E33',
  green: '#2C4430',
  blue: '#2A3A52',
  peach: '#4A3523',
  white: '#201F25',
};

/** Full-screen Android alarm (S14) uses the same colours in both themes. */
export const alarmScreen = { bg: '#B4361E', text: '#FFFFFF' } as const;
