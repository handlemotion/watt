<script lang="ts">
  import { onMount } from "svelte";

  import Sidebar from "$lib/components/sidebar/Sidebar.svelte";
  import TerminalSidebar from "$lib/components/terminal/TerminalSidebar.svelte";
  import Workspace from "$lib/components/workspace/Workspace.svelte";
  import { createChatId, findChat } from "$lib/data/mock";
  import { desktopSnapshot } from "$lib/desktop";
  import { isTerminalToggle, retainOpenedTerminalIds } from "$lib/terminal-state";
  import type {
    Chat,
    DesktopSnapshot,
    DesktopWorkspace,
    Project,
    Worktree,
  } from "$lib/types";

  const projectColors = ["#068aef", "#9c5de5", "#e78324", "#2d9b65"];
  let snapshot = $state<DesktopSnapshot>({
    host: { status: "starting", message: "Starting local host…" },
    projects: [],
  });
  let loadError = $state<string | null>(null);
  let worktrees = $state<Worktree[]>([]);
  let selectedWorkspaceId = $state<string | null>(null);
  let selectedChatId = $state<string | null>(null);
  let terminalVisible = $state(false);
  let openedWorkspaceIds = $state<string[]>([]);
  let focusNonce = $state(0);
  let previousFocus: HTMLElement | null = null;

  const desktopWorkspaces = $derived(
    snapshot.projects.flatMap((project) => project.workspaces),
  );
  const projects = $derived<Project[]>(
    snapshot.projects.map((project, index) => ({
      id: project.id,
      name: project.name,
      initial: project.name.slice(0, 1).toUpperCase(),
      color: projectColors[index % projectColors.length] ?? projectColors[0]!,
    })),
  );
  const currentProject = $derived(
    projects.find((project) =>
      desktopWorkspaces.some(
        (workspace) =>
          workspace.id === selectedWorkspaceId && workspace.projectId === project.id,
      ),
    ) ?? projects[0],
  );
  const selection = $derived.by(() => {
    if (!selectedChatId) return undefined;
    return findChat(worktrees, selectedChatId);
  });

  function title(value: string): string {
    return value
      .replaceAll("_", " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function mapWorktrees(next: DesktopSnapshot): Worktree[] {
    return next.projects.flatMap((project) =>
      project.workspaces.map((workspace) => {
        const previous = worktrees.find((entry) => entry.id === workspace.id);
        const serverChats = workspace.sessions.map((session) => {
          const chat = previous?.chats.find((entry) => entry.id === session.id);
          return {
            id: session.id,
            name: `${title(session.runtime)} · ${title(session.mode)} · ${session.id.slice(0, 8)}`,
            draft: chat?.draft,
            isNew: chat?.isNew,
          };
        });
        const localChats = previous?.chats.filter((chat) => chat.id.startsWith("chat-")) ?? [];
        return {
          id: workspace.id,
          name: workspace.slug,
          projectId: project.id,
          chats: [...localChats, ...serverChats],
        };
      }),
    );
  }

  function ensureTerminal(workspaceId: string) {
    if (!openedWorkspaceIds.includes(workspaceId)) {
      openedWorkspaceIds = [...openedWorkspaceIds, workspaceId];
    }
  }

  function selectWorkspace(workspaceId: string) {
    selectedWorkspaceId = workspaceId;
    if (!worktrees.find((entry) => entry.id === workspaceId)?.chats.some((chat) => chat.id === selectedChatId)) {
      selectedChatId = worktrees.find((entry) => entry.id === workspaceId)?.chats[0]?.id ?? null;
    }
    if (terminalVisible) {
      ensureTerminal(workspaceId);
      focusNonce += 1;
    }
  }

  function selectChat(workspaceId: string, chatId: string) {
    selectedWorkspaceId = workspaceId;
    selectedChatId = chatId;
    if (terminalVisible) {
      ensureTerminal(workspaceId);
      focusNonce += 1;
    }
  }

  function updateDraft(chatId: string, draft: string) {
    worktrees = worktrees.map((worktree) => ({
      ...worktree,
      chats: worktree.chats.map((chat) =>
        chat.id === chatId ? { ...chat, draft } : chat,
      ),
    }));
  }

  function createChat(workspaceId: string) {
    const chat: Chat = {
      id: createChatId(),
      name: "New Chat",
      draft: "",
      isNew: true,
    };
    worktrees = worktrees.map((worktree) =>
      worktree.id === workspaceId
        ? { ...worktree, chats: [chat, ...worktree.chats] }
        : worktree,
    );
    selectChat(workspaceId, chat.id);
  }

  function sendChat(chatId: string) {
    const match = findChat(worktrees, chatId);
    const message = match?.chat.draft?.trim() ?? "";
    if (!message) return;
    worktrees = worktrees.map((worktree) => ({
      ...worktree,
      chats: worktree.chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              name: chat.isNew ? message.slice(0, 48) : chat.name,
              draft: undefined,
              isNew: false,
            }
          : chat,
      ),
    }));
  }

  function closeTerminal() {
    terminalVisible = false;
    queueMicrotask(() => previousFocus?.focus());
  }

  function toggleTerminal() {
    if (terminalVisible) {
      closeTerminal();
      return;
    }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    terminalVisible = true;
    if (selectedWorkspaceId) ensureTerminal(selectedWorkspaceId);
    focusNonce += 1;
  }

  async function refresh() {
    try {
      const next = await desktopSnapshot();
      const nextWorktrees = mapWorktrees(next);
      snapshot = next;
      worktrees = nextWorktrees;
      loadError = null;
      const active = next.projects
        .flatMap((project) => project.workspaces)
        .sort((left, right) => left.createdAt - right.createdAt);
      if (!selectedWorkspaceId || !active.some((workspace) => workspace.id === selectedWorkspaceId)) {
        selectedWorkspaceId = active[0]?.id ?? null;
        selectedChatId = nextWorktrees.find((entry) => entry.id === selectedWorkspaceId)?.chats[0]?.id ?? null;
      } else if (!nextWorktrees.find((entry) => entry.id === selectedWorkspaceId)?.chats.some((chat) => chat.id === selectedChatId)) {
        selectedChatId = nextWorktrees.find((entry) => entry.id === selectedWorkspaceId)?.chats[0]?.id ?? null;
      }
      openedWorkspaceIds = retainOpenedTerminalIds(
        openedWorkspaceIds,
        active.map((workspace) => workspace.id),
      );
      if (terminalVisible && selectedWorkspaceId) ensureTerminal(selectedWorkspaceId);
    } catch (error) {
      loadError = String(error);
    }
  }

  onMount(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 2_000);
    const keydown = (event: KeyboardEvent) => {
      if (!isTerminalToggle(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      toggleTerminal();
    };
    window.addEventListener("keydown", keydown, { capture: true });
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("keydown", keydown, { capture: true });
    };
  });
</script>

<div class="flex h-full bg-app font-sans antialiased">
  {#if currentProject}
    <Sidebar
      {projects}
      {worktrees}
      {currentProject}
      {selectedWorkspaceId}
      {selectedChatId}
      onselectWorkspace={selectWorkspace}
      onselectChat={selectChat}
      oncreateChat={createChat}
    />
  {:else}
    <aside class="flex h-full w-sidebar shrink-0 items-center justify-center border-r border-line px-6 text-center text-meta text-muted">
      {loadError ?? snapshot.host.message}
    </aside>
  {/if}
  <main class="min-w-[320px] flex-1">
    {#if selection}
      <Workspace
        chat={selection.chat}
        worktree={selection.worktree}
        ondraftchange={(draft) => updateDraft(selection.chat.id, draft)}
        onsend={() => sendChat(selection.chat.id)}
      />
    {/if}
  </main>
  <TerminalSidebar
    workspaces={desktopWorkspaces as DesktopWorkspace[]}
    openedWorkspaceIds={openedWorkspaceIds}
    {selectedWorkspaceId}
    visible={terminalVisible}
    {focusNonce}
    onclose={closeTerminal}
  />
</div>
