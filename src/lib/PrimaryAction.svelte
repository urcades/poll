<script lang="ts" module>
  export type Primary = {
    label: string;
    /** Navigate to another page. */
    href?: string;
    /** Or submit the form with this id. */
    form?: string;
    pending?: boolean;
    pendingLabel?: string;
  };
</script>

<script lang="ts">
  import { Button } from "@flowercomputer/flowerparts";

  let { label, href, form, pending = false, pendingLabel }: Primary = $props();
</script>

{#if href}
  <Button {href} variant="primary">{label}</Button>
{:else}
  <!-- Native button: the library Button has no `form` attribute, and a header
       button must still submit its form without JavaScript (and act as the
       form's default button for Enter). Styled to match the library primary. -->
  <button class="primary-action" type="submit" {form} disabled={pending}>{pending && pendingLabel ? pendingLabel : label}</button>
{/if}

<style>
  .primary-action {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    border: 0;
    border-radius: var(--button-radius, var(--control-radius, var(--radius-control, 9px)));
    padding: var(--button-padding, var(--control-padding, 7px 11px));
    color: var(--button-primary-color, var(--color-surface, #ffffff));
    background: var(--button-primary-background, var(--color-accent, #418272));
    font: inherit;
    letter-spacing: inherit;
    white-space: nowrap;
    cursor: pointer;
    appearance: none;

    @supports (corner-shape: superellipse(1.1)) {
      --button-radius: var(--control-radius-enhanced, var(--radius-control-enhanced, 11px));
      corner-shape: superellipse(1.1);
    }
  }

  .primary-action:not(:disabled):hover,
  .primary-action:not(:disabled):focus-visible {
    color: var(--button-primary-active-color, var(--button-primary-color, var(--color-surface, #ffffff)));
    background: var(--button-primary-active-background, var(--button-primary-background, var(--color-accent, #418272)));
  }

  .primary-action:focus-visible {
    outline: 2px solid var(--control-focus-color, var(--color-accent, #418272));
    outline-offset: var(--control-focus-offset, 3px);
  }

  .primary-action:disabled {
    color: var(--color-disabled-foreground, rgb(27 27 27 / 0.36));
    background: var(--color-disabled-background, rgb(27 27 27 / 0.06));
    cursor: not-allowed;
  }
</style>
