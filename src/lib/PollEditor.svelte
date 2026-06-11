<script lang="ts">
  import { Button } from "@flowercomputer/flowerparts";
  import { defaultOptionsText, templates } from "../templates";
  import type { PollConfig, PollType } from "../types";
  import { untrack } from "svelte";

  type OptionItem = { label: string; meaning: string };

  const templateGroups = [
    { label: "Proposal templates", category: "proposal" },
    { label: "Poll shapes", category: "poll" },
    { label: "Election methods", category: "election" }
  ] as const;

  const fixedProposalTypes = new Set<PollType>(["sense_check", "consent", "consensus", "majority"]);
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
    submitLabel
  }: {
    action?: string;
    selected: PollType;
    values: {
      title: string;
      details: string;
      optionsText: string;
      opensAt: string;
      closesAt: string;
      config: PollConfig;
    };
    submitLabel: string;
  } = $props();

  const initial = untrack(() => ({ selected, values }));

  let selectedType = $state.raw(initial.selected);
  let lastType = $state.raw(initial.selected);
  let optionItems = $state.raw(parseOptionsText(initial.values.optionsText));
  let draggedIndex = $state<number | null>(null);

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
  let opensAt = $state(initial.values.opensAt);
  let closesAt = $state(initial.values.closesAt);

  const activeTemplate = $derived(templatesByType[selectedType]);
  const optionCount = $derived(optionItems.filter((option) => option.label.trim()).length);
  const fixed = $derived(fixedProposalTypes.has(selectedType));
  const serializedOptions = $derived(serializeOptions(optionItems));
  const optionsHint = $derived(getOptionsHint());

  function parseOptionsText(text: string): OptionItem[] {
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const parts = line.split("|");
        return { label: (parts.shift() ?? "").trim(), meaning: parts.join("|").trim() };
      })
      .filter((option) => option.label);
  }

  function serializeOptions(options: OptionItem[]): string {
    return options
      .filter((option) => option.label.trim())
      .map((option) => option.meaning.trim() ? `${option.label.trim()} | ${option.meaning.trim()}` : option.label.trim())
      .join("\n");
  }

  function syncType() {
    if (selectedType !== lastType && (!serializedOptions.trim() || serializedOptions === defaultOptionsText(lastType))) {
      optionItems = parseOptionsText(defaultOptionsText(selectedType));
    }
    lastType = selectedType;
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
    const label = selectedType === "time_poll" ? "New timeslot" : selectedType === "irv" || selectedType === "stv" ? "New candidate" : "New option";
    optionItems = [...optionItems, { label, meaning: "" }];
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
    if (selectedType === "irv") return "One candidate per line. IRV needs at least 2 candidates.";
    if (selectedType === "stv") return `One candidate per line. Seats must be less than the ${optionCount} candidate${optionCount === 1 ? "" : "s"}.`;
    return 'One per line. Use "Name | meaning" for optional meaning text.';
  }

</script>

<form method="post" {action}>
  <label>
    Type
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

  <section id="type-help" class="type-help" aria-live="polite">
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
  </section>

  {#if selectedType === "choose" || selectedType === "score" || selectedType === "allocate" || selectedType === "rank" || selectedType === "stv" || selectedType === "time_poll"}
    <fieldset id="type-settings">
      <legend>Type settings</legend>
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
        <label>Meeting duration minutes <input type="number" name="meetingDurationMinutes" min="1" bind:value={meetingDurationMinutes} /></label>
      {/if}
    </fieldset>
  {/if}

  <label>Title <input name="title" required value={values.title} /></label>
  <label>Details <textarea name="details" rows="4">{values.details}</textarea></label>

  <section class="option-editor" data-option-editor>
    <div class="option-editor-head">
      <h2 id="options-heading">{optionLabels[selectedType]}</h2>
      {#if !fixed}
        <Button type="button" id="add-option" onclick={addOption}>Add option</Button>
      {/if}
    </div>
    <div id="option-blocks" class="option-blocks">
      {#each optionItems as option, index (`${index}-${option.label}`)}
        <article
          class={`option-block option-block-${selectedType}`}
          draggable={!fixed}
          data-index={index}
          ondragstart={(event) => {
            if (fixed) {
              event.preventDefault();
              return;
            }
            draggedIndex = index;
            event.dataTransfer?.setData("text/plain", String(index));
          }}
          ondragover={(event) => {
            if (!fixed) event.preventDefault();
          }}
          ondrop={(event) => {
            event.preventDefault();
            const from = Number(event.dataTransfer?.getData("text/plain") || draggedIndex);
            if (Number.isFinite(from)) moveOption(from, index);
            draggedIndex = null;
          }}
        >
          <Button type="button" disabled={fixed}>grab</Button>
          <div class="option-fields">
            <label>
              {selectedType === "time_poll" ? "Timeslot" : selectedType === "irv" || selectedType === "stv" ? "Candidate" : "Label"}
              <input value={option.label} required readonly={fixed} oninput={(event) => updateOption(index, { label: event.currentTarget.value })} />
            </label>
            <label>
              Meaning
              <input value={option.meaning} placeholder={fixed ? "" : "Optional"} readonly={fixed} oninput={(event) => updateOption(index, { meaning: event.currentTarget.value })} />
            </label>
          </div>
          <div class="option-actions">
            <Button type="button" disabled={fixed || index === 0} onclick={() => moveOption(index, index - 1)}>Up</Button>
            <Button type="button" disabled={fixed || index === optionItems.length - 1} onclick={() => moveOption(index, index + 1)}>Down</Button>
            <Button type="button" disabled={fixed || optionItems.length <= 1} onclick={() => removeOption(index)}>Remove</Button>
          </div>
        </article>
      {/each}
    </div>
    <textarea name="optionsText" id="optionsText" class="raw-options" aria-hidden="true" tabindex="-1" value={serializedOptions}></textarea>
  </section>
  <p class="hint" id="options-hint">{optionsHint}</p>

  <fieldset>
    <legend>Timing</legend>
    <div class="inline-field">
      <label for="opensAt">Opens at</label>
      <input id="opensAt" type="datetime-local" name="opensAt" bind:value={opensAt} />
      <Button type="button" onclick={setNow}>Now</Button>
    </div>
    <div class="inline-field">
      <label for="closesAt">Closes at</label>
      <input id="closesAt" type="datetime-local" name="closesAt" bind:value={closesAt} />
      <Button type="button" onclick={setEndOfDay}>End of Day</Button>
    </div>
  </fieldset>

  <details class="advanced-settings">
    <summary>Advanced settings</summary>
    <fieldset>
      <legend>Advanced settings, modeled only</legend>
      <label><input type="checkbox" name="anonymous" checked={values.config.anonymous} /> Anonymous voting</label>
      <p class="field-help">Hide voter names and reasons in results and exports. Display names are still stored internally so later votes can replace earlier ones.</p>

      <fieldset class="radio-group">
        <legend>Hide results</legend>
        <div class="radio-options">
          <label><input type="radio" name="hideResults" value="off" checked={values.config.hideResults === "off"} /> Off</label>
          <label><input type="radio" name="hideResults" value="after_vote" checked={values.config.hideResults === "after_vote"} /> Until vote is cast</label>
          <label><input type="radio" name="hideResults" value="after_close" checked={values.config.hideResults === "after_close"} /> Until poll is closed</label>
        </div>
      </fieldset>
      <p class="field-help">Controls when voters can see the current tally: immediately, only after they vote, or only after the poll closes.</p>

      <fieldset class="radio-group">
        <legend>Vote reason</legend>
        <div class="radio-options">
          <label><input type="radio" name="reasonMode" value="optional" checked={values.config.reasonMode === "optional"} /> Optional</label>
          <label><input type="radio" name="reasonMode" value="required" checked={values.config.reasonMode === "required"} /> Required</label>
          <label><input type="radio" name="reasonMode" value="disabled" checked={values.config.reasonMode === "disabled"} /> Disabled</label>
        </div>
      </fieldset>
      <p class="field-help">Reasons are written explanations attached to a vote. Required forces voters to write one; disabled removes the reason box.</p>

      <label>Quorum percent <input type="number" name="quorumPercent" min="0" max="100" value={values.config.quorumPercent} /></label>
      <p class="field-help">Quorum is the minimum participation threshold for treating a result as valid. For example, 50% means at least half of eligible voters must cast a vote.</p>

      <label>Eligible voter count <input type="number" name="eligibleVoterCount" min="0" value={values.config.eligibleVoterCount} /></label>
      <p class="field-help">The number of people allowed or expected to vote. This app uses it with quorum percent to calculate how many votes are needed.</p>

      <label><input type="checkbox" name="allowComments" checked={values.config.allowComments} /> Allow comments flag</label>
      <p class="field-help">Stores whether this poll should allow comments. Comment threads are not implemented in this minimal version.</p>

      <label><input type="checkbox" name="allowReactions" checked={values.config.allowReactions} /> Allow reactions flag</label>
      <p class="field-help">Stores whether this poll should allow lightweight reactions. Reaction UI is not implemented in this minimal version.</p>

      <label><input type="checkbox" name="shuffleOptions" checked={values.config.shuffleOptions} /> Shuffle options flag</label>
      <p class="field-help">Stores whether options should be randomized for voters. This minimal version keeps the displayed order stable.</p>
    </fieldset>
  </details>

  <Button type="submit" variant="primary">{submitLabel}</Button>
</form>
