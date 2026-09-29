<script lang="ts">
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
  <div class="table-wrap">
    <table aria-label="Poll results">
      <thead>
        <tr>
          {#each resultHeaders(tally) as header (header)}
            <th scope="col">{header}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each tally.rows as resultRow (resultRow.optionId)}
          <tr>
            {#each resultCells(tally, resultRow) as cell, index (index)}
              <td>{#if tally.type === "time_poll" && index === 1}<LocalTime value={String(cell)} {minutes} />{:else}{cell}{/if}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if tally.roundLogs?.length}
    {#if tally.type === "irv" || tally.type === "stv"}
      <details open>
        <summary>Round by round</summary>
        <RoundChart {tally} />
      </details>
    {/if}
    <details>
      <summary>Round log</summary>
      <div class="table-wrap">
        <table class="round-log" aria-label="Round log">
          <thead>
            <tr>
              <th scope="col">Round</th>
              <th scope="col">Action</th>
              <th scope="col">Tallies</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {#each tally.roundLogs as log, index (`${index}-${log.round}-${log.action}`)}
              <tr>
                <td>{log.round}</td>
                <td>{log.action}</td>
                <td>{roundTallies(log)}</td>
                <td>{log.note ?? ""}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
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
