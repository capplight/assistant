import { Children, isValidElement, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { ScrollViewProps } from 'react-native';
import type { Edge } from 'react-native-safe-area-context';

import type { PlaceKey } from '@/theme';

import { Header } from './ui/Header';
import { PlaceScreen, type PlaceScreenProps } from './ui/PlaceScreen';

type Props = {
  children: ReactNode;
  /** Pinned at the bottom of the paper (outside the scroll), e.g. «Подходит». */
  footer?: ReactNode;
  /** v2 prop, ignored: the v5 sheet handles the safe areas itself. */
  edges?: Edge[];
  scroll?: boolean;
  contentContainerStyle?: ScrollViewProps['contentContainerStyle'];
  testID?: string;
  /** v5: the sheet colour of the place (default stone — service screens). */
  place?: PlaceKey;
} & Pick<PlaceScreenProps, 'peek' | 'phrase' | 'mode' | 'askRoom' | 'stripMeta' | 'sub' | 'paperTone' | 'scrollRef' | 'onScroll' | 'onContentSizeChange' | 'metaNode' | 'sheetExtra' | 'sheetExtraHeight' | 'paperPadding' | 'hideTitle'> &
  /** Overrides of what the first `<Header>` gives (a tool's own sub-screen: «‹ Расходы · Транспорт»). */
  Partial<Pick<PlaceScreenProps, 'title' | 'back' | 'actions'>>;

/**
 * Every screen in the v5 look (design-system §11): a `PlaceScreen`. When the first child is a `<Header>`, it becomes
 * the coloured sheet (title, meta, «‹ Назад», ≤ 2 icons, its accessory and children); without a header the screen is
 * the paper alone on the tray.
 */
export function Screen({ children, footer, scroll = true, contentContainerStyle, testID, place = 'stone', mode, sheetExtra, ...rest }: Props) {
  const { t } = useTranslation();
  const all = Children.toArray(children);
  const first = all[0];
  const header = isValidElement(first) && first.type === Header ? (first as ReactElement<ComponentProps<typeof Header>>).props : null;
  const body = header ? all.slice(1) : all;
  return (
    <PlaceScreen
      place={place}
      mode={header ? mode : 'bare'}
      title={header?.title ?? ''}
      meta={header?.meta}
      back={header?.back ? { label: header.back.label ?? t('common.back'), onPress: header.back.onPress, testID: header.back.testID ?? 'header-back', iconOnly: header.back.iconOnly } : undefined}
      actions={header?.actions}
      accessory={header?.accessory}
      sheetExtra={sheetExtra ?? header?.children}
      headerTestID={header?.testID}
      titleTestID={header?.titleTestID}
      scroll={scroll}
      footer={footer}
      contentContainerStyle={contentContainerStyle as PlaceScreenProps['contentContainerStyle']}
      testID={testID}
      {...rest}
    >
      {body}
    </PlaceScreen>
  );
}
