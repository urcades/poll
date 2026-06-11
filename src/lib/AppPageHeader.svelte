<script lang="ts">
  import { Button, CaretLeft, PageHeader } from "@flowercomputer/flowerparts";
  import type { Snippet } from "svelte";

  type Props = {
    title: string;
    backHref?: string;
    backLabel?: string;
    right?: Snippet;
  };

  let {
    title,
    backHref,
    backLabel = "Back",
    right: actions
  }: Props = $props();
</script>

<PageHeader ariaLabel={`${title} page header`} compactAt="medium" rightCompact={actions ? compactActions : undefined} sticky>
  {#snippet left()}
    {#if backHref}
      <Button href={backHref} variant="tertiary" icon={CaretLeft} iconOnly aria-label={backLabel} />
    {/if}
    <span class="page-header-title">{title}</span>
  {/snippet}

  {#snippet right()}
    {@render actions?.()}
  {/snippet}
</PageHeader>

{#snippet compactActions()}
  <div class="page-header-compact-actions">
    {@render actions?.()}
  </div>
{/snippet}

<style>
  .page-header-title {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--button-gap, var(--control-gap, 10px));
    min-inline-size: 0;
    margin: 0;
    border: 0;
    border-radius: var(
      --button-radius,
      var(--control-radius, var(--radius-control, 9px))
    );
    padding: var(--button-padding, var(--control-padding, 7px 11px));
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--button-tertiary-color, var(--color-accent));
    background: transparent;
    font: inherit;
    letter-spacing: inherit;

    @supports (corner-shape: superellipse(1.1)) {
      --button-radius: var(
        --control-radius-enhanced,
        var(--radius-control-enhanced, 11px)
      );
      corner-shape: superellipse(1.1);
    }
  }

  .page-header-compact-actions {
    display: grid;
    gap: 4px;
    padding: 4px;
  }

  .page-header-compact-actions :global(.button),
  .page-header-compact-actions :global(button) {
    inline-size: 100%;
    justify-content: flex-start;
  }

  :global(.page-header .page-header-right-compact .sidebar-row.row-item) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: auto;
    block-size: var(--control-block-size, 32px);
    color: var(--button-primary-color, var(--color-surface));
    background: var(--button-primary-background, var(--color-accent));
    text-align: center;
  }

  :global(.page-header .page-header-right-compact .sidebar-row.row-item:hover),
  :global(.page-header .page-header-right-compact .sidebar-row.row-item:focus-visible),
  :global(.page-header .page-header-right-compact .sidebar-row.row-item.is-active) {
    color: var(--button-primary-active-color, var(--button-primary-color, var(--color-surface)));
    background: var(--button-primary-active-background, var(--button-primary-background, var(--color-accent)));
  }

  :global(.page-header .page-header-right-compact .sidebar-row.row-item .row-item-icon) {
    display: none;
  }

  :global(.page-header .page-header-right-compact .sidebar-row.row-item .row-item-label) {
    opacity: 1;
    text-overflow: ellipsis;
  }
</style>
