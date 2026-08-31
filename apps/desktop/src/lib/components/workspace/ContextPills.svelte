<script lang="ts">
  import Icon from "$lib/components/ui/Icon.svelte";
  import type { Worktree } from "$lib/types";

  let { worktree }: { worktree: Worktree } = $props();
</script>

<div class="flex flex-wrap items-start gap-1 px-2">
  <button
    type="button"
    class="flex h-7 cursor-default items-center gap-1 rounded-full px-2 text-meta text-muted hover:text-fg"
  >
    <span>Watt</span>
    <Icon name="chevronDown" size={14} />
  </button>
  <button
    type="button"
    class="flex h-7 cursor-default items-center gap-2 rounded-full px-2 text-meta text-muted hover:text-fg"
  >
    <Icon name="codeTree" size={14} />
    <span class="flex min-w-0 items-center gap-1">
      <span class="max-w-[220px] truncate">{worktree.name}</span>
      <Icon name="chevronDown" size={14} />
    </span>
  </button>
  <button
    type="button"
    class="flex h-7 cursor-default items-center gap-2 rounded-full px-2 text-meta text-muted hover:text-fg"
  >
    <Icon name="macbook" size={14} />
    <span class="flex items-center gap-1">
      <span>Local</span>
      <Icon name="chevronDown" size={14} />
    </span>
  </button>
</div>
