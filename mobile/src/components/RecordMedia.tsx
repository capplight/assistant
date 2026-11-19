import { useAudioPlayer, useAudioPlayerStatus } from 'expo-audio';
import * as Sharing from 'expo-sharing';
import { FileText, Pause, Play } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Image, Pressable, View } from 'react-native';

import type { RecordFile } from '@/db/records';
import { useTheme } from '@/theme';

import { AppText } from './AppText';

const BARS = 22;

/** A steady waveform for a recording: bar heights from the file hash (6…28), so it looks the same every time. */
export function waveOf(seed: string, n = BARS): number[] {
  let h = 2166136261;
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = seed.charCodeAt(i % Math.max(1, seed.length)) || 7;
    h = Math.imul(h ^ (c + i * 31), 16777619) >>> 0;
    out.push(6 + (h % 23));
  }
  // Calm ends, like speech fading in and out.
  out[0] = Math.min(out[0]!, 8);
  out[n - 1] = 6;
  return out;
}

const clock = (sec: number) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * screens-v5-extra «Запись · голосовая»: a 42 black ▶, the 28 high waveform (played part ink, the rest ink3) and the
 * length 13 on the right. Plays the first fragment; the length is of all fragments.
 */
export function VoicePlayer({ files }: { files: RecordFile[] }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const audio = files.filter((f) => f.mime.startsWith('audio/'));
  const first = audio[0];
  const player = useAudioPlayer(first ? { uri: first.uri } : null);
  const status = useAudioPlayerStatus(player);
  if (!first) return null;
  const total = audio.reduce((a, f) => a + (f.durationMs ?? 0), 0) / 1000 || status?.duration || 0;
  const playing = !!status?.playing;
  const at = status?.currentTime ?? 0;
  const share = total > 0 ? Math.min(1, at / total) : 0;
  const bars = waveOf(first.sha256 || first.uri);
  const toggle = () => {
    if (playing) player.pause();
    else {
      if (total > 0 && at >= total - 0.2) void player.seekTo(0);
      player.play();
    }
  };
  return (
    <View testID="record-voice" style={{ flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 10 }}>
      <Pressable
        testID="record-voice-play"
        accessibilityRole="button"
        accessibilityLabel={playing ? t('record.voice_pause') : t('record.voice_play', { time: clock(total) })}
        onPress={toggle}
        hitSlop={3}
        style={({ pressed }) => ({
          width: 42,
          height: 42,
          borderRadius: 21,
          backgroundColor: theme.colors.btn,
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.85 : 1,
        })}
      >
        {playing ? (
          <Pause size={20} color={theme.colors.onBtn} fill={theme.colors.onBtn} />
        ) : (
          <Play size={20} color={theme.colors.onBtn} fill={theme.colors.onBtn} style={{ marginLeft: 2 }} />
        )}
      </Pressable>
      <View
        testID="record-voice-wave"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{ flex: 1, height: 28, flexDirection: 'row', alignItems: 'center', gap: 3 }}
      >
        {bars.map((h, i) => (
          <View
            key={i}
            style={{
              width: 3,
              height: h,
              borderRadius: 2,
              backgroundColor:
                (i + 0.5) / bars.length <= share
                  ? theme.colors.ink
                  : playing || share > 0
                    ? theme.colors.ink3
                    : theme.colors.ink,
            }}
          />
        ))}
      </View>
      <AppText
        testID="record-voice-time"
        variant="caption"
        style={{ color: theme.colors.ink3, fontVariant: ['tabular-nums'] }}
      >
        {clock(playing || share > 0 ? at : total)}
      </AppText>
    </View>
  );
}

/**
 * screens-v5-extra «Запись · скриншот»: the photo on a paper2 card r16 at the top; a PDF the same card with its
 * name (the first page is drawn by the server later); a tap opens the file in the phone's viewer.
 */
export function RecordPreview({ files, kind }: { files: RecordFile[]; kind: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const img = files.find((f) => f.mime.startsWith('image/'));
  const pdf = files.find((f) => f.mime === 'application/pdf');
  const open = (f: RecordFile) =>
    void Sharing.shareAsync(f.uri, { mimeType: f.mime, dialogTitle: f.name ?? '' }).catch(() => undefined);
  if (img && (kind === 'image' || kind === 'screenshot' || !pdf))
    return (
      <Pressable
        testID="record-image"
        accessibilityRole="imagebutton"
        accessibilityLabel={t('record.open_photo')}
        onPress={() => open(img)}
        style={{ backgroundColor: theme.colors.paper2, borderRadius: 16, overflow: 'hidden', marginBottom: 10 }}
      >
        <Image source={{ uri: img.uri }} resizeMode="contain" style={{ width: '100%', aspectRatio: 4 / 3 }} />
      </Pressable>
    );
  if (pdf)
    return (
      <Pressable
        testID="record-pdf"
        accessibilityRole="button"
        accessibilityLabel={t('record.open_pdf', { name: pdf.name ?? 'PDF' })}
        onPress={() => open(pdf)}
        style={({ pressed }) => ({
          backgroundColor: theme.colors.paper2,
          borderRadius: 16,
          padding: 14,
          flexDirection: 'row',
          alignItems: 'center',
          gap: 12,
          marginBottom: 10,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <View
          style={{
            width: 48,
            height: 60,
            borderRadius: 8,
            backgroundColor: theme.colors.paper,
            borderWidth: 1,
            borderColor: theme.colors.line,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <FileText size={24} color={theme.colors.ink} strokeWidth={theme.icon.strokeWidth} />
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <AppText
            numberOfLines={2}
            style={{ fontFamily: theme.type.bodyStrong.fontFamily, fontSize: 15, lineHeight: 20 }}
          >
            {pdf.name ?? 'PDF'}
          </AppText>
          <AppText variant="caption" style={{ color: theme.colors.ink3 }}>
            {t('record.pdf_meta', { size: Math.max(1, Math.round(pdf.bytes / 1024)) })}
          </AppText>
        </View>
      </Pressable>
    );
  return null;
}
