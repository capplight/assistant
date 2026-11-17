import { router } from 'expo-router';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AppText } from '@/components/AppText';
import { Button, Header, PlaceTab, Row } from '@/components/ui';
import { Screen } from '@/components/Screen';
import { PlaceFlatList } from '@/components/ui/PlaceScreen';
import { purgeAt } from '@/db/records';
import { recordTitle, sourceLine } from '@/records/format';
import { useTrash } from '@/records/useRecords';
import { getRecordActions } from '@/services';
import { useToast } from '@/store/toast';
import { usePages } from '@/store/pages';
import { placeOfTemplate, useTheme } from '@/theme';

const DAY_MS = 86_400_000;

/** S31 «Удалённые записи»: 30 days, one tap brings a record back (R-33). Local, so it works offline. */
export default function TrashScreen() {
  const theme = useTheme();
  const { t, i18n } = useTranslation();
  const records = useTrash();
  const showToast = useToast((s) => s.show);
  const pages = usePages((s) => s.pages);
  const [now] = useState(() => Date.now());
  const back = () => (router.canGoBack() ? router.back() : router.replace('/more'));
  return (
    <Screen testID="trash-screen" scroll={false} sub={t('trash.sub')}>
      <Header title={t('trash.title')} back={{ onPress: back, label: t('more.title'), testID: 'trash-back' }} />
      <PlaceFlatList
        data={records ?? []}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ paddingTop: theme.space[2], paddingBottom: theme.space[4] }}
        ListEmptyComponent={
          records ? (
            <AppText testID="trash-empty" color="ink2" style={{ textAlign: 'center', paddingVertical: theme.space[8] }}>
              {t('trash.empty')}
            </AppText>
          ) : undefined
        }
        renderItem={({ item, index }) => {
          const title = recordTitle(item, t);
          const days = Math.max(1, Math.ceil((purgeAt(item) - now) / DAY_MS));
          // screens-v5 «Корзина»: a row with the tab of its place, «Восстановить» an ordinary link (the person's action).
          return (
            <Row first={index === 0} testID={`trash-${item.id}`}>
              <PlaceTab place={placeOfTemplate(pages.find((p) => p.id === item.pageId)?.templateKey)} />
              <View style={{ flex: 1 }}>
                <AppText numberOfLines={2}>{title}</AppText>
                <AppText variant="footnote">{sourceLine(item, i18n.language, t)}</AppText>
                <AppText variant="footnote">{t('trash.days_left', { n: days })}</AppText>
              </View>
              <Button
                testID={`trash-restore-${item.id}`}
                label={t('trash.restore')}
                accessibilityLabel={`${t('trash.restore')}: ${title}`}
                variant="link"
                size="small"
                onPress={() => {
                  showToast(t('trash.restored'));
                  void getRecordActions().then((a) => a.restore(item.id));
                }}
              />
            </Row>
          );
        }}
      />
    </Screen>
  );
}
