<script lang="ts">
  import type { Snippet } from "svelte";

  /** A link when `href` is set, otherwise a button. Styles live in app.css (.button). */
  type Props = {
    children: Snippet;
    href?: string;
    variant?: "primary" | "secondary" | "tertiary";
    type?: "button" | "submit";
    /** Submit a form elsewhere on the page by id. */
    form?: string;
    disabled?: boolean;
    id?: string;
    onclick?: (event: MouseEvent) => void;
    "aria-label"?: string;
  };

  let { children, href, variant = "secondary", type = "button", form, disabled = false, id, onclick, "aria-label": ariaLabel }: Props = $props();
</script>

{#if href}
  <a class="button button-{variant}" {href} {id} aria-label={ariaLabel}>{@render children()}</a>
{:else}
  <button class="button button-{variant}" {type} {form} {disabled} {id} {onclick} aria-label={ariaLabel}>{@render children()}</button>
{/if}
