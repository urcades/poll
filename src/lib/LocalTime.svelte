<script lang="ts">
  import { formatSlot, parseSlot } from "./shared";

  // A timeslot (with `minutes`, a range) or a single moment (no `minutes`),
  // shown in the viewer's time zone. The server has no idea of that zone, so it
  // renders UTC and the browser swaps in local text right after hydrating,
  // which keeps the two renders identical. Non-date labels print as they are.
  let { value, minutes = 0 }: { value: string; minutes?: number } = $props();

  let local = $state(false);
  $effect(() => {
    local = true;
  });

  const date = $derived(parseSlot(value));
  const text = $derived(formatSlot(value, minutes, local ? undefined : "UTC"));
</script>

{#if date}<time datetime={date.toISOString()}>{text}</time>{:else}{value}{/if}
