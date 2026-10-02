<script lang="ts">
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const percent = (value: number | null) => (value === null ? "–" : `${Math.round(value * 100)}%`);
  const show = (value: unknown) => (value === null || value === undefined ? "–" : typeof value === "string" ? value : Array.isArray(value) ? value.join(", ") : JSON.stringify(value));
  const outcomes = ["accepted", "corrected", "rephrased", "abandoned", "pending"] as const;
  const params = $derived(new URLSearchParams(Object.entries(data.query).filter(([key, value]) => value && key !== "outcome")).toString());
</script>

<svelte:head>
  <title>Jev corrections</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<AppPageHeader title="Jev corrections" backHref="/events" backLabel="Back to usage log" />

<section>
  <h2>Outcomes</h2>
  <p class="hint">{data.stats.descriptions} descriptions. Of the polls people saved, {percent(data.stats.acceptedShare)} were kept exactly as Jev filled them in.</p>
  <div class="table-scroll">
    <table>
      <thead><tr>{#each outcomes as outcome (outcome)}<th><a href="?{params ? `${params}&` : ''}outcome={outcome}">{outcome}</a></th>{/each}</tr></thead>
      <tbody><tr>{#each outcomes as outcome (outcome)}<td>{data.stats.outcomes[outcome]}</td>{/each}</tr></tbody>
    </table>
  </div>
  <p>
    <a class="button button-secondary" href="/events/corrections/export.jsonl{params ? `?${params}` : ''}">Download everything (JSONL)</a>
    <a class="button button-secondary" href="/events/corrections/export.jsonl?saved=1{params ? `&${params}` : ''}">Download labelled only</a>
  </p>
</section>

<section>
  <h2>What gets corrected</h2>
  {#if data.stats.fieldCorrections.length}
    <div class="table-scroll">
      <table>
        <thead><tr><th>Field</th><th>Corrected</th><th>Share of saved polls</th><th>Jev missed it</th></tr></thead>
        <tbody>
          {#each data.stats.fieldCorrections as row (row.field)}
            <tr><th scope="row">{row.field}</th><td>{row.count}</td><td>{percent(row.share)}</td><td>{row.missed || ""}</td></tr>
          {/each}
        </tbody>
      </table>
    </div>
    <p class="hint">"Jev missed it" counts settings Jev left at the default that the person then changed, for example making a poll anonymous when the prompt said so.</p>
  {:else}
    <p class="hint">No corrections yet.</p>
  {/if}
</section>

<section>
  <h2>Voting method: Jev versus saved</h2>
  <div class="table-scroll">
    <table>
      <thead><tr><th>Jev's confidence</th><th>Saved polls</th><th>Method kept</th></tr></thead>
      <tbody>{#each data.stats.calibration as row (row.bucket)}<tr><th scope="row">{row.bucket}</th><td>{row.saved}</td><td>{percent(row.typeKeptShare)}</td></tr>{/each}</tbody>
    </table>
  </div>
  {#if data.stats.typeConfusions.length}
    <div class="table-scroll">
      <table>
        <thead><tr><th>Jev said</th><th>They chose</th><th>Times</th></tr></thead>
        <tbody>{#each data.stats.typeConfusions as row (`${row.jev}>${row.final}`)}<tr><td>{row.jev}</td><td>{row.final}</td><td>{row.count}</td></tr>{/each}</tbody>
      </table>
    </div>
  {/if}
</section>

<section>
  <h2>Descriptions{data.query.outcome ? ` (${data.query.outcome})` : ""}</h2>
  <ul class="event-list">
    {#each data.rows as row (row.describeEventId)}
      <li>
        <details>
          <summary>
            <span class="meta">{row.ts.replace("T", " ").slice(0, 16)}</span>
            <strong>{row.outcome}</strong>
            <span>{row.prompt.length > 90 ? `${row.prompt.slice(0, 90)}…` : row.prompt}</span>
          </summary>
          <p>Jev: <strong>{row.jev.type}</strong> ({percent(row.jev.confidence)}){row.final && row.final.type !== row.jev.type ? ` → saved as ${row.final.type}` : ""}{row.pickedAlternative ? " (a method Jev listed as close)" : ""}</p>
          {#if row.changes.length}
            <ul>
              {#each row.changes as change (change.field)}
                <li><strong>{change.field}</strong>: Jev {show(change.jev)} → {show(change.final)}{change.jevSet === false ? " (Jev left it at the default)" : ""}</li>
              {/each}
            </ul>
          {/if}
          {#if row.rephrasedTo}<p>Then they typed: “{row.rephrasedTo}”</p>{/if}
          {#if row.pollSlug}<p class="hint">Poll <a href="/events?poll={row.pollSlug}">{row.pollSlug}</a>{row.opened ? ", opened" : ", still a draft"}{row.deleted ? ", deleted" : ""}</p>{/if}
        </details>
      </li>
    {/each}
  </ul>
</section>
