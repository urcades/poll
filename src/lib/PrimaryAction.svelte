<script lang="ts" module>
  export type Primary = {
    label: string;
    /** Navigate to another page. */
    href?: string;
    /** Or submit the form with this id (works without JS, and on Enter). */
    form?: string;
    pending?: boolean;
    pendingLabel?: string;
  };
</script>

<script lang="ts">
  import Button from "./Button.svelte";

  let { label, href, form, pending = false, pendingLabel }: Primary = $props();
</script>

{#if href}
  <Button {href} variant="primary">{label}</Button>
{:else}
  <Button type="submit" variant="primary" {form} disabled={pending}>{pending && pendingLabel ? pendingLabel : label}</Button>
{/if}
