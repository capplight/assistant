import {
  Briefcase,
  CircleCheck,
  Ellipsis,
  FileText,
  HeartPulse,
  House,
  Layers,
  ShoppingCart,
  Sun,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react-native';

import type { IconKey } from '@/pages/templates';
import { useTheme, type ColorTokens } from '@/theme';

export type { LucideIcon };

/** The only icon sizes of the system (design-system §1): 20 / 24 / 28. */
export type IconSize = 'sm' | 'md' | 'lg';
const SIZES: Record<IconSize, 20 | 24 | 28> = { sm: 20, md: 24, lg: 28 };

export function iconPx(s: IconSize = 'md'): number {
  return SIZES[s];
}

type IconProps = {
  icon: LucideIcon;
  size?: IconSize;
  /** A colour role (default `ink`) or a literal colour (sticker / category palettes). */
  color?: keyof ColorTokens | (string & {});
  testID?: string;
};

/** Lucide, stroke 1.75, round caps. Decorative: the label is on the control around it. */
export function Icon({ icon: Cmp, size = 'md', color = 'ink', testID }: IconProps) {
  const theme = useTheme();
  const c = color in theme.colors ? (theme.colors[color as keyof ColorTokens] as string) : color;
  return (
    <Cmp
      testID={testID}
      size={SIZES[size]}
      color={c}
      strokeWidth={theme.icon.strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    />
  );
}

/** Page icons (templates catalogue). «Дела» uses the round check (the checkbox of the system). */
const PAGE_ICONS: Record<IconKey | 'more', LucideIcon> = {
  today: Sun,
  documents: FileText,
  tasks: CircleCheck,
  shopping: ShoppingCart,
  work: Briefcase,
  money: Wallet,
  other: Layers,
  people: Users,
  health: HeartPulse,
  home: House,
  more: Ellipsis,
};

export function pageIcon(name: IconKey | 'more'): LucideIcon {
  return PAGE_ICONS[name] ?? FileText;
}

/** A page's icon at a system size (or a literal px size kept for old call sites). */
export function PageIcon({ name, size = 24, color }: { name: IconKey | 'more'; size?: number; color: string }) {
  const theme = useTheme();
  const Cmp = PAGE_ICONS[name] ?? FileText;
  return <Cmp size={size} color={color} strokeWidth={theme.icon.strokeWidth} />;
}
