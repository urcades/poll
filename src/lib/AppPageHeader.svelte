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

<!-- Actions render inline: pages keep at most one or two header actions, so a
     collapsed "Actions" popover would only hide them. -->
<PageHeader ariaLabel={`${title} page header`} sticky>
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

  /* Line the header up with the page content: same side gutter, and a bare
     title (no back button) starts flush with the text below it. */
  :global(body .page-header.page-header) {
    padding-inline: var(--gutter, 16px);
  }

  .page-header-title:first-child {
    padding-inline-start: 0;
  }
</style>
