<script lang="ts">
  import type { Snippet } from "svelte";

  /**
   * A small dropdown for secondary actions. Built on <details> so it opens
   * without JavaScript; with JS it also closes on Escape, outside clicks, and
   * after an item is chosen.
   */
  let { label = "More", children }: { label?: string; children: Snippet } = $props();

  let menu: HTMLDetailsElement | undefined = $state();

  $effect(() => {
    const close = (event: Event) => {
      if (!menu?.open) return;
      if (event instanceof KeyboardEvent) {
        if (event.key !== "Escape") return;
        menu.open = false;
        menu.querySelector("summary")?.focus();
        return;
      }
      if (!menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  });

  function chosen(event: MouseEvent) {
    // Let the click submit its form or follow its link first.
    if ((event.target as Element).closest("a, button") && menu) setTimeout(() => menu && (menu.open = false));
  }
</script>

<details class="overflow-menu" bind:this={menu}>
  <summary class="button button-secondary">{label}<span aria-hidden="true">▾</span></summary>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="overflow-menu-panel" onclick={chosen}>
    {@render children()}
  </div>
</details>

<style>
  .overflow-menu {
    position: relative;
  }

  summary {
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary span {
    margin-inline-start: 0.35em;
    font-size: 0.7em;
  }

  .overflow-menu[open] > summary {
    margin: 0;
  }

  /* A small paper card, rounded like the site's cards. */
  .overflow-menu-panel {
    position: absolute;
    top: calc(100% + 0.5em);
    right: 0;
    z-index: 30;
    display: grid;
    gap: 0.15em;
    min-width: 11em;
    padding: 0.4em;
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 0.95em;
    box-shadow: 0 0.6em 1.8em rgb(0 0 0 / 0.12);
  }

  .overflow-menu-panel :global(form) {
    display: contents;
  }

  /* Items fill the menu and read left to right, tinted only on hover. */
  .overflow-menu-panel :global(.button) {
    width: 100%;
    justify-content: flex-start;
    background: transparent;
  }

  .overflow-menu-panel :global(.button:hover),
  .overflow-menu-panel :global(.button:focus-visible) {
    background: var(--tint);
  }
</style>
