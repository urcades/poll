<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import MetaTags from "$lib/MetaTags.svelte";
  import PollResults from "$lib/PollResults.svelte";
  import { isClosed, labelForPoll, pollMeta, statusLabel } from "$lib/shared";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const meta = $derived(pollMeta(data.poll, page.url.origin, `/poll/${data.poll.slug}/results`, "Results: "));
</script>

<svelte:head>
  <title>Results: {data.poll.title}</title>
</svelte:head>

<MetaTags {meta} noindex />

<AppPageHeader title={data.poll.title} backHref={resolve("/poll/[id]", { id: data.poll.slug })} backLabel="Back to poll" />

<p>{labelForPoll(data.poll)} · {statusLabel(data.poll)} · {data.voteCount} vote{data.voteCount === 1 ? "" : "s"}{data.poll.config.anonymous ? " · anonymous" : ""}</p>
{#if !isClosed(data.poll)}
  <p class="hint">Voting is still open, so these results can change.</p>
{/if}

<section>
  <h2>Results</h2>
  <PollResults tally={data.tally} poll={data.poll} />
</section>
