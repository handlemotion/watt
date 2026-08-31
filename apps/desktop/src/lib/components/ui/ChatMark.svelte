<script lang="ts">
  let { unread = false }: { unread?: boolean } = $props();
</script>

<span class="flex size-4 shrink-0 items-center justify-center" aria-hidden="true">
  {#if unread}
    <span class="size-1.5 rounded-full bg-unread"></span>
  {/if}
</span>
