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
    min-inline-size: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-accent);
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
</style>
