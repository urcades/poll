<script lang="ts">
  import { resolve } from "$app/paths";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import PollEditor from "$lib/PollEditor.svelte";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
</script>

<svelte:head>
  <title>Edit {data.poll.title}</title>
</svelte:head>

<AppPageHeader title="Edit draft" backHref={resolve("/poll/[id]", { id: data.poll.slug })} backLabel="Back to preview" />

{#if form?.error}
  <p role="alert">{form.error}</p>
{/if}

<PollEditor selected={data.selected} values={data.values} submitLabel="Save draft changes" />
