<script lang="ts">
  import { icons, type IconName } from "$lib/icons";
  import type { Component } from "svelte";
  import type { ClassValue } from "svelte/elements";

  type CentralIcon = Component<{
    size?: string | number;
    mode?: "raw" | "masked";
    color?: string;
    ariaHidden?: boolean;
    ariaLabel?: string;
  }>;

  let {
    name,
    size,
    class: className,
  }: {
    name: IconName;
    size: 12 | 14 | 16;
    class?: ClassValue;
  } = $props();

  const Glyph = $derived(icons[name] as CentralIcon);
</script>

<span
  class={["inline-flex shrink-0", className]}
  style:width="{size}px"
  style:height="{size}px"
>
  <Glyph {size} mode="raw" />
</span>
