<script lang="ts">
  import type { Project, Worktree } from "$lib/types";

  import ChatRow from "./ChatRow.svelte";
  import WorktreeRow from "./WorktreeRow.svelte";

  let {
    worktree,
    project,
    selectedWorkspaceId,
    selectedChatId,
    onselectWorkspace,
    onselectChat,
    oncreateChat,
  }: {
    worktree: Worktree;
    project: Project;
    selectedWorkspaceId: string | null;
    selectedChatId: string | null;
    onselectWorkspace: (id: string) => void;
    onselectChat: (workspaceId: string, chatId: string) => void;
    oncreateChat: (workspaceId: string) => void;
  } = $props();

  let open = $state(true);

  $effect(() => {
    if (worktree.id === selectedWorkspaceId) open = true;
  });
</script>

<div class="flex flex-col gap-1 pb-2">
  <WorktreeRow
    {worktree}
    {project}
    expanded={open}
    onclick={() => {
      onselectWorkspace(worktree.id);
      open = !open;
    }}
    onnewchat={() => oncreateChat(worktree.id)}
  />
  {#if open}
    {#each worktree.chats as chat (chat.id)}
      <ChatRow
        {chat}
        selected={chat.id === selectedChatId && worktree.id === selectedWorkspaceId}
        onclick={() => onselectChat(worktree.id, chat.id)}
      />
    {/each}
  {/if}
</div>
