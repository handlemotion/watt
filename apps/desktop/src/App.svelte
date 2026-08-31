<script lang="ts">
  import Sidebar from "$lib/components/sidebar/Sidebar.svelte";
  import { currentProjectId, projectById, projects, worktrees } from "$lib/data/mock";

  const currentProject = projectById(projects, currentProjectId);
  if (!currentProject) {
    throw new Error(`unknown project: ${currentProjectId}`);
  }

  const initialChat = worktrees[0]?.chats[0];
  if (!initialChat) {
    throw new Error("expected mock chats");
  }

  let selectedId = $state<string | null>(initialChat.id);
</script>

<div class="flex h-full bg-app font-sans antialiased">
  <Sidebar
    {projects}
    {worktrees}
    {currentProject}
    selectedWorktreeId={selectedId}
    onselectWorktree={(id) => {
      selectedId = id;
    }}
  />
  <main class="min-w-0 flex-1"></main>
</div>
