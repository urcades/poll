<script lang="ts">
  import { enhance } from "$app/forms";
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import type { SubmitFunction } from "@sveltejs/kit";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import LocalTime from "$lib/LocalTime.svelte";
  import MetaTags from "$lib/MetaTags.svelte";
  import { formatDate, labelForPoll, shorten, statusLabel } from "$lib/shared";
  import type { PageProps } from "./$types";
  import type { Poll } from "../types";

  type Item = { poll: Poll; role: "admin" | "voter" | "invitee" | null };
  let { data, form }: PageProps = $props();
  let describing = $state(false);

  // The description goes to the server, which returns a pre-filled poll; the
  // editor opens with it (in navigation state, so the text never lands in a URL).
  const describe: SubmitFunction = () => {
    describing = true;
    return async ({ result, update }) => {
      describing = false;
      if (result.type === "success" && result.data?.suggestion) {
        await goto(resolve("/new"), { state: { suggestion: result.data.suggestion } });
      } else {
        await update({ reset: false });
      }
    };
  };
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

<AppPageHeader title="My votes" primary={{ label: "New vote/proposal", href: resolve("/new") }} />

<!-- Describe a vote in plain words; this is where the prompt is interpreted and
     routed to a pre-filled poll. The field is in place; the interpretation isn't wired yet. -->
<form class="prompt-field" method="post" action="?/suggest" use:enhance={describe}>
  <label class="sr-only" for="poll-prompt">Describe a vote or proposal</label>
  <input
    id="poll-prompt"
    name="prompt"
    type="text"
    autocomplete="off"
    maxlength="2000"
    required
    disabled={!data.canDescribe || describing}
    placeholder={data.canDescribe ? (describing ? "Reading your description…" : "Describe a vote or proposal…") : "Describing a vote in words isn't set up on this server"}
  />
  {#if data.canDescribe}
    <p class="prompt-note hint">Press Enter. Your description is sent to TypeSafe to pick a voting method and fill in the form; nothing is created until you save.</p>
  {/if}
  {#if form?.error}
    <p role="alert">{form.error}</p>
  {/if}
</form>

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
    <p class="hint">None yet.</p>
  {:else}
    <ul class="poll-list">
      {#each items as { poll, role } (poll.id)}
        <li>
          <article class="card">
            <h3><a href={resolve("/poll/[id]", { id: poll.slug })}>{poll.title}</a></h3>
            <p class="meta">{labelForPoll(poll)} · {#if poll.status === "scheduled" && poll.opensAt}Scheduled for <LocalTime value={poll.opensAt} />{:else}{statusLabel(poll)}{/if}{role === "admin" ? " · created by you" : role === "voter" ? " · you voted" : role === "invitee" ? " · you are invited" : ""}</p>
            {#if poll.details}
              <p>{shorten(poll.details, 180)}</p>
            {/if}
            <p class="meta">
              Created {formatDate(poll.createdAt)}{poll.closesAt ? ` · Closes ${formatDate(poll.closesAt)}` : ""}
            </p>
          </article>
        </li>
      {/each}
    </ul>
  {/if}
{/snippet}
