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
    <h1 class="page-header-title">{title}</h1>
  {/snippet}

  {#snippet right()}
    {@render actions?.()}
  {/snippet}
</PageHeader>

<style>
  /* Same type treatment as section headings (h2). */
  .page-header-title {
    min-inline-size: 0;
    margin: 0;
    padding-inline: var(--page-header-gap, 9px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-ink);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.3;
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
