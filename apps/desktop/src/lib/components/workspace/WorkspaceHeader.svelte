<script lang="ts">
  import IconButton from "$lib/components/ui/IconButton.svelte";
  import Icon from "$lib/components/ui/Icon.svelte";
  import type { Worktree } from "$lib/types";

  let {
    title,
    worktree,
  }: {
    title: string;
    worktree: Worktree;
  } = $props();
</script>

<header class="flex h-9 shrink-0 items-center justify-between">
  <div class="flex h-full items-center px-1.5">
    <div class="flex h-[25px] items-center rounded-md px-1.5">
      <span class="truncate text-nav text-fg">{title}</span>
    </div>
  </div>
  <div class="flex h-full items-center gap-2.5 px-1.5 py-2">
    <div class="flex items-center gap-1.5">
      <IconButton name="note" label="Notes" />
      <IconButton name="console" label="Console" />
    </div>
    {#if worktree.pullRequest}
      <div
        class="flex h-6 items-center gap-1 overflow-hidden rounded-full bg-pr-bg py-1 pl-1.5 pr-[7px] text-pr-fg"
      >
        <Icon name="pullRequest" size={16} />
        <span class="text-meta">{worktree.pullRequest}</span>
      </div>
    {/if}
  </div>
</header>
