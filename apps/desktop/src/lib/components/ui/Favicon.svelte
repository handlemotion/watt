<script lang="ts">
  import type { Project } from "$lib/types";

  let { project }: { project: Project } = $props();
</script>

<span
  class="flex size-4 shrink-0 items-center justify-center overflow-clip rounded text-meta leading-none text-white"
  style:background-color={project.color}
  aria-hidden="true"
>
  {project.initial}
</span>
