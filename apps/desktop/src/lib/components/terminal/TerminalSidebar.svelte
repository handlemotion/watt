<script lang="ts">
  import type { DesktopWorkspace } from "$lib/types";
  import { nextTerminalSidebarWidth } from "$lib/terminal-state";

  import TerminalView from "./TerminalView.svelte";

  let {
    workspaces,
    openedWorkspaceIds,
    selectedWorkspaceId,
    visible,
    focusNonce,
    onclose,
  }: {
    workspaces: DesktopWorkspace[];
    openedWorkspaceIds: string[];
    selectedWorkspaceId: string | null;
    visible: boolean;
    focusNonce: number;
    onclose: () => void;
  } = $props();

  let width = $state(420);
  let restartByWorkspace = $state<Record<string, number>>({});
  const workspaceById = $derived(new Map(workspaces.map((workspace) => [workspace.id, workspace])));
  const selectedWorkspace = $derived(
    selectedWorkspaceId ? workspaceById.get(selectedWorkspaceId) : undefined,
  );

  function beginResize(event: PointerEvent) {
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture(event.pointerId);
    const move = (moveEvent: PointerEvent) => {
      width = nextTerminalSidebarWidth(moveEvent.clientX, window.innerWidth);
    };
    const finish = () => {
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }
</script>

<aside
  class:hidden={!visible}
  class="relative flex h-full shrink-0 flex-col border-l border-line bg-app"
  style:width={`${width}px`}
  style:max-width="min(640px, calc(100vw - 644px))"
>
  <div
    class="absolute inset-y-0 left-[-3px] z-10 w-[6px] cursor-col-resize"
    aria-hidden="true"
    onpointerdown={beginResize}
  ></div>
  <header class="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2 text-meta">
    <span class="min-w-0 flex-1 truncate font-medium">{selectedWorkspace?.slug ?? "Terminal"}</span>
    {#if selectedWorkspace}
      <button
        type="button"
        class="rounded px-2 py-1 text-muted hover:bg-surface-hover hover:text-fg"
        onclick={() => {
          if (selectedWorkspaceId) {
            restartByWorkspace = {
              ...restartByWorkspace,
              [selectedWorkspaceId]: (restartByWorkspace[selectedWorkspaceId] ?? 0) + 1,
            };
          }
        }}
      >Restart</button>
    {/if}
    <button
      type="button"
      class="rounded px-2 py-1 text-muted hover:bg-surface-hover hover:text-fg"
      aria-label="Close terminal"
      onclick={onclose}
    >Close</button>
  </header>
  <div class="min-h-0 flex-1">
    {#if selectedWorkspaceId}
      {#each openedWorkspaceIds as workspaceId (workspaceId)}
        <div class:hidden={workspaceId !== selectedWorkspaceId} class="h-full">
          <TerminalView
            {workspaceId}
            active={workspaceId === selectedWorkspaceId}
            {focusNonce}
            restartNonce={restartByWorkspace[workspaceId] ?? 0}
          />
        </div>
      {/each}
    {:else}
      <div class="flex h-full items-center justify-center px-8 text-center text-meta text-muted">
        Select a worktree to open a terminal
      </div>
    {/if}
  </div>
</aside>
