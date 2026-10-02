<script lang="ts">
  import "../app.css";

  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { afterNavigate } from "$app/navigation";
  import { page } from "$app/state";
  import { setTrackingAllowed, startTracking, trackPage } from "$lib/track";

  let { children }: { children: Snippet } = $props();

  // Fade the page out behind the sticky header once content scrolls under it.
  let scrolled = $state(false);

  // Usage tracking (lib/track.ts) stays off on anonymous polls.
  const anonymousPage = $derived(Boolean((page.data as { poll?: { config?: { anonymous?: boolean } } }).poll?.config?.anonymous));
  onMount(startTracking);
  afterNavigate(() => {
    setTrackingAllowed(!anonymousPage);
    trackPage();
  });
</script>

<svelte:window onscroll={() => (scrolled = window.scrollY > 0)} />

<div class="header-scrim" class:visible={scrolled} aria-hidden="true"></div>
{@render children()}
<p class="hint usage-notice">
  {#if anonymousPage}
    This poll is anonymous: your visit and ballot are not tied to you in this server's usage log.
  {:else}
    This server logs usage (pages, clicks, what is submitted) to improve the app; never typed text, and nothing on anonymous polls. Your browser's Do Not Track setting turns off page and click logging.
  {/if}
</p>
