<script lang="ts">
  import type { PollMeta } from "./shared";

  // Open Graph and Twitter card tags for link previews. `meta` holds public
  // fields only (see pollMeta); poll pages are private-by-link, so they ask
  // search engines not to index them.
  let { meta, noindex = false }: { meta: PollMeta; noindex?: boolean } = $props();
</script>

<svelte:head>
  {#if noindex}<meta name="robots" content="noindex" />{/if}
  <meta name="description" content={meta.description} />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Poll" />
  <meta property="og:title" content={meta.title} />
  <meta property="og:description" content={meta.description} />
  <meta property="og:url" content={meta.url} />
  <meta property="og:image" content={meta.image} />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content={meta.title} />
  <meta name="twitter:description" content={meta.description} />
  <meta name="twitter:image" content={meta.image} />
</svelte:head>
