<script lang="ts">
  import { resolve } from "$app/paths";
  import { Button } from "@flowercomputer/flowerparts";
  import { page } from "$app/state";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import LocalTime from "$lib/LocalTime.svelte";
  import MetaTags from "$lib/MetaTags.svelte";
  import { formatDate, labelForPoll, shorten, statusLabel } from "$lib/shared";
  import type { PageProps } from "./$types";
  import type { Poll } from "../types";

  type Item = { poll: Poll; role: "admin" | "voter" | "invitee" | null };
  let { data }: PageProps = $props();
  const meta = $derived({
    title: "Poll",
    description: "Private votes and proposals, shared by link.",
    url: `${page.url.origin}/`,
    image: `${page.url.origin}/og.png`
  });
  const isEmpty = $derived(data.drafts.length + data.active.length + data.closed.length === 0);
</script>

<svelte:head>
  <title>My votes</title>
</svelte:head>

<MetaTags {meta} />

<AppPageHeader title="My votes">
  {#snippet right()}
    <Button href={resolve("/new")} variant="primary">New vote/proposal</Button>
  {/snippet}
</AppPageHeader>

{#if isEmpty}
  <section>
    <p>Polls you create or vote in show up here.</p>
    <p class="hint">Polls are not listed publicly. To vote in someone else's poll, open the link they shared with you.</p>
  </section>
{:else}
<section>
  <h2>Drafts</h2>
  {@render PollList({ items: data.drafts })}
</section>

<section>
  <h2>Active votes</h2>
  {@render PollList({ items: data.active })}
</section>

<section>
  <h2>Closed votes</h2>
  {@render PollList({ items: data.closed })}
</section>
{/if}

{#snippet PollList({ items }: { items: Item[] })}
  {#if items.length === 0}
    <p>None yet.</p>
  {:else}
    <div class="grid">
      {#each items as { poll, role } (poll.id)}
        <article class="card">
          <h3><a href={resolve("/poll/[id]", { id: poll.slug })}>{poll.title}</a></h3>
          <p>{labelForPoll(poll)} · {#if poll.status === "scheduled" && poll.opensAt}Scheduled for <LocalTime value={poll.opensAt} />{:else}{statusLabel(poll)}{/if}{role === "admin" ? " · created by you" : role === "voter" ? " · you voted" : role === "invitee" ? " · you are invited" : ""}</p>
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
