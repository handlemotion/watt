<script lang="ts">
  import ChatMark from "$lib/components/ui/ChatMark.svelte";
  import NavRow from "$lib/components/ui/NavRow.svelte";
  import type { Chat } from "$lib/types";

  let {
    chat,
    selected = false,
    onclick,
  }: {
    chat: Chat;
    selected?: boolean;
    onclick?: () => void;
  } = $props();
</script>

<NavRow {selected} {onclick}>
  <ChatMark unread={chat.unread} />
  <span class="min-w-0 truncate">{chat.name}</span>
</NavRow>
