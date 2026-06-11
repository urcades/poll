<script lang="ts">
  import "@flowercomputer/flowerparts/styles.css";
  import "../app.css";

  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

{@render children()}
