<script lang="ts">
  import Sidebar from "$lib/components/sidebar/Sidebar.svelte";
  import Workspace from "$lib/components/workspace/Workspace.svelte";
  import {
    createChatId,
    currentProjectId,
    findChat,
    projectById,
    projects,
    worktrees as initialWorktrees,
  } from "$lib/data/mock";
  import type { Chat, Worktree } from "$lib/types";

  const currentProject = projectById(projects, currentProjectId);
  if (!currentProject) {
    throw new Error(`unknown project: ${currentProjectId}`);
  }

  const firstChat = initialWorktrees[0]?.chats[0];
  if (!firstChat) {
    throw new Error("expected mock chats");
  }

  let worktrees = $state<Worktree[]>(structuredClone(initialWorktrees));
  let selectedChatId = $state<string | null>(firstChat.id);

  const selection = $derived.by(() => {
    if (!selectedChatId) {
      return undefined;
    }
    return findChat(worktrees, selectedChatId);
  });

  function updateDraft(chatId: string, draft: string) {
    worktrees = worktrees.map((worktree) => ({
      ...worktree,
      chats: worktree.chats.map((chat) =>
        chat.id === chatId ? { ...chat, draft } : chat,
      ),
    }));
  }

  function createChat(worktreeId: string) {
    const chat: Chat = {
      id: createChatId(),
      name: "New Chat",
      draft: "",
      isNew: true,
    };

    worktrees = worktrees.map((worktree) =>
      worktree.id === worktreeId
        ? { ...worktree, chats: [chat, ...worktree.chats] }
        : worktree,
    );
    selectedChatId = chat.id;
  }

  function sendChat(chatId: string) {
    const match = findChat(worktrees, chatId);
    if (!match) {
      return;
    }

    const message = match.chat.draft?.trim() ?? "";
    if (!message) {
      return;
    }

    worktrees = worktrees.map((worktree) => ({
      ...worktree,
      chats: worktree.chats.map((chat) => {
        if (chat.id !== chatId) {
          return chat;
        }

        return {
          ...chat,
          name: chat.isNew ? message.slice(0, 48) : chat.name,
          draft: undefined,
          isNew: false,
        };
      }),
    }));
  }
</script>

<div class="flex h-full bg-app font-sans antialiased">
  <Sidebar
    {projects}
    {worktrees}
    {currentProject}
    selectedChatId={selectedChatId}
    onselectChat={(id) => {
      selectedChatId = id;
    }}
    oncreateChat={createChat}
  />
  <main class="min-w-0 flex-1">
    {#if selection}
      <Workspace
        chat={selection.chat}
        worktree={selection.worktree}
        ondraftchange={(draft) => {
          updateDraft(selection.chat.id, draft);
        }}
        onsend={() => {
          sendChat(selection.chat.id);
        }}
      />
    {/if}
  </main>
</div>
