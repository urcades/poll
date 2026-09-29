<script lang="ts">
  import { Button, CaretLeft, PageHeader } from "@flowercomputer/flowerparts";
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

<PageHeader ariaLabel={`${title} page header`} sticky>
  {#snippet left()}
    {#if backHref}
      <Button href={backHref} variant="tertiary" icon={CaretLeft} iconOnly aria-label={backLabel} />
    {/if}
    <h1 class="page-header-title">{title}</h1>
  {/snippet}

  {#snippet right()}
    {#if actions}
      <div class="header-actions">{@render actions()}</div>
      <div class="header-actions-menu"><OverflowMenu>{@render actions()}</OverflowMenu></div>
    {/if}
    {#if primary}
      <PrimaryAction {...primary} />
    {/if}
  {/snippet}
</PageHeader>

<style>
  /* Same type treatment as section headings (h2). */
  .page-header-title {
    grid-area: title;
    min-inline-size: 0;
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
    color: var(--color-ink);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
  }

  /* Three columns with equal sides, so the title sits at the exact center
     whatever the back button and primary action measure. The title column
     leaves room for side controls up to --header-side wide, then truncates. */
  :global(body .page-header.page-header) {
    --header-side: 10rem;
    grid-template-columns: 1fr fit-content(calc(100% - 2 * var(--header-side))) 1fr;
    grid-template-areas: "start title end";
    column-gap: var(--space-3, 12px);
    padding-inline: var(--gutter, 16px);
  }

  :global(body .page-header .page-header-cluster-left) {
    display: contents;
  }

  :global(body .page-header .page-header-cluster-left > .button) {
    grid-area: start;
    justify-self: start;
  }

  :global(body .page-header .page-header-spacer) {
    display: none;
  }

  :global(body .page-header .page-header-cluster-right) {
    grid-area: end;
    justify-self: end;
  }

  .header-actions {
    display: none;
    gap: var(--space-2, 8px);
    align-items: center;
  }

  .header-actions :global(form) {
    display: contents;
  }

  /* Wide screens have room for secondary actions beside a centered title;
     reserve enough on each side for them before the title truncates. */
  @media (min-width: 70rem) {
    :global(body .page-header.page-header:has(.header-actions)) {
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
    :global(body .page-header.page-header) {
      grid-template-columns: 1fr auto;
      grid-template-areas: "start end" "title title";
      row-gap: var(--space-1, 4px);
    }

    .page-header-title {
      white-space: normal;
    }
  }
</style>
