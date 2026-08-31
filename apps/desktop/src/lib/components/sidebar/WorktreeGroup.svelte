<script lang="ts">
  import type { Project, Worktree } from "$lib/types";

  import ChatRow from "./ChatRow.svelte";
  import WorktreeRow from "./WorktreeRow.svelte";

  let {
    worktree,
    project,
    selectedChatId,
    onselectChat,
    oncreateChat,
  }: {
    worktree: Worktree;
    project: Project;
    selectedChatId: string | null;
    onselectChat: (id: string) => void;
    oncreateChat: (worktreeId: string) => void;
  } = $props();

  let open = $state(true);

  $effect(() => {
    if (worktree.chats.some((chat) => chat.id === selectedChatId)) {
      open = true;
    }
  });
</script>

<div class="flex flex-col gap-1 pb-2">
  <WorktreeRow
    {worktree}
    {project}
    expanded={open}
    onclick={() => {
      open = !open;
    }}
    onnewchat={() => {
      oncreateChat(worktree.id);
    }}
  />
  {#if open}
    {#each worktree.chats as chat (chat.id)}
      <ChatRow
        {chat}
        selected={chat.id === selectedChatId}
        onclick={() => onselectChat(chat.id)}
      />
    {/each}
  {/if}
</div>
