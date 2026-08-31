<script lang="ts">
  import type { Chat, Worktree } from "$lib/types";

  import ContextPills from "./ContextPills.svelte";
  import WorkspaceComposer from "./WorkspaceComposer.svelte";
  import WorkspaceHeader from "./WorkspaceHeader.svelte";

  let {
    chat,
    worktree,
    ondraftchange,
    onsend,
  }: {
    chat: Chat;
    worktree: Worktree;
    ondraftchange?: (draft: string) => void;
    onsend?: () => void;
  } = $props();
</script>

<section class="flex h-full min-w-0 flex-1 flex-col border-r border-line bg-app">
  <WorkspaceHeader title={chat.name} {worktree} />
  <div class="flex min-h-0 flex-1 items-center justify-center overflow-hidden px-4 pb-20">
    <div class="flex w-full max-w-[680px] flex-col gap-4">
      <WorkspaceComposer
        value={chat.draft ?? ""}
        onchange={ondraftchange}
        {onsend}
      />
      <ContextPills {worktree} />
    </div>
  </div>
</section>
