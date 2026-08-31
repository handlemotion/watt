<script lang="ts">
  import SectionLabel from "$lib/components/ui/SectionLabel.svelte";
  import type { Project, Worktree } from "$lib/types";

  import WorktreeGroup from "./WorktreeGroup.svelte";

  let {
    worktrees,
    projects,
    selectedId,
    onselect,
  }: {
    worktrees: Worktree[];
    projects: readonly Project[];
    selectedId: string | null;
    onselect: (id: string) => void;
  } = $props();

  const projectById = $derived.by(() => {
    const map: Record<string, Project> = {};
    for (const project of projects) {
      map[project.id] = project;
    }
    return map;
  });

  const groups = $derived(
    worktrees.flatMap((worktree) => {
      const project = projectById[worktree.projectId];
      return project ? [{ worktree, project }] : [];
    }),
  );
</script>

<div class="flex min-h-0 w-full flex-1 flex-col">
  <SectionLabel>Worktrees</SectionLabel>
  <div class="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-none">
    {#each groups as group (group.worktree.id)}
      <WorktreeGroup
        worktree={group.worktree}
        project={group.project}
        {selectedId}
        {onselect}
      />
    {/each}
  </div>
</div>
