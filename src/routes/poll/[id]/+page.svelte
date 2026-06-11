<script lang="ts">
  import { resolve } from "$app/paths";
  import { Button, Table, tableColumn, tableColumns } from "@flowercomputer/flowerparts";
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import { formatNumber } from "../../../tally";
  import { templateByType } from "../../../templates";
  import type { Option, Poll, TallyResult, Vote } from "../../../types";
  import { isClosed, isOpen, resultCells, resultHeaders, roundTallies, statusLabel } from "$lib/shared";

  let {
    data,
    form
  }: {
    data: {
      poll: Poll;
      options: Option[];
      votes: Vote[];
      viewerName: string;
      viewerVote: Vote | null;
      tally: TallyResult;
      showResults: boolean;
    };
    form?: { error?: string };
  } = $props();

  const template = $derived(templateByType.get(data.poll.type));
  function ballotObject(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }
</script>

<svelte:head>
  <title>{data.poll.title}</title>
</svelte:head>

<AppPageHeader title={data.poll.title} backHref={resolve("/")} backLabel="Back to home">
  {#snippet right()}
    {@render PollActions({ poll: data.poll })}
  {/snippet}
</AppPageHeader>

{#if form?.error}
  <p>{form.error}</p>
{/if}

<p>{template?.label ?? data.poll.type} · {statusLabel(data.poll)} · {data.votes.length} vote{data.votes.length === 1 ? "" : "s"}</p>

{#if data.poll.details}
  <section>
    <h2>Details</h2>
    {#each data.poll.details.split("\n") as line, index (index)}
      <p>{line}</p>
    {/each}
  </section>
{/if}

{#if data.poll.status === "draft"}
  <section>
    <h2>Draft preview</h2>
    <p class="hint">This is the voter-facing ballot preview. Voting is disabled until you open voting.</p>
    <div inert aria-disabled="true">
      {@render VoteForm({ poll: data.poll, options: data.options, viewerName: "", viewerVote: null })}
    </div>
  </section>
  <section>
    <h2>Results</h2>
    <p>Results will appear after voting opens and votes are submitted.</p>
  </section>
{:else}
  <section>
    <h2>Vote</h2>
    {#if isOpen(data.poll)}
      {@render VoteForm({ poll: data.poll, options: data.options, viewerName: data.viewerName, viewerVote: data.viewerVote })}
    {:else}
      <p>Voting is not open.</p>
    {/if}
  </section>
  <section>
    <h2>Results</h2>
    {#if data.showResults}
      {@render Results({ tally: data.tally, poll: data.poll })}
    {:else if data.poll.config.hideResults === "after_vote"}
      <p>Results are hidden until you vote.</p>
      <form method="get" action={resolve("/poll/[id]", { id: String(data.poll.id) })}>
        <label>Already voted? Enter your display name <input name="voterName" value={data.viewerName} /></label>
        <Button type="submit">Reveal if voted</Button>
      </form>
    {:else}
      <p>Results are hidden until this poll closes.</p>
    {/if}
  </section>
{/if}

{#if isClosed(data.poll)}
  <section>
    <h2>Export</h2>
    <p>
      <a href={resolve("/poll/[id]/export.json", { id: String(data.poll.id) })}>Export JSON</a> ·
      <a href={resolve("/poll/[id]/export.csv", { id: String(data.poll.id) })}>Export CSV</a>
    </p>
  </section>
{/if}

{#snippet PollActions({ poll }: { poll: Poll })}
  {#if poll.status === "draft"}
    <div class="actions">
      <Button href={resolve("/poll/[id]/edit", { id: String(poll.id) })} variant="secondary">Edit draft</Button>
      <form method="post" action="?/open"><Button type="submit" variant="primary">Open voting</Button></form>
    </div>
  {:else if !isClosed(poll)}
    <form method="post" action="?/close"><Button type="submit" variant="secondary">Close poll</Button></form>
  {/if}
{/snippet}

{#snippet VoteForm({ poll, options, viewerName, viewerVote }: { poll: Poll; options: Option[]; viewerName: string; viewerVote: Vote | null })}
  {@const currentBallot = ballotObject(viewerVote?.ballot)}
  {@const currentSelected = new Set(Array.isArray(currentBallot.selected) ? currentBallot.selected.map(Number) : [])}
  {@const currentScores = ballotObject(currentBallot.scores)}
  {@const currentAllocations = ballotObject(currentBallot.allocations)}
  {@const currentRankings = Array.isArray(currentBallot.rankings) ? currentBallot.rankings.map(Number) : []}
  {@const currentAvailability = ballotObject(currentBallot.availability)}
  <form method="post" action="?/vote">
    <label>Your display name <input name="voterName" required value={viewerName} /></label>

    {#if ["sense_check", "consent", "consensus", "majority"].includes(poll.type)}
      <fieldset>
        <legend>Position</legend>
        {#each options as option (option.id)}
          <label>
            <input type="radio" name="optionId" value={option.id} checked={Number(currentBallot.optionId ?? 0) === option.id} required />
            {option.label}{option.meaning ? ` - ${option.meaning}` : ""}
          </label>
        {/each}
      </fieldset>
    {:else if poll.type === "choose" || poll.type === "approval"}
      <fieldset>
        <legend>{poll.type === "approval" ? "Approve any options" : `Choose ${poll.config.minChoices ?? 1}-${poll.config.maxChoices ?? 1}`}</legend>
        {#each options as option (option.id)}
          <label>
            <input type="checkbox" name="selected" value={option.id} checked={currentSelected.has(option.id)} />
            {option.label}{option.meaning ? ` - ${option.meaning}` : ""}
          </label>
        {/each}
      </fieldset>
    {:else if poll.type === "score"}
      {@const min = poll.config.scoreMin ?? 0}
      {@const max = poll.config.scoreMax ?? 5}
      <fieldset>
        <legend>Score every option ({min}-{max})</legend>
        {#each options as option (option.id)}
          <label>{option.label} <input type="number" name={`score_${option.id}`} min={min} max={max} value={String(currentScores[String(option.id)] ?? min)} required /></label>
        {/each}
      </fieldset>
    {:else if poll.type === "allocate"}
      <fieldset>
        <legend>Allocate up to {poll.config.pointBudget ?? 8} points</legend>
        {#each options as option (option.id)}
          <label>{option.label} <input type="number" name={`allocation_${option.id}`} min="0" step="1" value={String(currentAllocations[String(option.id)] ?? 0)} /></label>
        {/each}
      </fieldset>
    {:else if poll.type === "rank" || poll.type === "irv" || poll.type === "stv"}
      {@const maxRanks = poll.type === "rank" ? (poll.config.rankCount ?? options.length) : options.length}
      <fieldset>
        <legend>Rank options</legend>
        <p class="hint">Put each option in at most one rank. Rank 1 is most preferred.</p>
        {#each Array.from({ length: maxRanks }, (_, index) => index) as index (index)}
          <label>
            Rank {index + 1}
            <select name={`rank_${index + 1}`}>
              <option value="">No selection</option>
              {#each options as option (option.id)}
                <option value={option.id} selected={currentRankings[index] === option.id}>{option.label}</option>
              {/each}
            </select>
          </label>
        {/each}
      </fieldset>
    {:else if poll.type === "time_poll"}
      <fieldset>
        <legend>Availability</legend>
        {#each options as option (option.id)}
          {@const current = String(currentAvailability[String(option.id)] ?? "unavailable")}
          <div class="row">
            <strong>{option.label}</strong>
            {#each ["available", "if_needed", "unavailable"] as state (state)}
              <label><input type="radio" name={`availability_${option.id}`} value={state} checked={current === state} required /> {state.replace("_", " ")}</label>
            {/each}
          </div>
        {/each}
      </fieldset>
    {/if}

    {#if poll.config.reasonMode !== "disabled"}
      <label>
        Reason {poll.config.reasonMode === "required" ? "(required)" : "(optional)"}
        <textarea name="reason" rows="3" required={poll.config.reasonMode === "required"}>{viewerVote?.reason ?? ""}</textarea>
      </label>
    {/if}

    <Button type="submit" variant="primary">{viewerVote ? "Update vote" : "Submit vote"}</Button>
  </form>
{/snippet}

{#snippet Results({ tally, poll }: { tally: TallyResult; poll: Poll })}
  <p><strong>{tally.outcome}</strong></p>
  <p>{tally.quorumText}{tally.quorumMet === null ? "" : tally.quorumMet ? " · quorum met" : " · quorum not met"}</p>
  {#if tally.quota}
    <p>Quota: {formatNumber(tally.quota)}</p>
  {/if}
  <Table
    label="Poll results"
    items={tally.rows}
    columns={tableColumns(...resultHeaders(tally).map(() => tableColumn.fill(1, "8rem")))}
    getKey={(row) => row.optionId}
    stickyHeader={false}
  >
    {#snippet header()}
        {#each resultHeaders(tally) as header (header)}
          <span role="columnheader">{header}</span>
        {/each}
    {/snippet}

    {#snippet row(resultRow)}
      {#each resultCells(tally, resultRow) as cell, index (index)}
        <span role="cell">{cell}</span>
      {/each}
    {/snippet}
  </Table>
  {#if tally.roundLogs?.length}
    <details>
      <summary>Round log</summary>
      <Table
        label="Round log"
        items={tally.roundLogs}
        columns={tableColumns(tableColumn.fit(), tableColumn.fit(), tableColumn.fill(1, "12rem"), tableColumn.fill(1, "12rem"))}
        getKey={(log, index) => `${index}-${log.round}-${log.action}`}
        minWidth="42rem"
        stickyHeader={false}
      >
        {#snippet header()}
          <span role="columnheader">Round</span>
          <span role="columnheader">Action</span>
          <span role="columnheader">Tallies</span>
          <span role="columnheader">Note</span>
        {/snippet}

        {#snippet row(log)}
          <span role="cell">{log.round}</span>
          <span role="cell">{log.action}</span>
          <span role="cell">{roundTallies(log)}</span>
          <span role="cell">{log.note ?? ""}</span>
        {/snippet}
      </Table>
    </details>
  {/if}
  {#if !poll.config.anonymous && poll.config.reasonMode !== "disabled" && tally.voteDetails?.length}
    <details>
      <summary>Vote reasons</summary>
      <ul>
        {#each tally.voteDetails as detail (detail.voterName)}
          <li><strong>{detail.voterName}</strong>{detail.reason ? `: ${detail.reason}` : ""}</li>
        {/each}
      </ul>
    </details>
  {/if}
{/snippet}
