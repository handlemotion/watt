<script lang="ts">
  import Favicon from "$lib/components/ui/Favicon.svelte";
  import NavRow from "$lib/components/ui/NavRow.svelte";
  import type { Project } from "$lib/types";

  let { project }: { project: Project } = $props();
</script>

<div class="flex w-full shrink-0 items-center px-1.5 py-2.5">
  <NavRow>
    <Favicon {project} />
    <span class="truncate">{project.name}</span>
  </NavRow>
</div>
