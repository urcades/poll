<script lang="ts">
  import type { Snippet } from "svelte";
  import OverflowMenu from "./OverflowMenu.svelte";
  import PrimaryAction, { type Primary } from "./PrimaryAction.svelte";

  type Props = {
    title: string;
    backHref?: string;
    backLabel?: string;
    /** The page's one primary action, shown in the header's right corner. */
    primary?: Primary | null;
    /** Secondary actions: inline on wide screens, in a "More" menu otherwise. */
    actions?: Snippet;
  };

  let { title, backHref, backLabel = "Back", primary, actions }: Props = $props();
</script>

<header class="page-header" class:has-actions={Boolean(actions)}>
  <div class="page-header-start">
    {#if backHref}
      <a class="page-header-back" href={backHref} aria-label={backLabel}><span aria-hidden="true">←</span> Back</a>
    {/if}
  </div>
  <h1 class="page-header-title">{title}</h1>
  <div class="page-header-end">
    {#if actions}
      <div class="header-actions">{@render actions()}</div>
      <div class="header-actions-menu"><OverflowMenu>{@render actions()}</OverflowMenu></div>
    {/if}
    {#if primary}
      <PrimaryAction {...primary} />
    {/if}
  </div>
</header>

<style>
  /* Three columns with equal sides, so the title sits at the exact center
     whatever the back link and actions measure. The title column leaves room
     for side controls up to --header-side wide, then truncates. */
  .page-header {
    --header-side: 10rem;
    position: sticky;
    top: var(--inset);
    z-index: 20;
    display: grid;
    grid-template-columns: 1fr fit-content(calc(100% - 2 * var(--header-side))) 1fr;
    grid-template-areas: "start title end";
    column-gap: var(--space-3);
    align-items: center;
  }

  .page-header-start {
    grid-area: start;
    justify-self: start;
  }

  .page-header-title {
    grid-area: title;
    min-inline-size: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
  }

  .page-header-end {
    grid-area: end;
    justify-self: end;
    display: flex;
    gap: var(--gap-inline);
    align-items: center;
  }

  /* Bogathon nav links: no underline until hover. */
  .page-header-back {
    text-decoration: none;
    white-space: nowrap;
  }

  .page-header-back:hover {
    text-decoration: underline;
  }

  .header-actions {
    display: none;
    gap: var(--gap-inline);
    align-items: center;
  }

  .header-actions :global(form) {
    display: contents;
  }

  /* Wide screens have room for secondary actions beside a centered title;
     reserve enough on each side for them before the title truncates. */
  @media (min-width: 70rem) {
    .page-header.has-actions {
      --header-side: 30rem;
    }

    .header-actions {
      display: flex;
    }

    .header-actions-menu {
      display: none;
    }
  }

  /* Phones: controls on the first row, the full title centered below. */
  @media (max-width: 480px) {
    .page-header {
      grid-template-columns: 1fr auto;
      grid-template-areas: "start end" "title title";
      row-gap: var(--space-2);
    }

    .page-header-title {
      white-space: normal;
    }
  }
</style>
