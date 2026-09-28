<script lang="ts">
  import { formatNumber } from "../tally";
  import type { PublicTallyResult } from "../types";
  import { roundStages } from "./shared";

  let { tally }: { tally: PublicTallyResult } = $props();

  const stages = $derived(roundStages(tally));
  const scaleMax = $derived(Math.max(1, ...stages.flatMap((stage) => [stage.threshold ?? 0, ...stage.bars.map((bar) => bar.value)])) * 1.04);
  const thresholdName = $derived(tally.type === "irv" ? "Majority" : "Quota");
  const pct = (value: number) => `${Math.min(100, (value / scaleMax) * 100)}%`;
</script>

<!-- Decorative: the round log table gives the same numbers as text. -->
<div class="chart rounds" aria-hidden="true">
  {#each stages as stage (stage.round)}
    <div class="round">
      <h4>Round {stage.round}{#if stage.threshold !== null}<small> · {thresholdName.toLowerCase()} {formatNumber(stage.threshold)}</small>{/if}</h4>
      <div class="round-bars">
        {#each stage.bars as bar (bar.optionId)}
          <div class="chart-row">
            <span class="chart-label">{bar.label}</span>
            <span class="chart-track">
              <span class="chart-fill chart-{tally.type} chart-{bar.mark ?? 'main'}" style:width={pct(bar.value)}></span>
              {#if stage.threshold !== null}
                <span class="chart-threshold" style:left={pct(stage.threshold)}></span>
              {/if}
            </span>
            <span class="chart-value">{formatNumber(bar.value)}{#if bar.mark} <b class="chart-mark chart-mark-{bar.mark}">{bar.mark}</b>{/if}</span>
          </div>
        {/each}
      </div>
    </div>
  {/each}
  <p class="chart-legend"><span><i class="chart-swatch chart-threshold-swatch"></i> {thresholdName} line</span></p>
</div>
