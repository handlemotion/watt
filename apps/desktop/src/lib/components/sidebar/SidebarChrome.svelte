<script lang="ts">
  import IconButton from "$lib/components/ui/IconButton.svelte";
</script>

<div class="flex h-9 w-full shrink-0 items-center">
  <div class="h-9 w-[80px] shrink-0" data-tauri-drag-region></div>
  <IconButton name="sidebar" label="Toggle sidebar" />
  <div class="h-9 min-w-0 flex-1" data-tauri-drag-region></div>
  <div class="flex h-full items-center gap-1.5 px-1.5">
    <IconButton name="back" label="Back" />
    <IconButton name="forward" label="Forward" />
  </div>
</div>
