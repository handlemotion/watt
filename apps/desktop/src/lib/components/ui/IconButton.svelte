<script lang="ts">
  import type { IconName } from "$lib/icons";

  import Icon from "./Icon.svelte";

  let {
    name,
    label,
    onclick,
  }: {
    name: IconName;
    label: string;
    onclick?: () => void;
  } = $props();
</script>

<button
  type="button"
  aria-label={label}
  class="flex size-6 shrink-0 cursor-default items-center justify-center rounded-md hover:bg-surface-hover"
  {onclick}
>
  <Icon {name} size={14} />
</button>
