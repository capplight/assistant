import { Briefcase, Ellipsis, FileText, Layers, ShoppingCart, SquareCheck, Sun, Wallet } from 'lucide-react-native';

import type { IconKey } from '@/pages/templates';

/** Lucide, 2 pt stroke (2-design §2.5). No emoji, no sparkles/robots. */
const ICONS = {
  today: Sun,
  documents: FileText,
  tasks: SquareCheck,
  shopping: ShoppingCart,
  work: Briefcase,
  money: Wallet,
  other: Layers,
  more: Ellipsis,
} as const;

export function PageIcon({ name, size = 28, color }: { name: IconKey | 'more'; size?: number; color: string }) {
  const Cmp = ICONS[name];
  return <Cmp size={size} color={color} strokeWidth={2} />;
}
