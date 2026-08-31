import {
  IconArrowLeft,
  IconArrowRight,
  IconChevronRightMedium,
  IconEditBig,
  IconMagnifyingGlass,
  IconPlusMedium,
  IconSidebarHiddenLeftWide,
} from "central-icons";

export const icons = {
  back: IconArrowLeft,
  chevron: IconChevronRightMedium,
  create: IconEditBig,
  forward: IconArrowRight,
  plus: IconPlusMedium,
  search: IconMagnifyingGlass,
  sidebar: IconSidebarHiddenLeftWide,
} as const;

export type IconName = keyof typeof icons;
