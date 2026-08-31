import {
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconChevronDownMedium,
  IconChevronRightMedium,
  IconCodeTree,
  IconConsole,
  IconEditBig,
  IconMacbook,
  IconMagnifyingGlass,
  IconNote2,
  IconPlusMedium,
  IconPullRequest,
  IconSidebarHiddenLeftWide,
} from "central-icons";

export const icons = {
  arrowUp: IconArrowUp,
  back: IconArrowLeft,
  chevron: IconChevronRightMedium,
  chevronDown: IconChevronDownMedium,
  codeTree: IconCodeTree,
  console: IconConsole,
  create: IconEditBig,
  forward: IconArrowRight,
  macbook: IconMacbook,
  note: IconNote2,
  plus: IconPlusMedium,
  pullRequest: IconPullRequest,
  search: IconMagnifyingGlass,
  sidebar: IconSidebarHiddenLeftWide,
} as const;

export type IconName = keyof typeof icons;
