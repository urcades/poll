<script lang="ts">
  import { enhance } from "$app/forms";
  import Button from "$lib/Button.svelte";
  import { optionPattern } from "$lib/patterns";
  import { pendingForm } from "$lib/enhance.svelte";
  import { defaultOptionsText, templates } from "../templates";
  import { isProposalType, type PollConfig, type PollType } from "../types";
  import { onMount, tick, untrack } from "svelte";
  import { parseSlot } from "$lib/shared";

  /**
   * `uid` keys the row so it keeps focus while typing. For time polls `label`
   * is the ISO UTC instant and `local` is what the datetime-local input shows.
   */
  type OptionItem = { uid: number; label: string; meaning: string; local: string };
  let nextUid = 0;

  const templateGroups = [
    { label: "Proposal templates", category: "proposal" },
    { label: "Poll shapes", category: "poll" },
    { label: "Election methods", category: "election" }
  ] as const;

  const templatesByType = Object.fromEntries(templates.map((template) => [template.type, template]));
  const optionLabels: Record<PollType, string> = {
    sense_check: "Voting positions",
    consent: "Voting positions",
    consensus: "Voting positions",
    majority: "Voting positions",
    choose: "Options",
    approval: "Approval options",
    score: "Scored options",
    allocate: "Allocation options",
    rank: "Rankable options",
    irv: "Candidates",
    stv: "Candidates",
    time_poll: "Timeslots"
  };

  let {
    action = "",
    selected,
    values,
    id,
    pending = $bindable(false),
    freshDefaults = false
  }: {
    action?: string;
    /** New polls only: example timeslots are regenerated in the browser's own time zone. */
    freshDefaults?: boolean;
    selected: PollType;
    values: {
      title: string;
      details: string;
      optionsText: string;
      opensAt: string;
      closesAt: string;
      inviteesText: string;
      config: PollConfig;
    };
    /** The page header's primary action submits the form by this id. */
    id: string;
    pending?: boolean;
  } = $props();

  const submit = pendingForm();
  $effect(() => {
    pending = submit.pending;
  });
  const initial = untrack(() => ({ selected, values }));

  let selectedType = $state.raw(initial.selected);
  let lastType = $state.raw(initial.selected);
  let optionItems = $state.raw(parseOptionsText(initial.values.optionsText));
  const initialSerialized = serializeOptions(parseOptionsText(initial.values.optionsText));
  let mounted = $state(false);
  // Pointer-driven reordering: the grabbed card follows the pointer (raised,
  // opaque, shadowed) and the list reorders as it passes a neighbour's middle.
  let drag = $state<{ uid: number; pointerId: number; startY: number } | null>(null);
  let dragOffset = $state(0);
  let optionList: HTMLElement | undefined = $state();

  let minChoices = $state(initial.values.config.minChoices ?? 1);
  let maxChoices = $state(initial.values.config.maxChoices ?? 1);
  let scoreMin = $state(initial.values.config.scoreMin ?? 0);
  let scoreMax = $state(initial.values.config.scoreMax ?? 5);
  let pointBudget = $state(initial.values.config.pointBudget ?? 8);
  let rankCount = $state(initial.values.config.rankCount ?? 3);
  let seats = $state(initial.values.config.seats ?? 1);
  let stvMethod = $state(initial.values.config.stvMethod ?? "scottish");
  let quotaType = $state(initial.values.config.quotaType ?? "droop");
  let meetingDurationMinutes = $state(initial.values.config.meetingDurationMinutes ?? 60);
  let voterMode = $state<"open" | "invite">(initial.values.config.voterMode === "invite" ? "invite" : "open");
  let inviteesText = $state(initial.values.inviteesText);
  let opensAt = $state(initial.values.opensAt);
  let closesAt = $state(initial.values.closesAt);

  const activeTemplate = $derived(templatesByType[selectedType]);
  const optionCount = $derived(optionItems.filter((option) => option.label.trim()).length);
  const fixed = $derived(isProposalType(selectedType));
  const serializedOptions = $derived(serializeOptions(optionItems));
  const optionsHint = $derived(getOptionsHint());
  const inviteeCount = $derived(new Set(inviteesText.split(/\r?\n/).map((line) => line.trim().toLowerCase()).filter(Boolean)).size);

  function parseOptionsText(text: string): OptionItem[] {
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        return { uid: nextUid++, label: (parts.shift() ?? "").trim(), meaning: parts.join("|").trim(), local: "" };
      })
      .filter((option) => option.label);
  }

  /** ISO instant (or a legacy `YYYY-MM-DD HH:MM`, taken as local) -> datetime-local value in the browser's zone; "" if it is neither. */
  function toLocalInput(label: string): string {
    const legacy = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2})?$/.exec(label);
    if (legacy) return `${legacy[1]}T${legacy[2]}`;
    const date = parseSlot(label);
    return date ? localDateTimeValue(date) : "";
  }

  /** datetime-local value in the browser's zone -> ISO UTC; "" while incomplete. */
  function toIso(local: string): string {
    const date = new Date(local);
    return local && !Number.isNaN(date.getTime()) ? date.toISOString() : "";
  }

  /** Fills each row's local input from its label. Browser only: the server does not know the viewer's zone. */
  function withLocalInputs(items: OptionItem[]): OptionItem[] {
    if (selectedType !== "time_poll") return items;
    return items.map((item) => {
      const local = toLocalInput(item.label);
      return { ...item, local, label: local ? toIso(local) : item.label };
    });
  }

  onMount(() => {
    mounted = true;
    if (freshDefaults && selectedType === "time_poll" && serializeOptions(optionItems) === initialSerialized) {
      optionItems = withLocalInputs(parseOptionsText(defaultOptionsText("time_poll")));
    } else {
      optionItems = withLocalInputs(optionItems);
    }
  });

  function serializeOptions(options: OptionItem[]): string {
    return options
      .filter((option) => option.label.trim())
      .map((option) => option.meaning.trim() ? `${option.label.trim()} | ${option.meaning.trim()}` : option.label.trim())
      .join("\n");
  }

  function syncType() {
    if (selectedType !== lastType && (!serializedOptions.trim() || serializedOptions === defaultOptionsText(lastType))) {
      optionItems = withLocalInputs(parseOptionsText(defaultOptionsText(selectedType)));
    }
    lastType = selectedType;
  }

  function startDrag(event: PointerEvent, uid: number) {
    if (fixed || event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest("input, textarea, select, button, a")) return;
    // On touch, only the handle drags, so the card body still scrolls the page.
    if (event.pointerType !== "mouse" && !target.closest(".drag-handle")) return;
    event.preventDefault();
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Capture only fails for pointers the browser no longer tracks.
    }
    drag = { uid, pointerId: event.pointerId, startY: event.clientY };
    dragOffset = 0;
  }

  let reordering = false;
  let pointerY = 0;

  async function moveDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    pointerY = event.clientY;
    dragOffset = pointerY - drag.startY;
    // One reorder pass at a time; it always works from the latest pointer
    // position, so moves that arrive mid-swap are not lost.
    if (reordering || !optionList) return;
    reordering = true;
    try {
      // Keep swapping until the card sits in the slot under the pointer, so a
      // fast flick across several cards lands in the right place.
      while (drag && optionList) {
        const cards = [...optionList.querySelectorAll<HTMLElement>(":scope > .option-block")];
        const index = optionItems.findIndex((option) => option.uid === drag?.uid);
        const card = cards[index];
        if (!card) break;
        // Layout positions (offsetTop ignores the drag transform).
        const center = card.offsetTop + card.offsetHeight / 2 + dragOffset;
        const next = cards[index + 1];
        const previous = cards[index - 1];
        const to = next && center > next.offsetTop + next.offsetHeight / 2 ? index + 1
          : previous && center < previous.offsetTop + previous.offsetHeight / 2 ? index - 1
          : index;
        if (to === index) break;
        // Swap, then shift the drag origin by how far the card's slot moved so
        // it stays under the pointer.
        const before = card.offsetTop;
        moveOption(index, to);
        await tick();
        if (!drag) break;
        drag.startY += card.offsetTop - before;
        dragOffset = pointerY - drag.startY;
      }
    } finally {
      reordering = false;
    }
  }

  function endDrag(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    drag = null;
    dragOffset = 0;
  }

  function moveOption(from: number, to: number) {
    if (fixed || to < 0 || to >= optionItems.length) return;
    const next = [...optionItems];
    const [item] = next.splice(from, 1);
    if (!item) return;
    next.splice(to, 0, item);
    optionItems = next;
  }

  function removeOption(index: number) {
    if (fixed || optionItems.length <= 1) return;
    optionItems = optionItems.filter((_, optionIndex) => optionIndex !== index);
  }

  function addOption() {
    if (selectedType === "time_poll") {
      // The day after the last slot, same time.
      const last = optionItems.at(-1)?.local;
      const base = last ? new Date(last) : new Date();
      if (!last) base.setHours(10, 0, 0, 0);
      base.setDate(base.getDate() + 1);
      const local = localDateTimeValue(base);
      optionItems = [...optionItems, { uid: nextUid++, label: toIso(local), meaning: "", local }];
      return;
    }
    const label = selectedType === "irv" || selectedType === "stv" ? "New candidate" : "New option";
    optionItems = [...optionItems, { uid: nextUid++, label, meaning: "", local: "" }];
  }

  function updateOption(index: number, patch: Partial<OptionItem>) {
    optionItems = optionItems.map((option, optionIndex) => optionIndex === index ? { ...option, ...patch } : option);
  }

  function localDateTimeValue(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, "0");
    return [
      date.getFullYear(),
      pad(date.getMonth() + 1),
      pad(date.getDate())
    ].join("-") + "T" + [pad(date.getHours()), pad(date.getMinutes())].join(":");
  }

  function setNow() {
    opensAt = localDateTimeValue(new Date());
  }

  function setEndOfDay() {
    const now = new Date();
    const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 0, 0);
    closesAt = localDateTimeValue(endOfDay);
  }

  function getOptionsHint(): string {
    if (fixed) return "This proposal type has fixed voting positions because its outcome logic depends on them.";
    if (selectedType === "rank") return `One per line. Ranked choices cannot exceed the ${optionCount} available option${optionCount === 1 ? "" : "s"}.`;
    if (selectedType === "time_poll") return "Pick a date and time for each slot in your own time zone. Slots are stored in UTC and shown to each voter in theirs.";
    if (selectedType === "irv") return "One candidate per line. IRV needs at least 2 candidates.";
    if (selectedType === "stv") return `One candidate per line. Seats must be less than the ${optionCount} candidate${optionCount === 1 ? "" : "s"}.`;
    return 'One per line. Use "Name | meaning" for optional meaning text.';
  }

</script>

<form {id} method="post" {action} use:enhance={submit.enhance}>
  <section>
    <h2>Poll type</h2>
    <label>
      Voting method
      <select name="type" id="type" bind:value={selectedType} onchange={syncType}>
        {#each templateGroups as group (group.label)}
          <optgroup label={group.label}>
            {#each templates.filter((template) => template.category === group.category) as template (template.type)}
              <option value={template.type}>{template.label}</option>
            {/each}
          </optgroup>
        {/each}
      </select>
    </label>

    <div id="type-help" class="callout" aria-live="polite">
      <p id="type-description">{activeTemplate.description}</p>
      <p><strong>Example:</strong> <span id="type-example">{activeTemplate.example}</span></p>
      <p><strong>Results:</strong> <span id="type-result-shape">{activeTemplate.resultShape}</span></p>
      <p>
        <strong>Learn more:</strong>
        <span id="type-links">
          {#if selectedType === "sense_check"}
            <a href="https://help.loomio.com/en/user_manual/polls/proposals/index.html" target="_blank" rel="noreferrer">Loomio proposal docs</a>, <a href="https://en.wikipedia.org/wiki/Consensus_decision-making" target="_blank" rel="noreferrer">Consensus decision-making</a>
          {:else if selectedType === "consent"}
            <a href="https://help.loomio.com/en/user_manual/polls/proposals/index.html" target="_blank" rel="noreferrer">Loomio proposal docs</a>, <a href="https://en.wikipedia.org/wiki/Sociocracy" target="_blank" rel="noreferrer">Sociocracy</a>
          {:else if selectedType === "consensus"}
            <a href="https://help.loomio.com/en/user_manual/polls/proposals/index.html" target="_blank" rel="noreferrer">Loomio proposal docs</a>, <a href="https://en.wikipedia.org/wiki/Consensus_decision-making" target="_blank" rel="noreferrer">Consensus decision-making</a>
          {:else if selectedType === "majority"}
            <a href="https://help.loomio.com/en/user_manual/polls/proposals/index.html" target="_blank" rel="noreferrer">Loomio proposal docs</a>, <a href="https://en.wikipedia.org/wiki/Majority_rule" target="_blank" rel="noreferrer">Majority rule</a>
          {:else if selectedType === "choose"}
            <a href="https://help.loomio.com/en/user_manual/polls/proposal_types/" target="_blank" rel="noreferrer">Loomio poll docs</a>, <a href="https://en.wikipedia.org/wiki/Approval_voting" target="_blank" rel="noreferrer">Approval voting</a>
          {:else if selectedType === "approval"}
            <a href="https://opavote.com/methods/overview" target="_blank" rel="noreferrer">OpaVote methods overview</a>, <a href="https://en.wikipedia.org/wiki/Approval_voting" target="_blank" rel="noreferrer">Approval voting</a>
          {:else if selectedType === "score"}
            <a href="https://help.loomio.com/en/user_manual/polls/proposal_types/" target="_blank" rel="noreferrer">Loomio poll docs</a>, <a href="https://en.wikipedia.org/wiki/Score_voting" target="_blank" rel="noreferrer">Score voting</a>
          {:else if selectedType === "allocate"}
            <a href="https://help.loomio.com/en/user_manual/polls/proposal_types/" target="_blank" rel="noreferrer">Loomio poll docs</a>, <a href="https://en.wikipedia.org/wiki/Dot-voting" target="_blank" rel="noreferrer">Dot voting</a>
          {:else if selectedType === "rank"}
            <a href="https://help.loomio.com/en/user_manual/polls/proposal_types/" target="_blank" rel="noreferrer">Loomio poll docs</a>, <a href="https://en.wikipedia.org/wiki/Borda_count" target="_blank" rel="noreferrer">Borda count</a>
          {:else if selectedType === "irv"}
            <a href="https://opavote.com/methods/instant-runoff-voting" target="_blank" rel="noreferrer">OpaVote ranked-choice methods</a>, <a href="https://en.wikipedia.org/wiki/Instant-runoff_voting" target="_blank" rel="noreferrer">Instant-runoff voting</a>
          {:else if selectedType === "stv"}
            <a href="https://help.loomio.com/en/user_manual/polls/stv/index.html" target="_blank" rel="noreferrer">Loomio STV docs</a>, <a href="https://en.wikipedia.org/wiki/Single_transferable_vote" target="_blank" rel="noreferrer">Single transferable vote</a>
          {:else if selectedType === "time_poll"}
            <a href="https://help.loomio.com/en/user_manual/polls/meeting_polls/index.html" target="_blank" rel="noreferrer">Loomio meeting poll docs</a>, <a href="https://help.loomio.com/en/user_manual/polls/proposal_types/" target="_blank" rel="noreferrer">Loomio poll docs</a>
          {/if}
        </span>
      </p>
    </div>
  </section>

  <section>
    <h2>Question</h2>
    <label>{@render Required("Title")} <input name="title" required value={values.title} /></label>
    <label>Details <textarea name="details" rows="4">{values.details}</textarea></label>
  </section>

  {#if selectedType === "choose" || selectedType === "score" || selectedType === "allocate" || selectedType === "rank" || selectedType === "stv" || selectedType === "time_poll"}
    <section id="type-settings">
      <h2>Voting rules</h2>
      <div class="compact-fields">
      {#if selectedType === "choose"}
        <label>Minimum choices <input type="number" name="minChoices" min="0" max={Math.max(0, optionCount)} bind:value={minChoices} /></label>
        <label>Maximum choices <input type="number" name="maxChoices" min="1" max={Math.max(1, optionCount)} bind:value={maxChoices} /></label>
      {:else if selectedType === "score"}
        <label>Minimum score <input type="number" name="scoreMin" bind:value={scoreMin} /></label>
        <label>Maximum score <input type="number" name="scoreMax" bind:value={scoreMax} /></label>
      {:else if selectedType === "allocate"}
        <label>Point budget <input type="number" name="pointBudget" min="1" bind:value={pointBudget} /></label>
      {:else if selectedType === "rank"}
        <label>Number of ranked choices <input type="number" name="rankCount" min="1" max={Math.max(1, optionCount)} bind:value={rankCount} /></label>
      {:else if selectedType === "stv"}
        <label>Seats <input type="number" name="seats" min="1" max={Math.max(1, optionCount - 1)} bind:value={seats} /></label>
        <label>
          Counting method
          <select name="stvMethod" bind:value={stvMethod}>
            <option value="scottish">Scottish STV</option>
            <option value="meek">Meek STV</option>
          </select>
        </label>
        <label>
          Quota
          <select name="quotaType" bind:value={quotaType}>
            <option value="droop">Droop</option>
            <option value="hare">Hare</option>
          </select>
        </label>
      {:else if selectedType === "time_poll"}
        <label>Meeting duration (minutes) <input type="number" name="meetingDurationMinutes" min="1" bind:value={meetingDurationMinutes} /></label>
      {/if}
      </div>
    </section>
  {/if}

  <section class="option-editor" data-option-editor>
    <div class="section-head">
      <h2 id="options-heading">{optionLabels[selectedType]}</h2>
      {#if !fixed}
        <Button type="button" id="add-option" onclick={addOption}>Add option</Button>
      {/if}
    </div>
    {#if fixed}
      <!-- Proposal positions are part of the outcome logic, so they read as text, not fields. -->
      <ul class="fixed-positions">
        {#each optionItems as option (option.uid)}
          <li>
            <span>{option.label}</span>
            {#if option.meaning}<span class="choice-meaning">{option.meaning}</span>{/if}
          </li>
        {/each}
      </ul>
    {:else}
    <div id="option-blocks" class="option-blocks" bind:this={optionList}>
      {#each optionItems as option, index (option.uid)}
        <article
          class={`option-block option-block-${selectedType} textured`}
          class:lifted={drag?.uid === option.uid}
          style:--option-pattern={optionPattern(option.uid)}
          style:transform={drag?.uid === option.uid ? `translateY(${dragOffset}px)` : null}
          data-index={index}
          onpointerdown={(event) => startDrag(event, option.uid)}
          onpointermove={moveDrag}
          onpointerup={endDrag}
          onpointercancel={endDrag}
        >
          <span class="drag-handle" title="Drag to reorder" aria-hidden="true">⠿</span>
          <div class="option-fields">
            {#if selectedType === "time_poll"}
              <label>
                {@render Required("Date and time")}
                <input type="datetime-local" required value={option.local || (mounted ? "" : option.label.slice(0, 16))} oninput={(event) => updateOption(index, { local: event.currentTarget.value, label: toIso(event.currentTarget.value) })} />
              </label>
              {#if mounted && option.label && !option.local}
                <p class="field-help">"{option.label}" is not a date. Pick a date and time to replace it.</p>
              {/if}
            {:else}
              <label>
                {@render Required(selectedType === "irv" || selectedType === "stv" ? "Candidate" : "Label")}
                <input value={option.label} required oninput={(event) => updateOption(index, { label: event.currentTarget.value })} />
              </label>
            {/if}
            <label>
              {selectedType === "time_poll" ? "Note" : "Meaning"}
              <input value={option.meaning} placeholder="Optional" oninput={(event) => updateOption(index, { meaning: event.currentTarget.value })} />
            </label>
          </div>
          <div class="option-actions">
            <Button type="button" disabled={index === 0} onclick={() => moveOption(index, index - 1)}>Up</Button>
            <Button type="button" disabled={index === optionItems.length - 1} onclick={() => moveOption(index, index + 1)}>Down</Button>
            <Button type="button" disabled={optionItems.length <= 1} onclick={() => removeOption(index)}>Remove</Button>
          </div>
        </article>
      {/each}
    </div>
    {/if}
    <textarea name="optionsText" id="optionsText" class="raw-options" aria-hidden="true" tabindex="-1" value={serializedOptions}></textarea>
    <p class="hint" id="options-hint">{optionsHint}</p>
  </section>

  <section>
    <h2>Who can vote</h2>
    <fieldset>
      <legend class="sr-only">Who can vote</legend>
      <div class="radio-options">
        <label><input type="radio" name="voterMode" value="open" bind:group={voterMode} /> Open link</label>
        <label><input type="radio" name="voterMode" value="invite" bind:group={voterMode} /> Invite only</label>
      </div>
      <p class="field-help">Open link: anyone with the poll link can vote under any name. Invite only: each invitee gets a personal link and can vote once as the name you list; other visitors cannot vote.</p>
    </fieldset>
    {#if voterMode === "invite"}
      <div class="field">
        <label>
          {@render Required("Invited voters")}
          <textarea name="inviteesText" id="inviteesText" rows="6" bind:value={inviteesText}></textarea>
        </label>
        <p class="field-help" id="invitees-hint">One name per line ({inviteeCount} invited so far; max 500). Duplicates are ignored, ignoring case. Personal links appear on the poll page once you save. You can add invitees after voting opens but not remove anyone.</p>
      </div>
    {/if}
  </section>

  <section>
    <h2>Timing</h2>
    <div class="field-grid">
    <div class="inline-field">
      <label for="opensAt">Opens at</label>
      <input id="opensAt" type="datetime-local" name="opensAt" bind:value={opensAt} />
      <Button type="button" onclick={setNow}>Now</Button>
    </div>
    <div class="inline-field">
      <label for="closesAt">Closes at</label>
      <input id="closesAt" type="datetime-local" name="closesAt" bind:value={closesAt} />
      <Button type="button" onclick={setEndOfDay}>End of day</Button>
    </div>
    </div>
  </section>

  <details class="form-details">
    <summary>Advanced settings</summary>
    <div class="stack">
      <div class="field">
      <label><input type="checkbox" name="anonymous" checked={values.config.anonymous} /> Anonymous voting</label>
      <p class="field-help">Hide voter names and reasons in results and exports. Display names are still stored internally so later votes can replace earlier ones.{#if voterMode === "invite"} In invite-only polls the admin's invitation list still shows which invitees have voted (not what they voted), like a sign-in sheet.{/if}</p>
      </div>

      <fieldset>
        <legend>Hide results</legend>
        <div class="radio-options">
          <label><input type="radio" name="hideResults" value="off" checked={values.config.hideResults === "off"} /> Off</label>
          <label><input type="radio" name="hideResults" value="after_vote" checked={values.config.hideResults === "after_vote"} /> Until vote is cast</label>
          <label><input type="radio" name="hideResults" value="after_close" checked={values.config.hideResults === "after_close"} /> Until poll is closed</label>
        </div>
        <p class="field-help">Controls when voters can see the current tally: immediately, only after they vote, or only after the poll closes. You, as the poll's admin, can always see it once voting opens, unless it's hidden until the poll closes.</p>
      </fieldset>

      <div class="field">
        <label><input type="checkbox" name="allowVoteChanges" checked={values.config.allowVoteChanges} /> Let voters change their vote</label>
        <p class="field-help">Off by default: once someone votes, their ballot is final. Turn this on to let voters come back and update it. You, as the poll's admin, can always update your own vote.</p>
      </div>

      <fieldset>
        <legend>Vote reason</legend>
        <div class="radio-options">
          <label><input type="radio" name="reasonMode" value="optional" checked={values.config.reasonMode === "optional"} /> Optional</label>
          <label><input type="radio" name="reasonMode" value="required" checked={values.config.reasonMode === "required"} /> Required</label>
          <label><input type="radio" name="reasonMode" value="disabled" checked={values.config.reasonMode === "disabled"} /> Disabled</label>
        </div>
        <p class="field-help">Reasons are written explanations attached to a vote. Required forces voters to write one; disabled removes the reason box.</p>
      </fieldset>

      <div class="field">
        <label>Quorum percent <input type="number" name="quorumPercent" min="0" max="100" value={values.config.quorumPercent} /></label>
        <p class="field-help">Quorum is the minimum participation threshold for treating a result as valid. For example, 50% means at least half of eligible voters must cast a vote.</p>
      </div>

      {#if voterMode === "invite"}
        <p class="field-help">Eligible voters: the number of invitees ({inviteeCount}) is used with quorum percent to calculate how many votes are needed.</p>
      {:else}
        <div class="field">
          <label>Eligible voter count <input type="number" name="eligibleVoterCount" min="0" value={values.config.eligibleVoterCount} /></label>
          <p class="field-help">The number of people allowed or expected to vote. This app uses it with quorum percent to calculate how many votes are needed.</p>
        </div>
      {/if}

      {#if !fixed}
        <div class="field">
          <label><input type="checkbox" name="shuffleOptions" checked={values.config.shuffleOptions} /> Shuffle option order for each voter</label>
          <p class="field-help">Each voter sees the ballot options in their own random order, which stays the same when they reload. Results and exports keep the order you entered.</p>
        </div>
      {/if}
    </div>
  </details>

</form>

<!-- One element (so it stays on one line inside grid labels); CSS draws the asterisk. -->
{#snippet Required(text: string)}
  <span class="required">{text}</span>
{/snippet}
