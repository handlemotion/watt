<script lang="ts">
  import Icon from "$lib/components/ui/Icon.svelte";

  let {
    value = "",
    onchange,
    onsend,
  }: {
    value?: string;
    onchange?: (value: string) => void;
    onsend?: () => void;
  } = $props();

  const canSend = $derived(value.trim().length > 0);

  let textarea: HTMLTextAreaElement | undefined = $state();

  function focusInput() {
    textarea?.focus();
  }

  function handleIslandPointerDown(event: PointerEvent) {
    if ((event.target as HTMLElement).closest("[data-composer-actions]")) {
      return;
    }

    focusInput();
  }

  $effect(() => {
    function handleWindowKeydown(event: KeyboardEvent) {
      if (event.key !== "l" || !event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
        return;
      }

      event.preventDefault();
      focusInput();
    }

    window.addEventListener("keydown", handleWindowKeydown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeydown);
    };
  });

  function handleInput(event: Event) {
    const target = event.currentTarget as HTMLTextAreaElement;
    onchange?.(target.value);
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
      return;
    }

    event.preventDefault();
    if (canSend) {
      onsend?.();
    }
  }
</script>

<div
  class="flex w-full max-w-[680px] flex-col gap-8 rounded-[20px] border border-composer-border bg-surface pt-2 pr-2 pb-1.5 pl-2.5"
  onpointerdown={handleIslandPointerDown}
>
  <textarea
    bind:this={textarea}
    class="min-h-[44px] w-full resize-none bg-transparent px-1 py-2 text-composer text-fg outline-none placeholder:text-placeholder"
    placeholder="What should we work on?"
    rows={1}
    {value}
    oninput={handleInput}
    onkeydown={handleKeydown}
  ></textarea>
  <div class="flex h-8 items-center justify-between" data-composer-actions>
    <div class="flex items-center gap-2">
      <button
        type="button"
        aria-label="Add context"
        class="flex cursor-default items-center justify-center rounded-full bg-composer-action p-[5px] text-fg hover:bg-surface-hover"
      >
        <Icon name="plus" size={14} />
      </button>
      <button
        type="button"
        class="flex h-[25px] cursor-default items-center gap-1 rounded-full pl-1.5 pr-1 text-meta text-fg hover:bg-composer-action"
      >
        <span>Grok 4.6 High</span>
        <Icon name="chevronDown" size={14} />
      </button>
    </div>
    <button
      type="button"
      aria-label="Send message"
      class="flex cursor-default items-center justify-center rounded-full p-[5px] transition-colors {canSend
        ? 'bg-fg text-white'
        : 'bg-composer-action text-muted'}"
      disabled={!canSend}
      onclick={() => {
        if (canSend) {
          onsend?.();
        }
      }}
    >
      <Icon name="arrowUp" size={14} />
    </button>
  </div>
</div>
