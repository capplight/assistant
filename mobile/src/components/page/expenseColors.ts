import { Baby, Car, Coffee, HeartPulse, Home, ReceiptText, ShoppingBasket, Tag } from 'lucide-react-native';

import { categoryColors, categoryTintAlpha, withAlpha, type CategoryKey, type Theme } from '@/theme';

import type { LucideIcon } from '../ui/Icon';

/**
 * «Категории как цветовая система» (research/expenses-documents.md, pattern 4): each category has one colour —
 * its icon circle, its bar share and its stack segment are the same. The 8 system keys map to the palette of
 * `tokens.ts`; own categories get a palette colour by their key (stable), no purple (it belongs to «ИИ»).
 */
const SYSTEM: Record<string, { color: CategoryKey; icon: LucideIcon }> = {
  groceries: { color: 'food', icon: ShoppingBasket },
  transport: { color: 'transport', icon: Car },
  home: { color: 'home', icon: Home },
  cafe_gifts: { color: 'cafe', icon: Coffee },
  health: { color: 'health', icon: HeartPulse },
  family: { color: 'kids', icon: Baby },
  utilities: { color: 'bills', icon: ReceiptText },
  other: { color: 'other', icon: Tag },
};

const OWN: CategoryKey[] = ['food', 'transport', 'home', 'cafe', 'health', 'kids', 'bills'];

function colorKey(key: string | null): CategoryKey {
  if (!key) return 'other';
  const s = SYSTEM[key];
  if (s) return s.color;
  let h = 0;
  for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return OWN[h % OWN.length]!;
}

export type CategoryLook = { color: string; tint: string; icon: LucideIcon };

export function categoryLook(theme: Pick<Theme, 'scheme'>, key: string | null): CategoryLook {
  const color = categoryColors[theme.scheme][colorKey(key)];
  return { color, tint: withAlpha(color, categoryTintAlpha[theme.scheme]), icon: (key && SYSTEM[key]?.icon) || Tag };
}
