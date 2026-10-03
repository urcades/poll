<script lang="ts">
  import AppPageHeader from "$lib/AppPageHeader.svelte";
  import type { PageProps } from "./$types";

  let { data }: PageProps = $props();

  const params = $derived(new URLSearchParams(Object.entries(data.query).filter(([, value]) => value)).toString());
  const days = $derived([...new Set(data.summary.map((row) => row.day))].slice(0, 14));
  const kinds = $derived([...new Set(data.summary.map((row) => row.kind))].sort());
  const count = (day: string, kind: string) => data.summary.find((row) => row.day === day && row.kind === kind)?.count ?? 0;
</script>

<svelte:head>
  <title>Usage log</title>
  <meta name="robots" content="noindex" />
</svelte:head>

<AppPageHeader title="Usage log" backHref="/" backLabel="Back to home" />

<p><a class="button button-secondary" href="/events/corrections">Model corrections</a></p>

<section>
  <h2>Filter</h2>
  <form method="get" class="filters">
    <label>Kind <input name="kind" value={data.query.kind} placeholder="describe, vote_cast, client_click…" /></label>
    <label>Kind starts with <input name="kindPrefix" value={data.query.kindPrefix} placeholder="poll_, client_, mcp_" /></label>
    <label>Poll id <input name="poll" value={data.query.poll} /></label>
    <label>Session <input name="session" value={data.query.session} /></label>
    <label>Source
      <select name="source">
        <option value="">any</option>
        {#each ["web", "api", "mcp", "browser", "internal"] as source (source)}
          <option value={source} selected={data.query.source === source}>{source}</option>
        {/each}
      </select>
    </label>
    <label>Contains text <input name="text" value={data.query.text} placeholder="search prompts, titles, paths" /></label>
    <label>Since (ISO) <input name="since" value={data.query.since} placeholder="2026-10-01" /></label>
    <label>Until (ISO) <input name="until" value={data.query.until} placeholder="2026-10-31" /></label>
    <label>Rows <input name="limit" type="number" min="1" max="1000" value={data.query.limit} placeholder="100" /></label>
    <div class="filter-actions">
      <button class="button button-primary" type="submit">Apply</button>
      <a class="button button-secondary" href="/events/export.json{params ? `?${params}` : ''}">Download JSON</a>
      <a class="button button-secondary" href="/events/export.csv{params ? `?${params}` : ''}">Download CSV</a>
    </div>
  </form>
</section>

<section>
  <h2>Counts by day</h2>
  {#if days.length}
    <div class="table-scroll">
      <table>
        <thead>
          <tr><th>Kind</th>{#each days as day (day)}<th>{day.slice(5)}</th>{/each}</tr>
        </thead>
        <tbody>
          {#each kinds as kind (kind)}
            <tr><th scope="row">{kind}</th>{#each days as day (day)}<td>{count(day, kind) || ""}</td>{/each}</tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <p class="hint">No events match.</p>
  {/if}
</section>

<section>
  <h2>Events</h2>
  <ul class="event-list">
    {#each data.events as event (event.id)}
      <li>
        <details>
          <summary>
            <span class="meta">{event.ts.replace("T", " ").slice(0, 19)}</span>
            <strong>{event.kind}</strong>
            <span class="meta">{event.source}{event.pollSlug ? ` · ` : ""}{#if event.pollSlug}<a href="?poll={event.pollSlug}">{event.pollSlug}</a>{/if}{event.session ? ` · ` : ""}{#if event.session}<a href="?session={event.session}">{event.session.slice(0, 8)}</a>{/if}</span>
          </summary>
          <pre>{JSON.stringify(event.data, null, 2)}</pre>
        </details>
      </li>
    {/each}
  </ul>
  {#if data.next}
    <p><a class="button button-secondary" href="?{params ? `${params}&` : ''}before={data.next}">Older events</a></p>
  {/if}
</section>
