<script lang="ts">
  import Icon from "$lib/components/ui/Icon.svelte";
  import NavRow from "$lib/components/ui/NavRow.svelte";
  import type { IconName } from "$lib/icons";

  const actions: { id: string; icon: IconName; label: string }[] = [
    { id: "search", icon: "search", label: "Search" },
    { id: "create", icon: "create", label: "Create" },
  ];
</script>

<nav class="flex w-full flex-col gap-1" aria-label="Project">
  {#each actions as action (action.id)}
    <NavRow>
      <Icon name={action.icon} size={16} />
      <span>{action.label}</span>
    </NavRow>
  {/each}
</nav>
