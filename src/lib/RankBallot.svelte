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
  // Pointer dragging (mouse and pen). A press only becomes a drag after 4px
  // of movement, so a plain click still ranks or unranks. Touch keeps taps and
  // the arrow buttons, so swiping over the ballot still scrolls the page.
  type Press = { id: number; pointerId: number; x: number; y: number; from: "ranked" | "unranked" };
  let press: Press | null = null;
  let drag = $state<(Press & { startY: number }) | null>(null);
  let dragX = $state(0);
  let dragY = $state(0);
  let dropTarget = $state<"ranked" | "unranked" | null>(null);
  let rankedList: HTMLElement | undefined = $state();
  let unrankedList: HTMLElement | undefined = $state();
  let pointer = { x: 0, y: 0 };
  let reordering = false;
  let suppressClick = false;
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
    // The click that ends a drag is not a toggle.
    if (suppressClick) return;
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

  function pressItem(event: PointerEvent, id: number, from: Press["from"]) {
    if (event.button !== 0 || event.pointerType === "touch") return;
    if ((event.target as Element).closest(".rank-move")) return;
    press = { id, pointerId: event.pointerId, x: event.clientX, y: event.clientY, from };
  }

  function listUnder(x: number, y: number): Press["from"] | null {
    for (const [name, list] of [["ranked", rankedList], ["unranked", unrankedList]] as const) {
      const box = list?.getBoundingClientRect();
      if (box && x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) return name;
    }
    return null;
  }

  async function movePointer(event: PointerEvent) {
    if (press && !drag && event.pointerId === press.pointerId) {
      if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 4) return;
      try {
        (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      } catch {
        // Capture only fails for pointers the browser no longer tracks.
      }
      drag = { ...press, startY: press.y };
    }
    if (!drag || event.pointerId !== drag.pointerId) return;
    pointer = { x: event.clientX, y: event.clientY };
    dragX = pointer.x - drag.x;
    dragY = pointer.y - drag.startY;
    dropTarget = listUnder(pointer.x, pointer.y);
    if (drag.from === "ranked" && dropTarget === "ranked") await reorderRanked();
  }

  /** Live reorder within the ranked list as the item passes a neighbour's middle. */
  async function reorderRanked() {
    if (reordering || !rankedList) return;
    reordering = true;
    try {
      while (drag && rankedList) {
        const items = [...rankedList.querySelectorAll<HTMLElement>(":scope > .rank-item")];
        const index = ranked.indexOf(drag.id);
        const item = items[index];
        if (!item) break;
        // Layout positions (offsetTop ignores the drag transform).
        const center = item.offsetTop + item.offsetHeight / 2 + dragY;
        const next = items[index + 1];
        const previous = items[index - 1];
        const to = next && center > next.offsetTop + next.offsetHeight / 2 ? index + 1
          : previous && center < previous.offsetTop + previous.offsetHeight / 2 ? index - 1
          : index;
        if (to === index) break;
        const before = item.offsetTop;
        const reordered = [...ranked];
        reordered.splice(index, 1);
        reordered.splice(to, 0, drag.id);
        ranked = reordered;
        await tick();
        if (!drag) break;
        // Keep the item under the pointer now that its slot has moved.
        drag.startY += item.offsetTop - before;
        dragY = pointer.y - drag.startY;
      }
    } finally {
      reordering = false;
    }
  }

  function endDrag() {
    press = null;
    drag = null;
    dragX = 0;
    dragY = 0;
    dropTarget = null;
  }

  function releasePointer(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) {
      if (press?.pointerId === event.pointerId) press = null;
      return;
    }
    const { id, from } = drag;
    const target = listUnder(event.clientX, event.clientY);
    const y = event.clientY;
    endDrag();
    suppressClick = true;
    setTimeout(() => (suppressClick = false));
    if (from === "unranked" && target === "ranked") {
      // Insert where it was dropped: after every ranked item whose middle is above the pointer.
      const items = [...(rankedList?.querySelectorAll<HTMLElement>(":scope > .rank-item") ?? [])];
      const at = items.filter((item) => {
        const box = item.getBoundingClientRect();
        return box.top + box.height / 2 < y;
      }).length;
      if (rank(id, at)) refocus(id);
    } else if (from === "ranked" && target === "unranked") {
      if (unrank(id)) refocus(id);
    } else if (from === "ranked" && target === "ranked") {
      say(`${label(id)} moved to rank ${ranked.indexOf(id) + 1} of ${ranked.length}.`);
    }
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
      <!-- Pool first, then the ranking: options move left to right as you rank them. -->
      <div>
        <h3 id="unranked-heading">Not ranked ({unranked.length})</h3>
        <ul class="rank-list" class:rank-drop={drag && dropTarget === "unranked"} aria-labelledby="unranked-heading" bind:this={unrankedList}>
          {#each unranked as option (option.id)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li
              class="rank-item"
              class:lifted={drag?.id === option.id}
              style:transform={drag?.id === option.id ? `translate(${dragX}px, ${dragY}px)` : null}
              data-item={option.id}
              onpointerdown={(event) => pressItem(event, option.id, "unranked")}
              onpointermove={movePointer}
              onpointerup={releasePointer}
              onpointercancel={endDrag}
            >
              <button type="button" class="rank-main" data-control="main" aria-disabled={full} aria-label={`${option.label}. Select to rank it.`} onclick={() => toggle(option.id)} onkeydown={(event) => onKeydown(event, option.id, "main")}>{option.label}</button>
            </li>
          {:else}
            <li class="rank-empty">Every option is ranked.</li>
          {/each}
        </ul>
      </div>

      <div>
        <h3 id="ranked-heading">Ranked ({ranked.length}{limited ? ` of ${maxRanks}` : ""})</h3>
        <ol class="rank-list" class:rank-drop={drag && dropTarget === "ranked"} aria-labelledby="ranked-heading" bind:this={rankedList}>
          {#each ranked as id, index (id)}
            <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
            <li
              class="rank-item"
              class:lifted={drag?.id === id}
              style:transform={drag?.id === id ? `translate(${dragX}px, ${dragY}px)` : null}
              data-item={id}
              onpointerdown={(event) => pressItem(event, id, "ranked")}
              onpointermove={movePointer}
              onpointerup={releasePointer}
              onpointercancel={endDrag}
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
    </div>

    <p class="sr-only" role="status" aria-live="polite">{announcement}</p>
  </div>
{/if}
