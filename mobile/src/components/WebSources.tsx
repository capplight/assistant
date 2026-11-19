import { Globe } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import { Linking, Pressable, View } from 'react-native';

import type { ChatMessage } from '@/store/assistant';
import { useTheme } from '@/theme';

import { AppText } from './AppText';

/** «zakon.kz» from a URL (no «www.»). */
export function siteOf(url: string): string {
  const m = /^https?:\/\/([^/?#]+)/iu.exec(url);
  return (m?.[1] ?? url).replace(/^www\./iu, '').toLowerCase();
}

/**
 * Ф-87: the answer text ends with «Источники: zakon.kz, …». When the `web_sources` event came, the links below show
 * them, so that last line is hidden (never twice).
 */
export function answerBody(m: Pick<ChatMessage, 'text' | 'webSources'>): string {
  if (!m.webSources || m.webSources.length === 0) return m.text;
  return m.text.replace(/\n*\s*(Источники|Дереккөздер|Sources)\s*:[^\n]*\s*$/u, '').trimEnd();
}

/** The web pages under an answer: small tappable links «🌐 zakon.kz», one row that wraps (v5 `.lnk`, 14). */
export function WebSources({ m, testID }: { m: Pick<ChatMessage, 'id' | 'webSources'>; testID?: string }) {
  const theme = useTheme();
  const { t } = useTranslation();
  const list = (m.webSources ?? []).slice(0, 6);
  if (list.length === 0) return null;
  return (
    <View testID={testID ?? `web-sources-${m.id}`} style={{ gap: 2 }}>
      <AppText variant="caption" style={{ color: theme.colors.ink3 }}>
        {t('chat.web_sources')}
      </AppText>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', columnGap: 14 }}>
        {list.map((s, i) => (
          <Pressable
            key={`${s.url}-${i}`}
            testID={`web-source-${i}`}
            accessibilityRole="link"
            accessibilityLabel={t('chat.web_source_a11y', { site: siteOf(s.url), title: s.title ?? '' })}
            onPress={() => void Linking.openURL(s.url).catch(() => undefined)}
            hitSlop={8}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 4,
              minHeight: 32,
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Globe size={14} color={theme.colors.ink2} strokeWidth={2} />
            <AppText
              numberOfLines={1}
              nativeID="v5-one-line"
              style={{
                fontFamily: theme.type.bodyStrong.fontFamily,
                fontSize: 14,
                lineHeight: 18,
                color: theme.colors.ink,
                textDecorationLine: 'underline',
              }}
            >
              {siteOf(s.url)}
            </AppText>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
