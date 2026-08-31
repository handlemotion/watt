<script lang="ts">
  import Favicon from "$lib/components/ui/Favicon.svelte";
  import Icon from "$lib/components/ui/Icon.svelte";
  import type { Project, Worktree } from "$lib/types";

  let {
    worktree,
    project,
    expanded = true,
    onclick,
    onnewchat,
  }: {
    worktree: Worktree;
    project: Project;
    expanded?: boolean;
    onclick?: () => void;
    onnewchat?: () => void;
  } = $props();
</script>

<div
  class="group flex h-[30px] w-full min-w-0 items-center rounded-lg hover:bg-surface-hover"
>
  <button
    type="button"
    class="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 px-1.5 text-left text-nav text-fg"
    aria-expanded={expanded}
    {onclick}
  >
    <span class="relative size-4 shrink-0">
      <span class="flex size-4 group-hover:hidden">
        <Favicon {project} />
      </span>
      <span class="absolute inset-0 hidden items-center justify-center group-hover:flex">
        <Icon name="chevron" size={14} class={expanded ? "rotate-90" : ""} />
      </span>
    </span>
    <span class="min-w-0 truncate">{worktree.name}</span>
  </button>
  <button
    type="button"
    class="flex size-[30px] shrink-0 cursor-default items-center justify-center text-muted hover:text-fg"
    aria-label="New chat"
    onclick={() => {
      onnewchat?.();
    }}
  >
    <Icon name="plus" size={14} />
  </button>
</div>
