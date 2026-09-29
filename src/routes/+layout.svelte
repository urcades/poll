<script lang="ts">
  import "../app.css";

  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();

  // Fade the page out behind the sticky header once content scrolls under it.
  let scrolled = $state(false);
</script>

<svelte:window onscroll={() => (scrolled = window.scrollY > 0)} />

<div class="header-scrim" class:visible={scrolled} aria-hidden="true"></div>
{@render children()}
