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
  <summary>{label}<span aria-hidden="true">▾</span></summary>
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div class="overflow-menu-panel" onclick={chosen}>
    {@render children()}
  </div>
</details>

<style>
  .overflow-menu {
    position: relative;
  }

  /* Looks like the library's secondary button. */
  summary {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: var(--button-padding, var(--control-padding, 7px 11px));
    border-radius: var(--button-radius, var(--control-radius, var(--radius-control, 9px)));
    color: var(--button-secondary-color, var(--color-accent));
    background: var(--button-secondary-background, var(--color-control-subtle));
    font-weight: 400;
    white-space: nowrap;
    list-style: none;
    cursor: pointer;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary:focus-visible {
    outline: 2px solid var(--control-focus-color, var(--color-accent));
    outline-offset: var(--control-focus-offset, 3px);
  }

  summary span {
    font-size: 11px;
  }

  .overflow-menu[open] > summary {
    margin: 0;
  }

  .overflow-menu-panel {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: var(--flowerparts-overlay-z-index, 50);
    display: grid;
    gap: 2px;
    min-width: 11rem;
    padding: 6px;
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-control, 9px);
    box-shadow: 0 8px 24px rgb(0 0 0 / 0.12);
  }

  /* Items fill the menu width and read left to right. */
  .overflow-menu-panel :global(form) {
    display: contents;
  }

  .overflow-menu-panel :global(.button) {
    width: 100%;
    justify-content: flex-start;
    --button-secondary-background: transparent;
  }
</style>
