<script lang="ts">
  import { resolve } from "$app/paths";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import PollEditor from "$lib/PollEditor.svelte";
  import type { Poll, PollConfig, PollType } from "../../../../types";

  let {
    data,
    form
  }: {
    data: {
      poll: Poll;
      selected: PollType;
      values: {
        title: string;
        details: string;
        optionsText: string;
        opensAt: string;
        closesAt: string;
        config: PollConfig;
      };
    };
    form?: { error?: string };
  } = $props();
</script>

<svelte:head>
  <title>Edit {data.poll.title}</title>
</svelte:head>

<AppPageHeader title="Edit draft" backHref={resolve("/poll/[id]", { id: String(data.poll.id) })} backLabel="Back to preview" />

{#if form?.error}
  <p>{form.error}</p>
{/if}

<PollEditor selected={data.selected} values={data.values} submitLabel="Save draft changes" />
