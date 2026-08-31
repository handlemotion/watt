<script lang="ts">
  import type { Project, Worktree } from "$lib/types";

  import ChatRow from "./ChatRow.svelte";
  import WorktreeRow from "./WorktreeRow.svelte";

  let {
    worktree,
    project,
    selectedId,
    onselect,
  }: {
    worktree: Worktree;
    project: Project;
    selectedId: string | null;
    onselect: (id: string) => void;
  } = $props();

  let open = $state(true);
</script>

<div class="flex flex-col gap-1 pb-2">
  <WorktreeRow
    {worktree}
    {project}
    expanded={open}
    onclick={() => {
      open = !open;
    }}
  />
  {#if open}
    {#each worktree.chats as chat (chat.id)}
      <ChatRow
        {chat}
        selected={chat.id === selectedId}
        onclick={() => onselect(chat.id)}
      />
    {/each}
  {/if}
</div>
