<script lang="ts">
  import { onMount, tick } from "svelte";
  import type { Option } from "../types";

  /**
   * Ranking ballot for rank / irv / stv. Server-rendered as one <select> per
   * rank (works without JS); on mount it is replaced by a two-list reorderable
   * UI. Either way the form submits `rank_1..rank_N`, so parseBallot is unchanged.
   */
  let { options, maxRanks, initial, limited = false }: { options: Option[]; maxRanks: number; initial: number[]; /** true when only `maxRanks` options may be ranked (rank polls) */ limited?: boolean } = $props();

  const byId = $derived(new Map(options.map((option) => [option.id, option])));
  const validIds = () => new Set(options.map((option) => option.id));

  let enhanced = $state(false);
  let ranked = $state<number[]>([]);
  let announcement = $state("");
  let dragId = $state<number | null>(null);
  let dropTarget = $state<string | null>(null);
  let root: HTMLElement | undefined = $state();

  const unranked = $derived(options.filter((option) => !ranked.includes(option.id)));
  const full = $derived(ranked.length >= maxRanks);

  onMount(() => {
    const valid = validIds();
    const seen = new Set<number>();
    ranked = initial.filter((id) => valid.has(id) && !seen.has(id) && seen.add(id)).slice(0, maxRanks);
    enhanced = true;
  });

  function label(id: number): string {
    return byId.get(id)?.label ?? String(id);
  }

  function say(message: string) {
    // Clear first so repeated identical messages are announced again.
    announcement = "";
    tick().then(() => (announcement = message));
  }

  async function refocus(id: number, control: "main" | "up" | "down" = "main") {
    await tick();
    const selector = `[data-item="${id}"] [data-control="${control}"]:not([disabled])`;
    (root?.querySelector<HTMLElement>(selector) ?? root?.querySelector<HTMLElement>(`[data-item="${id}"] button`))?.focus();
  }

  function rank(id: number, position = ranked.length): boolean {
    if (ranked.includes(id)) return false;
    if (full) {
      say(`Cannot rank more than ${maxRanks} option${maxRanks === 1 ? "" : "s"}. Unrank one first.`);
      return false;
    }
    const next = [...ranked];
    next.splice(Math.min(position, next.length), 0, id);
    ranked = next;
    say(`${label(id)} ranked ${next.indexOf(id) + 1} of ${next.length}.`);
    return true;
  }

  function unrank(id: number): boolean {
    if (!ranked.includes(id)) return false;
    ranked = ranked.filter((other) => other !== id);
    say(`${label(id)} removed from your ranking. ${ranked.length} ranked.`);
    return true;
  }

  function move(id: number, delta: -1 | 1, control: "main" | "up" | "down" = "main") {
    const from = ranked.indexOf(id);
    const to = from + delta;
    if (from < 0) return;
    if (to < 0 || to >= ranked.length) {
      say(`${label(id)} is already ${delta < 0 ? "first" : "last"}.`);
      return;
    }
    const next = [...ranked];
    next.splice(from, 1);
    next.splice(to, 0, id);
    ranked = next;
    say(`${label(id)} moved to rank ${to + 1} of ${next.length}.`);
    refocus(id, control);
  }

  function toggle(id: number) {
    // Focus follows the item into its new list.
    if (ranked.includes(id) ? unrank(id) : rank(id)) refocus(id);
  }

  function onKeydown(event: KeyboardEvent, id: number, control: "main" | "up" | "down") {
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const delta = event.key === "ArrowUp" ? -1 : 1;
    if (ranked.includes(id)) {
      move(id, delta, control);
      return;
    }
    // In the unranked list arrows just move focus between items.
    const list = unranked.map((option) => option.id);
    const target = list[list.indexOf(id) + delta];
    if (target !== undefined) refocus(target);
  }

  function onDragStart(event: DragEvent, id: number) {
    dragId = id;
    event.dataTransfer?.setData("text/plain", String(id));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onDragEnd() {
    dragId = null;
    dropTarget = null;
  }

  function allowDrop(event: DragEvent, target: string) {
    if (dragId === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dropTarget = target;
  }

  /** Drop onto the ranked list, before `beforeId` (or at the end). */
  function dropRanked(event: DragEvent, beforeId: number | null) {
    event.preventDefault();
    event.stopPropagation();
    const id = dragId;
    onDragEnd();
    if (id === null) return;
    const wasRanked = ranked.includes(id);
    if (!wasRanked && full) {
      say(`Cannot rank more than ${maxRanks} option${maxRanks === 1 ? "" : "s"}. Unrank one first.`);
      return;
    }
    const next = ranked.filter((other) => other !== id);
    const at = beforeId === null || beforeId === id ? next.length : next.indexOf(beforeId);
    next.splice(at < 0 ? next.length : at, 0, id);
    ranked = next;
    say(`${label(id)} ${wasRanked ? "moved to" : "ranked"} ${next.indexOf(id) + 1} of ${next.length}.`);
  }

  function dropUnranked(event: DragEvent) {
    event.preventDefault();
    const id = dragId;
    onDragEnd();
    if (id !== null) unrank(id);
  }
</script>

{#if !enhanced}
  {#each Array.from({ length: maxRanks }, (_, index) => index) as index (index)}
    <label>
      Rank {index + 1}
      <select name={`rank_${index + 1}`}>
        <option value="">No selection</option>
        {#each options as option (option.id)}
          <option value={option.id} selected={initial[index] === option.id}>{option.label}</option>
        {/each}
      </select>
    </label>
  {/each}
{:else}
  <div class="rank-ballot" bind:this={root}>
    {#each Array.from({ length: maxRanks }, (_, index) => index) as index (index)}
      <input type="hidden" name={`rank_${index + 1}`} value={ranked[index] ?? ""} />
    {/each}

    <p class="hint">
      Select an option to move it between the lists. In the ranked list, use the arrow buttons, the up and down arrow keys, or drag to reorder. Rank 1 is most preferred.{limited ? ` You can rank at most ${maxRanks}.` : ""}
    </p>

    <div class="rank-lists">
      <div>
        <h3 id="ranked-heading">Ranked ({ranked.length}{limited ? ` of ${maxRanks}` : ""})</h3>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <ol
          class="rank-list"
          class:rank-drop={dropTarget === "ranked"}
          aria-labelledby="ranked-heading"
          ondragover={(event) => allowDrop(event, "ranked")}
          ondragleave={() => (dropTarget = null)}
          ondrop={(event) => dropRanked(event, null)}
        >
          {#each ranked as id, index (id)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li
              class="rank-item"
              class:dragging={dragId === id}
              data-item={id}
              draggable="true"
              ondragstart={(event) => onDragStart(event, id)}
              ondragend={onDragEnd}
              ondragover={(event) => allowDrop(event, "ranked")}
              ondrop={(event) => dropRanked(event, id)}
            >
              <span class="rank-number" aria-hidden="true">{index + 1}</span>
              <button type="button" class="rank-main" data-control="main" aria-label={`${label(id)}, rank ${index + 1}. Select to remove from ranking.`} onclick={() => toggle(id)} onkeydown={(event) => onKeydown(event, id, "main")}>{label(id)}</button>
              <button type="button" class="rank-move" data-control="up" aria-label={`Move ${label(id)} up`} disabled={index === 0} onclick={() => move(id, -1, "up")} onkeydown={(event) => onKeydown(event, id, "up")}>↑</button>
              <button type="button" class="rank-move" data-control="down" aria-label={`Move ${label(id)} down`} disabled={index === ranked.length - 1} onclick={() => move(id, 1, "down")} onkeydown={(event) => onKeydown(event, id, "down")}>↓</button>
            </li>
          {:else}
            <li class="rank-empty">Nothing ranked yet.</li>
          {/each}
        </ol>
      </div>

      <div>
        <h3 id="unranked-heading">Not ranked ({unranked.length})</h3>
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <ul
          class="rank-list"
          class:rank-drop={dropTarget === "unranked"}
          aria-labelledby="unranked-heading"
          ondragover={(event) => allowDrop(event, "unranked")}
          ondragleave={() => (dropTarget = null)}
          ondrop={dropUnranked}
        >
          {#each unranked as option (option.id)}
            <li class="rank-item" class:dragging={dragId === option.id} data-item={option.id} draggable="true" ondragstart={(event) => onDragStart(event, option.id)} ondragend={onDragEnd}>
              <button type="button" class="rank-main" data-control="main" aria-disabled={full} aria-label={`${option.label}. Select to rank it.`} onclick={() => toggle(option.id)} onkeydown={(event) => onKeydown(event, option.id, "main")}>{option.label}</button>
            </li>
          {:else}
            <li class="rank-empty">Every option is ranked.</li>
          {/each}
        </ul>
      </div>
    </div>

    <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
  </div>
{/if}
