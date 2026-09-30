<script lang="ts">
  import { resolve } from "$app/paths";
  import { enhance } from "$app/forms";
  import { invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import Button from "$lib/Button.svelte";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import LocalTime from "$lib/LocalTime.svelte";
  import MetaTags from "$lib/MetaTags.svelte";
  import PollResults from "$lib/PollResults.svelte";
  import type { Primary } from "$lib/PrimaryAction.svelte";
  import RankBallot from "$lib/RankBallot.svelte";
  import { templateByType } from "../../../templates";
  import type { SubmitFunction } from "@sveltejs/kit";
  import { untrack } from "svelte";
  import type { PageProps } from "./$types";
  import { isProposalType, type Option, type Poll, type Vote } from "../../../types";
  import { pendingForm } from "$lib/enhance.svelte";
  import { limitChoices } from "$lib/limitChoices";
  import { isClosed, isOpen, parseSlot, pollMeta, statusLabel } from "$lib/shared";

  let { data, form }: PageProps = $props();

  const template = $derived(templateByType.get(data.poll.type));
  const meta = $derived(pollMeta(data.poll, page.url.origin));
  const minutes = $derived(data.poll.config.meetingDurationMinutes ?? 60);
  const calendarReady = $derived(data.poll.type === "time_poll" && data.options.length > 0 && data.options.every((option) => parseSlot(option.label)));

  const voteForm = pendingForm();
  const adminForm = pendingForm();

  // The one primary action for this viewer, shown in the header: open a draft,
  // cast a vote, close a poll you cannot vote in, or share final results.
  const canVote = $derived(isOpen(data.poll) && !data.inviteRequired);
  const primary = $derived.by((): Primary | null => {
    const poll = data.poll;
    if (poll.status === "draft" && data.isAdmin) return { label: "Open voting", form: "open-poll", pending: adminForm.pending };
    if (canVote && data.canChangeVote) return { label: data.viewerVote ? "Update vote" : "Submit vote", form: "vote-form", pending: voteForm.pending };
    if (data.isAdmin && poll.status === "open" && !isClosed(poll)) return { label: "Close poll", form: "close-poll", pending: adminForm.pending };
    if (isClosed(poll) && data.showResults) return { label: "Share results", href: resolve("/poll/[id]/results", { id: poll.slug }) };
    return null;
  });
  const hasCalendar = $derived(calendarReady && isClosed(data.poll) && data.showResults && Boolean(data.tally?.rows[0]) && (data.tally?.rows[0]?.available ?? 0) + (data.tally?.rows[0]?.ifNeeded ?? 0) > 0);

  // Keep vote counts and results fresh for everyone with the page open. A cheap
  // version probe runs every 5s; the full load only reruns when it changed, and
  // never while the viewer is typing in a form or a submission is in flight.
  let stale = false;
  let checking = false;

  function busy(): boolean {
    return voteForm.pending || adminForm.pending || Boolean(document.activeElement?.closest("form"));
  }

  async function refreshIfStale() {
    if (!stale || busy()) return;
    stale = false;
    await invalidateAll();
  }

  async function checkVersion(slug: string) {
    if (checking || document.visibilityState === "hidden") return;
    checking = true;
    try {
      const response = await fetch(resolve("/poll/[id]/version", { id: slug }), { cache: "no-store" });
      if (response.ok) {
        const { version } = await response.json();
        if (version !== untrack(() => data.version)) stale = true;
      }
    } catch {
      // Offline or server hiccup: try again on the next tick.
    } finally {
      checking = false;
    }
    await refreshIfStale();
  }

  $effect(() => {
    if (data.poll.status === "draft" || isClosed(data.poll)) return; // scheduled polls keep probing so they refresh when they open
    const slug = data.poll.slug;
    const timer = setInterval(() => checkVersion(slug), 5000);
    const onVisible = () => {
      if (document.visibilityState === "visible") checkVersion(slug);
    };
    const onFocusOut = () => setTimeout(refreshIfStale, 0);
    document.addEventListener("visibilitychange", onVisible);
    document.addEventListener("focusout", onFocusOut);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      document.removeEventListener("focusout", onFocusOut);
    };
  });

  $effect(() => {
    if (!voteForm.pending && !adminForm.pending) untrack(refreshIfStale);
  });

  let copiedName = $state<string | null>(null);
  const votedInvitees = $derived(data.invitations?.filter((invitation) => invitation.voted).length ?? 0);

  async function copyLink(name: string, link: string) {
    try {
      await navigator.clipboard.writeText(new URL(link, window.location.origin).href);
      copiedName = name;
      setTimeout(() => {
        if (copiedName === name) copiedName = null;
      }, 2000);
    } catch {
      copiedName = null;
    }
  }

  const confirmedDelete: SubmitFunction = (input) => {
    if (!confirm("Delete this poll and all of its votes? This cannot be undone.")) {
      input.cancel();
      return;
    }
    return adminForm.enhance(input);
  };
  function chooseRule(min: number, max: number): string {
    if (min === max) return max === 1 ? "Choose one" : `Choose exactly ${max}`;
    if (min <= 1) return max === 1 ? "Choose one" : `Choose up to ${max}${min === 1 ? "" : ", or none"}`;
    return `Choose ${min} to ${max}`;
  }

  function ballotObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
</script>

<svelte:head>
  <title>{data.poll.title}</title>
</svelte:head>

<MetaTags {meta} noindex />

<AppPageHeader backHref={resolve("/")} backLabel="Back to home" {primary} actions={data.isAdmin ? PollActions : undefined} />

{#if data.isAdmin}
  <!-- Targets of the header's primary button (form="…"); they hold no fields. -->
  <form id="open-poll" method="post" action="?/open" use:enhance={adminForm.enhance} hidden></form>
  <form id="close-poll" method="post" action="?/close" use:enhance={adminForm.enhance} hidden></form>
{/if}

{#if form?.error}
  <p role="alert">{form.error}</p>
{/if}

<!-- The poll's title lives here, in full, rather than in the header where long titles were cut off. -->
<section class="poll-intro">
  <h1>{data.poll.title}</h1>
  <p class="lede">{template?.label ?? data.poll.type} · {statusLabel(data.poll)} · {data.voteCount} vote{data.voteCount === 1 ? "" : "s"}</p>
  {#if data.poll.details}
    <div class="poll-details">
      {#each data.poll.details.split("\n") as line, index (index)}
        <p>{line}</p>
      {/each}
    </div>
  {/if}
</section>

{#if data.isAdmin && (data.adminLink || isClosed(data.poll))}
  <section class="callout">
    <h2>Manage poll</h2>
    {#if isClosed(data.poll)}
      <p>
        Export results:
        <a href={resolve("/poll/[id]/export.json", { id: data.poll.slug })} aria-label="Export JSON" data-sveltekit-reload>JSON</a> ·
        <a href={resolve("/poll/[id]/export.csv", { id: data.poll.slug })} aria-label="Export CSV" data-sveltekit-reload>CSV</a>
      </p>
    {/if}
    {#if data.adminLink}
      <div class="field">
        <p>Admin link: <a href={data.adminLink}>{data.adminLink}</a></p>
        <p class="hint">Opening this link grants poll admin (open, close, edit, export) on another device. Keep it private; the plain poll URL is the one to share with voters.</p>
      </div>
    {/if}
  </section>
{/if}

{#if data.poll.status === "draft" || data.poll.status === "scheduled"}
  {#if data.poll.status === "scheduled" && data.poll.opensAt}
    <section>
      <h2>Voting opens <LocalTime value={data.poll.opensAt} /></h2>
      {#if data.isAdmin}
        <p class="hint">This poll is scheduled and its setup is frozen. It opens by itself at that time; unschedule it to edit or open it sooner.</p>
      {:else}
        <p>The ballot appears here when voting opens. This page refreshes by itself.</p>
      {/if}
    </section>
  {/if}
  {#if data.poll.status === "draft" || data.isAdmin}
    <section>
      <h2>Draft preview</h2>
      <p class="hint">This is the voter-facing ballot preview. Voting is disabled until {data.poll.status === "scheduled" ? "the poll opens" : "you open voting"}.</p>
      <div inert aria-disabled="true">
        {@render VoteForm({ poll: data.poll, options: data.ballotOptions, viewerName: "", viewerVote: null, inviteBallot: false })}
      </div>
    </section>
  {/if}
  <section>
    <h2>Results</h2>
    <p>Results will appear after voting opens and votes are submitted.</p>
  </section>
{:else}
  <section>
    <h2>Vote</h2>
    {#if isOpen(data.poll)}
      {#if data.inviteRequired}
        <p>This poll is invite-only. Use the personal link you were sent.</p>
      {:else if data.canChangeVote}
        {@render VoteForm({ poll: data.poll, options: data.ballotOptions, viewerName: data.viewerName, viewerVote: data.viewerVote, inviteBallot: data.poll.config.voterMode === "invite", id: "vote-form" })}
      {:else}
        <!-- A cast vote is final here: show the ballot read-only. -->
        <p>Your vote is in{data.viewerName ? `, ${data.viewerName}` : ""}. Votes on this poll can't be changed once cast.</p>
        <div inert aria-disabled="true">
          {@render VoteForm({ poll: data.poll, options: data.ballotOptions, viewerName: data.viewerName, viewerVote: data.viewerVote, inviteBallot: data.poll.config.voterMode === "invite" })}
        </div>
      {/if}
    {:else}
      <p>Voting is not open.</p>
    {/if}
  </section>
  <section>
    <h2>Results</h2>
    <PollResults tally={data.showResults ? data.tally : null} poll={data.poll} />
  </section>
{/if}

{#if hasCalendar}
  <section>
    <h2>Calendar</h2>
    <p><a href={resolve("/poll/[id]/event.ics", { id: data.poll.slug })} download>Add the winning timeslot to your calendar (.ics)</a></p>
  </section>
{/if}

{#if data.invitations}
  <section id="invitations">
    <h2>Invitations</h2>
    <p><strong>{votedInvitees} of {data.invitations.length}</strong> invitees have voted.</p>
    <p class="hint">Each personal link lets one person vote as the name shown. Send each link only to that person. You can see who has voted (not what they voted), even in anonymous polls.{data.invitations.some((invitation) => invitation.link) ? "" : " Links are only shown to the poll's own admin, not to the instance operator."}</p>
    <ul class="plain-list">
      {#each data.invitations as invitation (invitation.name)}
        <li class="list-row">
          <strong>{invitation.name}</strong>
          <span class="meta">{invitation.voted ? "voted" : "not voted"}</span>
          {#if invitation.link}
            <a href={invitation.link}>personal link</a>
            <Button type="button" onclick={() => copyLink(invitation.name, invitation.link ?? "")}>{copiedName === invitation.name ? "Copied" : "Copy link"}</Button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if !isClosed(data.poll)}
      <form method="post" action="?/addInvitees" use:enhance={adminForm.enhance}>
        <label>
          Add invitees (one name per line)
          <textarea name="inviteesText" rows="3" required></textarea>
        </label>
        <Button type="submit" variant="secondary" disabled={adminForm.pending}>Add invitees</Button>
      </form>
    {/if}
  </section>
{/if}

{#snippet PollActions()}
  {@const poll = data.poll}
  {#if poll.status === "draft"}
    <Button href={resolve("/poll/[id]/edit", { id: poll.slug })} variant="secondary">Edit draft</Button>
    {#if poll.opensAt}
      <form method="post" action="?/schedule" use:enhance={adminForm.enhance}><Button type="submit" variant="secondary" disabled={adminForm.pending}>Schedule</Button></form>
    {/if}
  {:else if poll.status === "scheduled"}
    <form method="post" action="?/unschedule" use:enhance={adminForm.enhance}><Button type="submit" variant="secondary" disabled={adminForm.pending}>Unschedule</Button></form>
  {:else if !isClosed(poll) && primary?.form !== "close-poll"}
    <form method="post" action="?/close" use:enhance={adminForm.enhance}><Button type="submit" variant="secondary" disabled={adminForm.pending}>Close poll</Button></form>
  {/if}
  <form method="post" action="?/duplicate" use:enhance={adminForm.enhance}><Button type="submit" variant="secondary" disabled={adminForm.pending}>Duplicate</Button></form>
  <form method="post" action="?/delete" use:enhance={confirmedDelete}><Button type="submit" variant="secondary" disabled={adminForm.pending}>Delete</Button></form>
{/snippet}

{#snippet VoteForm({ poll, options, viewerName, viewerVote, inviteBallot, id }: { poll: Poll; options: Option[]; viewerName: string; viewerVote: Vote | null; inviteBallot: boolean; id?: string })}
  {@const currentBallot = ballotObject(viewerVote?.ballot)}
  {@const currentSelected = new Set(Array.isArray(currentBallot.selected) ? currentBallot.selected.map(Number) : [])}
  {@const currentScores = ballotObject(currentBallot.scores)}
  {@const currentAllocations = ballotObject(currentBallot.allocations)}
  {@const currentRankings = Array.isArray(currentBallot.rankings) ? currentBallot.rankings.map(Number) : []}
  {@const currentAvailability = ballotObject(currentBallot.availability)}
  <form {id} method="post" action="?/vote" use:enhance={voteForm.enhance}>
    {#if inviteBallot}
      <p>Voting as <strong>{viewerName || "your invited name"}</strong></p>
    {:else}
      <label>{@render Required("Your display name")} <input name="voterName" required value={viewerName} /></label>
    {/if}

    {#if isProposalType(poll.type)}
      <fieldset>
        <legend>{@render Required("Position")}<span class="legend-hint">Choose one</span></legend>
        {#each options as option (option.id)}
          <label>
            <input type="radio" name="optionId" value={option.id} checked={Number(currentBallot.optionId ?? 0) === option.id} required />
            {@render ChoiceText(option)}
          </label>
        {/each}
      </fieldset>
    {:else if poll.type === "choose" || poll.type === "approval"}
      {@const max = poll.type === "choose" ? (poll.config.maxChoices ?? 1) : null}
      <fieldset use:limitChoices={max !== null && max < options.length ? max : null}>
        <legend>Options<span class="legend-hint">{poll.type === "approval" ? "Approve as many as you like" : chooseRule(poll.config.minChoices ?? 1, poll.config.maxChoices ?? 1)}</span></legend>
        {#each options as option (option.id)}
          <label>
            <input type="checkbox" name="selected" value={option.id} checked={currentSelected.has(option.id)} />
            {@render ChoiceText(option)}
          </label>
        {/each}
      </fieldset>
    {:else if poll.type === "score"}
      {@const min = poll.config.scoreMin ?? 0}
      {@const max = poll.config.scoreMax ?? 5}
      <fieldset>
        <legend>{@render Required("Scores")}<span class="legend-hint">Score each option from {min} (worst) to {max} (best)</span></legend>
        {#each options as option (option.id)}
          <label class="inline-control">{option.label} <input type="number" name={`score_${option.id}`} min={min} max={max} value={String(currentScores[String(option.id)] ?? min)} required /></label>
        {/each}
      </fieldset>
    {:else if poll.type === "allocate"}
      <fieldset>
        <legend>Points<span class="legend-hint">Share up to {poll.config.pointBudget ?? 8} points across the options</span></legend>
        {#each options as option (option.id)}
          <label class="inline-control">{option.label} <input type="number" name={`allocation_${option.id}`} min="0" step="1" value={String(currentAllocations[String(option.id)] ?? 0)} /></label>
        {/each}
      </fieldset>
    {:else if poll.type === "rank" || poll.type === "irv" || poll.type === "stv"}
      {@const maxRanks = poll.type === "rank" ? (poll.config.rankCount ?? options.length) : options.length}
      <fieldset>
        <legend>{@render Required("Ranking")}<span class="legend-hint">{poll.type === "rank" ? `Rank up to ${maxRanks}, most preferred first` : "Rank as many as you like, most preferred first"}</span></legend>
        <RankBallot {options} {maxRanks} initial={currentRankings} limited={poll.type === "rank"} />
      </fieldset>
    {:else if poll.type === "time_poll"}
      <fieldset>
        <legend>{@render Required("Availability")}<span class="legend-hint">Mark every slot</span></legend>
        {#each options as option (option.id)}
          {@const current = String(currentAvailability[String(option.id)] ?? "unavailable")}
          <div class="slot">
            <strong><LocalTime value={option.label} {minutes} /></strong>
            {#if option.meaning}<span class="hint">{option.meaning}</span>{/if}
            <div class="radio-options">
              {#each ["available", "if_needed", "unavailable"] as state (state)}
                <label><input type="radio" name={`availability_${option.id}`} value={state} checked={current === state} required /> {state.replace("_", " ")}</label>
              {/each}
            </div>
          </div>
        {/each}
      </fieldset>
    {/if}

    {#if poll.config.reasonMode !== "disabled"}
      <label>
        {#if poll.config.reasonMode === "required"}{@render Required("Reason")}{:else}<span>Reason <span class="label-hint">(optional)</span></span>{/if}
        <textarea name="reason" rows="3" required={poll.config.reasonMode === "required"}>{viewerVote?.reason ?? ""}</textarea>
      </label>
    {/if}

  </form>
{/snippet}

{#snippet ChoiceText(option: Option)}
  <span>{option.label}{#if option.meaning}<span class="choice-meaning">{option.meaning}</span>{/if}</span>
{/snippet}

<!-- One element (so it stays on one line inside grid labels); CSS draws the asterisk. -->
{#snippet Required(text: string)}
  <span class="required">{text}</span>
{/snippet}
