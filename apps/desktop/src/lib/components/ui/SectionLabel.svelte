<script lang="ts">
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<div class="mb-1 flex h-8 items-center px-2 text-meta text-muted">
  {@render children()}
</div>
