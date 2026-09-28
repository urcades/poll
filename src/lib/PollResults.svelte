<script lang="ts">
  import { Table, tableColumn, tableColumns } from "@flowercomputer/flowerparts";
  import LocalTime from "$lib/LocalTime.svelte";
  import ResultBars from "$lib/ResultBars.svelte";
  import RoundChart from "$lib/RoundChart.svelte";
  import { formatNumber } from "../tally";
  import type { Poll, PublicTallyResult } from "../types";
  import { resultCells, resultHeaders, roundTallies } from "$lib/shared";

  // The outcome, quorum, charts and tables for one poll. `tally` is null when
  // the viewer may not see results yet (the server never sends them then).
  let { tally, poll }: { tally: PublicTallyResult | null; poll: Poll } = $props();

  const minutes = $derived(poll.config.meetingDurationMinutes ?? 60);
  const bestSlot = $derived(tally?.type === "time_poll" ? tally.rows[0]?.label ?? null : null);
</script>

{#if tally}
  <p>
    <strong>
      {#if bestSlot}Best timeslot: <LocalTime value={bestSlot} {minutes} />{:else}{tally.outcome}{/if}
    </strong>
  </p>
  <p>{tally.quorumText}{tally.quorumMet === null ? "" : tally.quorumMet ? " · quorum met" : " · quorum not met"}</p>
  {#if tally.quota}
    <p>Quota: {formatNumber(tally.quota)}</p>
  {/if}
  <ResultBars {tally} {poll} />
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
        <span role="cell">{#if tally.type === "time_poll" && index === 1}<LocalTime value={String(cell)} {minutes} />{:else}{cell}{/if}</span>
      {/each}
    {/snippet}
  </Table>
  {#if tally.roundLogs?.length}
    {#if tally.type === "irv" || tally.type === "stv"}
      <details open>
        <summary>Round by round</summary>
        <RoundChart {tally} />
      </details>
    {/if}
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
{:else if poll.config.hideResults === "after_vote"}
  <p>Results are hidden until you vote. They appear here once this browser has voted.</p>
{:else}
  <p>Results are hidden until this poll closes.</p>
{/if}
