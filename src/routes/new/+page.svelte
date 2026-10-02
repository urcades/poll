<script lang="ts">
  import { untrack } from "svelte";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import PollEditor from "$lib/PollEditor.svelte";
  import { editorValuesFor } from "$lib/suggestion";
  import type { PageProps } from "./$types";

  let { data, form }: PageProps = $props();
  let pending = $state(false);

  // Opened from a description on the home page: lay the suggestion over the
  // defaults. The editor only takes starting values, so read them once.
  const suggestion = page.state.suggestion;
  const selected = untrack(() => suggestion?.type ?? data.selected);
  const values = untrack(() => (suggestion ? editorValuesFor(suggestion) : data.values));
</script>

<svelte:head>
  <title>New vote/proposal</title>
</svelte:head>

<AppPageHeader title="New vote/proposal" backHref={resolve("/")} backLabel="Back to home" primary={{ label: "Save draft", form: "poll-editor", pending, pendingLabel: "Saving…" }} />

{#if form?.error}
  <p role="alert">{form.error}</p>
{/if}

{#if suggestion}
  <section class="callout" aria-label="Filled in from your description">
    <h2>Filled in from your description</h2>
    <ul>
      {#each suggestion.notes as note (note)}
        <li>{note}</li>
      {/each}
    </ul>
    {#if suggestion.alternatives.length}
      <p class="hint">Also a possible fit: {suggestion.alternatives.map((alternative) => `${alternative.label} (${alternative.percent}%)`).join(", ")}. Change the voting method below if one suits better.</p>
    {/if}
    <p class="hint">Check each field before saving.</p>
  </section>
{/if}

<PollEditor selected={selected} {values} id="poll-editor" bind:pending freshDefaults suggestionId={suggestion?.id} />
