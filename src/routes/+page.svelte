<script lang="ts">
  import { resolve } from "$app/paths";
  import { Button } from "@flowercomputer/flowerparts";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import { formatDate, labelForPoll, shorten, statusLabel } from "$lib/shared";
  import type { Poll } from "../types";

  let { data }: { data: { drafts: Poll[]; active: Poll[]; closed: Poll[] } } = $props();
</script>

<svelte:head>
  <title>Votes</title>
</svelte:head>

<AppPageHeader title="Votes">
  {#snippet right()}
    <Button href={resolve("/new")} variant="primary">New vote/proposal</Button>
  {/snippet}
</AppPageHeader>

<section>
  <h2>Drafts</h2>
  {@render PollList({ polls: data.drafts })}
</section>

<section>
  <h2>Active votes</h2>
  {@render PollList({ polls: data.active })}
</section>

<section>
  <h2>Closed votes</h2>
  {@render PollList({ polls: data.closed })}
</section>

{#snippet PollList({ polls }: { polls: Poll[] })}
  {#if polls.length === 0}
    <p>No polls here yet.</p>
  {:else}
    <div class="grid">
      {#each polls as poll (poll.id)}
        <article class="card">
          <h3><a href={resolve("/poll/[id]", { id: String(poll.id) })}>{poll.title}</a></h3>
          <p>{labelForPoll(poll)} · {statusLabel(poll)}</p>
          {#if poll.details}
            <p>{shorten(poll.details, 180)}</p>
          {/if}
          <p>
            Created {formatDate(poll.createdAt)}{poll.closesAt ? ` · Closes ${formatDate(poll.closesAt)}` : ""}
          </p>
        </article>
      {/each}
    </div>
  {/if}
{/snippet}
