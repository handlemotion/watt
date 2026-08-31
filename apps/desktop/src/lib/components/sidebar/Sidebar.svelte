<script lang="ts">
  import type { Project, Worktree } from "$lib/types";

  import ProjectNav from "./ProjectNav.svelte";
  import ProjectSwitcher from "./ProjectSwitcher.svelte";
  import SidebarChrome from "./SidebarChrome.svelte";
  import WorktreeList from "./WorktreeList.svelte";

  let {
    projects,
    worktrees,
    currentProject,
    selectedWorktreeId,
    onselectWorktree,
  }: {
    projects: readonly Project[];
    worktrees: Worktree[];
    currentProject: Project;
    selectedWorktreeId: string | null;
    onselectWorktree: (id: string) => void;
  } = $props();
</script>

<aside
  class="flex h-full w-sidebar shrink-0 flex-col overflow-hidden overscroll-none border-r border-line bg-app"
>
  <div class="flex min-h-0 flex-1 flex-col">
    <SidebarChrome />
    <div class="flex min-h-0 flex-1 flex-col gap-3 px-1.5 py-1">
      <ProjectNav />
      <WorktreeList
        {worktrees}
        {projects}
        selectedId={selectedWorktreeId}
        onselect={onselectWorktree}
      />
    </div>
  </div>
  <ProjectSwitcher project={currentProject} />
</aside>
