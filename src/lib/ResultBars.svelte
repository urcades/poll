<script lang="ts">
  import type { Poll, PublicTallyResult } from "../types";
  import LocalTime from "./LocalTime.svelte";
  import { resultBars } from "./shared";

  let { tally, poll }: { tally: PublicTallyResult; poll: Poll } = $props();

  const bars = $derived(resultBars(tally, poll));
  const timePoll = $derived(tally.type === "time_poll");
  const minutes = $derived(poll.config.meetingDurationMinutes ?? 60);
</script>

<!-- Decorative summary of the results table below, which stays the accessible data. -->
<div class="chart" aria-hidden="true">
  {#each bars as bar (bar.optionId)}
    <div class="chart-row">
      <span class="chart-label">{#if timePoll}<LocalTime value={bar.label} {minutes} />{:else}{bar.label}{/if}</span>
      <span class="chart-track">
        {#each bar.segments as segment, index (index)}
          <span class="chart-fill chart-{tally.type} chart-{segment.kind}" style:width="{segment.percent}%"></span>
        {/each}
      </span>
      <span class="chart-value">{bar.text}</span>
    </div>
  {/each}
  {#if timePoll}
    <p class="chart-legend">
      <span><i class="chart-swatch chart-available"></i> available</span>
      <span><i class="chart-swatch chart-if_needed"></i> if needed</span>
      <span><i class="chart-swatch chart-unavailable"></i> unavailable</span>
    </p>
  {/if}
</div>
