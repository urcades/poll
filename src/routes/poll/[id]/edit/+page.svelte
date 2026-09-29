<script lang="ts">
  import { resolve } from "$app/paths";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import PollEditor from "$lib/PollEditor.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  let pending = $state(false);
</script>

<svelte:head>
  <title>Edit {data.poll.title}</title>
</svelte:head>

<AppPageHeader title="Edit draft" backHref={resolve("/poll/[id]", { id: data.poll.slug })} backLabel="Back to preview" primary={{ label: "Save changes", form: "poll-editor", pending, pendingLabel: "Saving…" }} />

{#if form?.error}
  <p role="alert">{form.error}</p>
{/if}

<PollEditor selected={data.selected} values={data.values} id="poll-editor" bind:pending />
