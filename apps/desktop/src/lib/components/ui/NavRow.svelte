<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    selected = false,
    expanded,
    trailing,
    onclick,
    children,
  }: {
    selected?: boolean;
    expanded?: boolean;
    trailing?: string;
    onclick?: () => void;
    children: Snippet;
  } = $props();
</script>

<button
  type="button"
  class={[
    "flex h-[30px] w-full min-w-0 cursor-default items-center gap-2 rounded-lg px-1.5 text-left text-nav text-fg",
    selected ? "bg-surface-hover" : "hover:bg-surface-hover",
  ]}
  aria-expanded={expanded}
  {onclick}
>
  <span class="flex min-w-0 flex-1 items-center gap-2">
    {@render children()}
  </span>
  {#if trailing}
    <span class="shrink-0 text-meta text-muted">{trailing}</span>
  {/if}
</button>
