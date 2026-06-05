import { Store, type CreatePollInput } from "./db";
import { baseConfig, defaultConfigFor, defaultOptionsText, templateByType, templates } from "./templates";
import { formatNumber, tallyPoll, validateBallot } from "./tally";
import { POLL_TYPES, type Option, type Poll, type PollConfig, type PollType, type TallyResult, type Vote } from "./types";

export interface App {
  fetch(request: Request): Promise<Response> | Response;
  store: Store;
}

const templateGroups = [
  { label: "Proposal templates", category: "proposal" },
  { label: "Poll shapes", category: "poll" },
  { label: "Election methods", category: "election" }
] as const;

export function createApp(dbPath = process.env.DB_PATH ?? "work/votes.sqlite"): App {
  const store = new Store(dbPath);

  async function fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") return html(renderHome(store));
      if (request.method === "GET" && url.pathname === "/new") return html(renderNew(url));
      if (request.method === "POST" && url.pathname === "/api/polls") return await handleCreatePoll(request, store);

      const editMatch = url.pathname.match(/^\/poll\/(\d+)\/edit$/);
      if (request.method === "GET" && editMatch) return renderEditRoute(store, Number(editMatch[1]));

      const pollMatch = url.pathname.match(/^\/poll\/(\d+)$/);
      if (request.method === "GET" && pollMatch) return renderPollRoute(store, Number(pollMatch[1]), url);

      const updateMatch = url.pathname.match(/^\/api\/polls\/(\d+)$/);
      if (request.method === "POST" && updateMatch) return await handleUpdatePoll(request, store, Number(updateMatch[1]));

      const openMatch = url.pathname.match(/^\/api\/polls\/(\d+)\/open$/);
      if (request.method === "POST" && openMatch) return handleOpen(request, store, Number(openMatch[1]));

      const voteMatch = url.pathname.match(/^\/api\/polls\/(\d+)\/votes$/);
      if (request.method === "POST" && voteMatch) return await handleVote(request, store, Number(voteMatch[1]));

      const closeMatch = url.pathname.match(/^\/api\/polls\/(\d+)\/close$/);
      if (request.method === "POST" && closeMatch) return handleClose(request, store, Number(closeMatch[1]));

      const exportJsonMatch = url.pathname.match(/^\/poll\/(\d+)\/export\.json$/);
      if (request.method === "GET" && exportJsonMatch) return handleJsonExport(store, Number(exportJsonMatch[1]));

      const exportCsvMatch = url.pathname.match(/^\/poll\/(\d+)\/export\.csv$/);
      if (request.method === "GET" && exportCsvMatch) return handleCsvExport(store, Number(exportCsvMatch[1]));

      return text("Not found", 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return wantsJson(request) ? json({ error: message }, 400) : html(page("Error", `<p>${escapeHtml(message)}</p><p><a href="/">Home</a></p>`), 400);
    }
  }

  return { fetch, store };
}

function renderHome(store: Store): string {
  const polls = store.listPolls();
  const drafts = polls.filter((poll) => poll.status === "draft");
  const closed = polls.filter((poll) => poll.status !== "draft" && isClosed(poll));
  const active = polls.filter((poll) => poll.status !== "draft" && !isClosed(poll));
  return page("Votes", `
    <header class="top">
      <h1>Votes</h1>
      <a class="button" href="/new">New vote/proposal</a>
    </header>
    <section>
      <h2>Drafts</h2>
      ${renderPollList(drafts)}
    </section>
    <section>
      <h2>Active votes</h2>
      ${renderPollList(active)}
    </section>
    <section>
      <h2>Closed votes</h2>
      ${renderPollList(closed)}
    </section>
  `);
}

function renderPollList(polls: Poll[]): string {
  if (!polls.length) return "<p>No polls here yet.</p>";
  return `
    <div class="grid">
      ${polls.map((poll) => {
        const template = templateByType.get(poll.type);
        return `
          <article class="card">
            <h3><a href="/poll/${poll.id}">${escapeHtml(poll.title)}</a></h3>
            <p>${escapeHtml(template?.label ?? poll.type)} · ${statusLabel(poll)}</p>
            ${poll.details ? `<p>${escapeHtml(shorten(poll.details, 180))}</p>` : ""}
            <p>Created ${formatDate(poll.createdAt)}${poll.closesAt ? ` · Closes ${formatDate(poll.closesAt)}` : ""}</p>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function renderNew(url: URL): string {
  const selected = parseType(url.searchParams.get("type")) ?? "sense_check";
  return page("New vote/proposal", `
    <header class="top">
      <h1>New vote/proposal</h1>
      <a href="/">Home</a>
    </header>
    ${renderPollEditor({
      action: "/api/polls",
      selected,
      values: {
        title: "",
        details: "",
        optionsText: defaultOptionsText(selected),
        opensAt: "",
        closesAt: "",
        config: defaultConfigFor(selected)
      },
      submitLabel: "Save draft"
    })}
  `);
}

function renderEditRoute(store: Store, pollId: number): Response {
  const poll = store.getPoll(pollId);
  if (!poll) return text("Not found", 404);
  if (poll.status !== "draft") return html(page("Cannot edit", `<p>This poll is no longer a draft, so its setup is frozen.</p><p><a href="/poll/${poll.id}">Back to poll</a></p>`), 400);
  const options = store.getOptions(poll.id);
  return html(page(`Edit ${poll.title}`, `
    <header class="top">
      <h1>Edit draft</h1>
      <a href="/poll/${poll.id}">Back to preview</a>
    </header>
    ${renderPollEditor({
      action: `/api/polls/${poll.id}`,
      selected: poll.type,
      values: {
        title: poll.title,
        details: poll.details,
        optionsText: options.map((option) => option.meaning ? `${option.label} | ${option.meaning}` : option.label).join("\n"),
        opensAt: dateTimeLocalValue(poll.opensAt),
        closesAt: dateTimeLocalValue(poll.closesAt),
        config: poll.config
      },
      submitLabel: "Save draft changes"
    })}
  `));
}

function renderPollEditor(input: {
  action: string;
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
}): string {
  const config = input.values.config;
  return `
    <form method="post" action="${input.action}">
      <label>
        Type
        <select name="type" id="type">
          ${templateGroups.map((group) => `
            <optgroup label="${escapeHtml(group.label)}">
              ${templates.filter((template) => template.category === group.category).map((template) => `<option value="${template.type}" ${template.type === input.selected ? "selected" : ""}>${escapeHtml(template.label)}</option>`).join("")}
            </optgroup>
          `).join("")}
        </select>
      </label>
      <section id="type-help" class="type-help" aria-live="polite">
        <p id="type-description"></p>
        <p><strong>Example:</strong> <span id="type-example"></span></p>
        <p><strong>Results:</strong> <span id="type-result-shape"></span></p>
        <p><strong>Learn more:</strong> <span id="type-links"></span></p>
      </section>

      <fieldset id="type-settings">
        <legend>Type settings</legend>
        <div data-settings="choose">
          <label>Minimum choices <input type="number" name="minChoices" min="0" value="${config.minChoices ?? 1}"></label>
          <label>Maximum choices <input type="number" name="maxChoices" min="1" value="${config.maxChoices ?? 1}"></label>
        </div>
        <div data-settings="score">
          <label>Minimum score <input type="number" name="scoreMin" value="${config.scoreMin ?? 0}"></label>
          <label>Maximum score <input type="number" name="scoreMax" value="${config.scoreMax ?? 5}"></label>
        </div>
        <div data-settings="allocate">
          <label>Point budget <input type="number" name="pointBudget" min="1" value="${config.pointBudget ?? 8}"></label>
        </div>
        <div data-settings="rank">
          <label>Number of ranked choices <input type="number" name="rankCount" min="1" value="${config.rankCount ?? 3}"></label>
        </div>
        <div data-settings="stv">
          <label>Seats <input type="number" name="seats" min="1" value="${config.seats ?? 1}"></label>
          <label>Counting method
            <select name="stvMethod">
              <option value="scottish" ${config.stvMethod === "scottish" ? "selected" : ""}>Scottish STV</option>
              <option value="meek" ${config.stvMethod === "meek" ? "selected" : ""}>Meek STV</option>
            </select>
          </label>
          <label>Quota
            <select name="quotaType">
              <option value="droop" ${config.quotaType !== "hare" ? "selected" : ""}>Droop</option>
              <option value="hare" ${config.quotaType === "hare" ? "selected" : ""}>Hare</option>
            </select>
          </label>
        </div>
        <div data-settings="time_poll">
          <label>Meeting duration minutes <input type="number" name="meetingDurationMinutes" min="1" value="${config.meetingDurationMinutes ?? 60}"></label>
        </div>
      </fieldset>

      <label>Title <input name="title" required value="${escapeHtml(input.values.title)}"></label>
      <label>Details <textarea name="details" rows="4">${escapeHtml(input.values.details)}</textarea></label>
      <section class="option-editor" data-option-editor>
        <div class="option-editor-head">
          <h2 id="options-heading">Options</h2>
          <button type="button" id="add-option">Add option</button>
        </div>
        <div id="option-blocks" class="option-blocks"></div>
        <textarea name="optionsText" id="optionsText" class="raw-options" aria-hidden="true" tabindex="-1">${escapeHtml(input.values.optionsText)}</textarea>
      </section>
      <p class="hint" id="options-hint">One per line. Use "Name | meaning" for optional meaning text.</p>

      <fieldset>
        <legend>Timing</legend>
        <div class="inline-field">
          <label for="opensAt">Opens at</label>
          <input id="opensAt" type="datetime-local" name="opensAt" value="${escapeHtml(input.values.opensAt)}">
          <button type="button" data-set-time="now">Now</button>
        </div>
        <div class="inline-field">
          <label for="closesAt">Closes at</label>
          <input id="closesAt" type="datetime-local" name="closesAt" value="${escapeHtml(input.values.closesAt)}">
          <button type="button" data-set-time="end-of-day">End of Day</button>
        </div>
      </fieldset>

      <details class="advanced-settings">
        <summary>Advanced settings</summary>
        <fieldset>
          <legend>Advanced settings, modeled only</legend>
          <label><input type="checkbox" name="anonymous" ${config.anonymous ? "checked" : ""}> Anonymous voting</label>
          <p class="field-help">Hide voter names and reasons in results and exports. Display names are still stored internally so later votes can replace earlier ones.</p>

          <label>Hide results
            <select name="hideResults">
              <option value="off" ${config.hideResults === "off" ? "selected" : ""}>Off</option>
              <option value="after_vote" ${config.hideResults === "after_vote" ? "selected" : ""}>Until vote is cast</option>
              <option value="after_close" ${config.hideResults === "after_close" ? "selected" : ""}>Until poll is closed</option>
            </select>
          </label>
          <p class="field-help">Controls when voters can see the current tally: immediately, only after they vote, or only after the poll closes.</p>

          <label>Vote reason
            <select name="reasonMode">
              <option value="optional" ${config.reasonMode === "optional" ? "selected" : ""}>Optional</option>
              <option value="required" ${config.reasonMode === "required" ? "selected" : ""}>Required</option>
              <option value="disabled" ${config.reasonMode === "disabled" ? "selected" : ""}>Disabled</option>
            </select>
          </label>
          <p class="field-help">Reasons are written explanations attached to a vote. Required forces voters to write one; disabled removes the reason box.</p>

          <label>Quorum percent <input type="number" name="quorumPercent" min="0" max="100" value="${config.quorumPercent}"></label>
          <p class="field-help">Quorum is the minimum participation threshold for treating a result as valid. For example, 50% means at least half of eligible voters must cast a vote.</p>

          <label>Eligible voter count <input type="number" name="eligibleVoterCount" min="0" value="${config.eligibleVoterCount}"></label>
          <p class="field-help">The number of people allowed or expected to vote. This app uses it with quorum percent to calculate how many votes are needed.</p>

          <label><input type="checkbox" name="allowComments" ${config.allowComments ? "checked" : ""}> Allow comments flag</label>
          <p class="field-help">Stores whether this poll should allow comments. Comment threads are not implemented in this minimal version.</p>

          <label><input type="checkbox" name="allowReactions" ${config.allowReactions ? "checked" : ""}> Allow reactions flag</label>
          <p class="field-help">Stores whether this poll should allow lightweight reactions. Reaction UI is not implemented in this minimal version.</p>

          <label><input type="checkbox" name="shuffleOptions" ${config.shuffleOptions ? "checked" : ""}> Shuffle options flag</label>
          <p class="field-help">Stores whether options should be randomized for voters. This minimal version keeps the displayed order stable.</p>
        </fieldset>
      </details>

      <button type="submit">${escapeHtml(input.submitLabel)}</button>
    </form>
    <script>
      const templates = ${JSON.stringify(Object.fromEntries(templates.map((template) => [template.type, {
        description: template.description,
        example: template.example,
        resultShape: template.resultShape,
        links: template.links,
        optionsText: defaultOptionsText(template.type),
        category: template.category
      }]))).replaceAll("</", "<\\/")};
      const fixedProposalTypes = new Set(["sense_check", "consent", "consensus", "majority"]);
      const select = document.querySelector("#type");
      const description = document.querySelector("#type-description");
      const example = document.querySelector("#type-example");
      const resultShape = document.querySelector("#type-result-shape");
      const links = document.querySelector("#type-links");
      const optionsText = document.querySelector("#optionsText");
      const optionsHint = document.querySelector("#options-hint");
      const optionsHeading = document.querySelector("#options-heading");
      const optionBlocks = document.querySelector("#option-blocks");
      const addOption = document.querySelector("#add-option");
      const opensAt = document.querySelector("[name=opensAt]");
      const closesAt = document.querySelector("[name=closesAt]");
      const minChoices = document.querySelector("[name=minChoices]");
      const maxChoices = document.querySelector("[name=maxChoices]");
      const scoreMin = document.querySelector("[name=scoreMin]");
      const scoreMax = document.querySelector("[name=scoreMax]");
      const rankCount = document.querySelector("[name=rankCount]");
      const seats = document.querySelector("[name=seats]");
      let lastType = select.value;
      let optionItems = parseOptionsText(optionsText.value);
      const optionLabels = {
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
      function parseOptionsText(text) {
        return text.split(/\\r?\\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const parts = line.split("|");
            return { label: (parts.shift() || "").trim(), meaning: parts.join("|").trim() };
          })
          .filter((option) => option.label);
      }
      function serializeOptions() {
        optionsText.value = optionItems
          .filter((option) => option.label.trim())
          .map((option) => option.meaning.trim() ? option.label.trim() + " | " + option.meaning.trim() : option.label.trim())
          .join("\\n");
      }
      function optionCount() {
        serializeOptions();
        return optionItems.filter((option) => option.label.trim()).length;
      }
      function moveOption(from, to) {
        if (to < 0 || to >= optionItems.length) return;
        const item = optionItems.splice(from, 1)[0];
        optionItems.splice(to, 0, item);
        renderOptionBlocks();
        syncOptionConstraints();
      }
      function renderOptionBlocks() {
        const type = select.value;
        const fixed = fixedProposalTypes.has(type);
        optionsHeading.textContent = optionLabels[type] || "Options";
        optionBlocks.replaceChildren(...optionItems.map((option, index) => {
          const block = document.createElement("article");
          block.className = "option-block option-block-" + type;
          block.draggable = !fixed;
          block.dataset.index = String(index);

          const handle = document.createElement("button");
          handle.type = "button";
          handle.className = "option-handle";
          handle.textContent = "grab";
          handle.disabled = fixed;
          handle.title = fixed ? "Fixed position" : "Drag or use move buttons to reorder";
          block.append(handle);

          const fields = document.createElement("div");
          fields.className = "option-fields";
          const labelField = document.createElement("label");
          labelField.textContent = type === "time_poll" ? "Timeslot" : type === "irv" || type === "stv" ? "Candidate" : "Label";
          const labelInput = document.createElement("input");
          labelInput.value = option.label;
          labelInput.required = true;
          labelInput.readOnly = fixed;
          labelInput.addEventListener("input", () => {
            optionItems[index].label = labelInput.value;
            syncOptionConstraints();
          });
          labelField.append(labelInput);

          const meaningField = document.createElement("label");
          meaningField.textContent = "Meaning";
          const meaningInput = document.createElement("input");
          meaningInput.value = option.meaning;
          meaningInput.placeholder = fixed ? "" : "Optional";
          meaningInput.readOnly = fixed;
          meaningInput.addEventListener("input", () => {
            optionItems[index].meaning = meaningInput.value;
            syncOptionConstraints();
          });
          meaningField.append(meaningInput);
          fields.append(labelField, meaningField);
          block.append(fields);

          const actions = document.createElement("div");
          actions.className = "option-actions";
          const up = document.createElement("button");
          up.type = "button";
          up.textContent = "Up";
          up.disabled = fixed || index === 0;
          up.addEventListener("click", () => moveOption(index, index - 1));
          const down = document.createElement("button");
          down.type = "button";
          down.textContent = "Down";
          down.disabled = fixed || index === optionItems.length - 1;
          down.addEventListener("click", () => moveOption(index, index + 1));
          const remove = document.createElement("button");
          remove.type = "button";
          remove.textContent = "Remove";
          remove.disabled = fixed || optionItems.length <= 1;
          remove.addEventListener("click", () => {
            optionItems.splice(index, 1);
            renderOptionBlocks();
            syncOptionConstraints();
          });
          actions.append(up, down, remove);
          block.append(actions);

          block.addEventListener("dragstart", (event) => {
            if (fixed) return event.preventDefault();
            event.dataTransfer.setData("text/plain", String(index));
          });
          block.addEventListener("dragover", (event) => {
            if (!fixed) event.preventDefault();
          });
          block.addEventListener("drop", (event) => {
            event.preventDefault();
            const from = Number(event.dataTransfer.getData("text/plain"));
            if (Number.isFinite(from)) moveOption(from, index);
          });
          return block;
        }));
        addOption.hidden = fixed;
        serializeOptions();
      }
      function clampNumber(input, min, max) {
        if (!input || input.closest("[data-settings]")?.hidden) return;
        input.min = String(min);
        if (Number.isFinite(max)) input.max = String(max);
        const current = Number(input.value);
        if (Number.isFinite(current)) {
          if (current < min) input.value = String(min);
          if (Number.isFinite(max) && current > max) input.value = String(max);
        }
      }
      function localDateTimeValue(date) {
        const pad = (value) => String(value).padStart(2, "0");
        return [
          date.getFullYear(),
          pad(date.getMonth() + 1),
          pad(date.getDate())
        ].join("-") + "T" + [pad(date.getHours()), pad(date.getMinutes())].join(":");
      }
      function syncType() {
        const type = select.value;
        description.textContent = templates[type].description;
        example.textContent = templates[type].example;
        resultShape.textContent = templates[type].resultShape;
        links.replaceChildren(...templates[type].links.flatMap((link, index) => {
          const anchor = document.createElement("a");
          anchor.href = link.href;
          anchor.textContent = link.label;
          anchor.target = "_blank";
          anchor.rel = "noreferrer";
          return index === 0 ? [anchor] : [document.createTextNode(", "), anchor];
        }));
        let hasTypeSettings = false;
        document.querySelectorAll("[data-settings]").forEach((node) => {
          node.hidden = node.dataset.settings !== type;
          if (!node.hidden) hasTypeSettings = true;
        });
        document.querySelector("#type-settings").hidden = !hasTypeSettings;
        if (type !== lastType && (!optionsText.value.trim() || optionsText.value === templates[lastType].optionsText)) {
          optionItems = parseOptionsText(templates[type].optionsText);
        }
        lastType = type;
        renderOptionBlocks();
        syncOptionConstraints();
      }
      function syncOptionConstraints() {
        const type = select.value;
        const count = optionCount();
        serializeOptions();
        optionsText.setCustomValidity("");
        minChoices?.setCustomValidity("");
        maxChoices?.setCustomValidity("");
        scoreMin?.setCustomValidity("");
        scoreMax?.setCustomValidity("");
        rankCount?.setCustomValidity("");
        seats?.setCustomValidity("");

        if (fixedProposalTypes.has(type)) {
          optionsHint.textContent = "This proposal type has fixed voting positions because its outcome logic depends on them.";
        } else {
          optionsHint.textContent = "One per line. Use \\"Name | meaning\\" for optional meaning text.";
        }

        if (type === "choose") {
          clampNumber(minChoices, 0, Math.max(0, count));
          clampNumber(maxChoices, 1, Math.max(1, count));
          if (Number(minChoices.value) > Number(maxChoices.value)) minChoices.value = maxChoices.value;
        }
        if (type === "rank") {
          clampNumber(rankCount, 1, Math.max(1, count));
          optionsHint.textContent = "One per line. Ranked choices cannot exceed the " + count + " available option" + (count === 1 ? "" : "s") + ".";
        }
        if (type === "irv") {
          if (count < 2) optionsText.setCustomValidity("IRV needs at least 2 candidates.");
          optionsHint.textContent = "One candidate per line. IRV needs at least 2 candidates.";
        }
        if (type === "stv") {
          clampNumber(seats, 1, Math.max(1, count - 1));
          if (count < 2) optionsText.setCustomValidity("STV needs at least 2 candidates.");
          optionsHint.textContent = "One candidate per line. Seats must be less than the " + count + " candidate" + (count === 1 ? "" : "s") + ".";
        }
        if (type === "score" && Number(scoreMin.value) > Number(scoreMax.value)) {
          scoreMax.setCustomValidity("Maximum score must be greater than or equal to minimum score.");
        }
      }
      document.querySelector("[data-set-time=now]").addEventListener("click", () => {
        opensAt.value = localDateTimeValue(new Date());
      });
      document.querySelector("[data-set-time=end-of-day]").addEventListener("click", () => {
        const endOfDay = new Date();
        endOfDay.setHours(23, 59, 0, 0);
        closesAt.value = localDateTimeValue(endOfDay);
      });
      addOption.addEventListener("click", () => {
        const type = select.value;
        const label = type === "time_poll" ? "New timeslot" : type === "irv" || type === "stv" ? "New candidate" : "New option";
        optionItems.push({ label, meaning: "" });
        renderOptionBlocks();
        syncOptionConstraints();
      });
      document.querySelector("form").addEventListener("submit", () => serializeOptions());
      select.addEventListener("change", syncType);
      [minChoices, maxChoices, scoreMin, scoreMax, rankCount, seats].forEach((input) => input?.addEventListener("input", syncOptionConstraints));
      syncType();
    </script>
  `;
}

function renderPollRoute(store: Store, pollId: number, url: URL): Response {
  const poll = store.getPoll(pollId);
  if (!poll) return text("Not found", 404);
  const options = store.getOptions(poll.id);
  const votes = store.getVotes(poll.id);
  const viewerName = url.searchParams.get("voterName")?.trim() ?? "";
  const viewerVote = viewerName ? store.getVoteByName(poll.id, viewerName) : null;
  const showResults = canShowResults(poll, viewerVote);
  const tally = tallyPoll(poll, options, votes);
  return html(renderPoll(poll, options, votes, tally, viewerName, viewerVote, showResults));
}

function renderPoll(poll: Poll, options: Option[], votes: Vote[], tally: TallyResult, viewerName: string, viewerVote: Vote | null, showResults: boolean): string {
  const template = templateByType.get(poll.type);
  return page(poll.title, `
    <header class="top">
      <div>
        <p><a href="/">Home</a></p>
        <h1>${escapeHtml(poll.title)}</h1>
      </div>
      ${renderPollActions(poll)}
    </header>
    <p>${escapeHtml(template?.label ?? poll.type)} · ${statusLabel(poll)} · ${votes.length} vote${votes.length === 1 ? "" : "s"}</p>
    ${poll.details ? `<section><h2>Details</h2><p>${nl2br(poll.details)}</p></section>` : ""}
    ${poll.status === "draft" ? renderDraftPreview(poll, options) : `
      <section>
        <h2>Vote</h2>
        ${isOpen(poll) ? renderVoteForm(poll, options, viewerName, viewerVote) : "<p>Voting is not open.</p>"}
      </section>
      <section>
        <h2>Results</h2>
        ${showResults ? renderResults(tally, poll) : renderHiddenResultsNotice(poll, viewerName)}
      </section>
    `}
    ${isClosed(poll) ? renderExports(poll) : ""}
  `);
}

function renderPollActions(poll: Poll): string {
  if (poll.status === "draft") {
    return `
      <div class="actions">
        <a class="button" href="/poll/${poll.id}/edit">Edit draft</a>
        <form method="post" action="/api/polls/${poll.id}/open"><button type="submit">Open voting</button></form>
      </div>
    `;
  }
  if (!isClosed(poll)) return `<form method="post" action="/api/polls/${poll.id}/close"><button type="submit">Close poll</button></form>`;
  return "";
}

function renderDraftPreview(poll: Poll, options: Option[]): string {
  return `
    <section>
      <h2>Draft preview</h2>
      <p class="hint">This is the voter-facing ballot preview. Voting is disabled until you open voting.</p>
      ${renderVoteForm(poll, options, "", null).replace("<form", "<form inert aria-disabled=\"true\"")}
    </section>
    <section>
      <h2>Results</h2>
      <p>Results will appear after voting opens and votes are submitted.</p>
    </section>
  `;
}

function renderVoteForm(poll: Poll, options: Option[], viewerName: string, viewerVote: Vote | null): string {
  return `
    <form method="post" action="/api/polls/${poll.id}/votes">
      <label>Your display name <input name="voterName" required value="${escapeHtml(viewerName)}"></label>
      ${renderBallotFields(poll, options, viewerVote)}
      ${renderReasonField(poll, viewerVote?.reason ?? "")}
      <button type="submit">${viewerVote ? "Update vote" : "Submit vote"}</button>
    </form>
  `;
}

function renderBallotFields(poll: Poll, options: Option[], viewerVote: Vote | null): string {
  const ballot = viewerVote?.ballot && typeof viewerVote.ballot === "object" ? viewerVote.ballot as Record<string, unknown> : {};
  if (["sense_check", "consent", "consensus", "majority"].includes(poll.type)) {
    const selected = Number(ballot.optionId ?? 0);
    return `<fieldset><legend>Position</legend>${options.map((option) => `
      <label><input type="radio" name="optionId" value="${option.id}" ${selected === option.id ? "checked" : ""} required> ${escapeHtml(option.label)}${option.meaning ? ` - ${escapeHtml(option.meaning)}` : ""}</label>
    `).join("")}</fieldset>`;
  }

  if (poll.type === "choose" || poll.type === "approval") {
    const selected = new Set(Array.isArray(ballot.selected) ? ballot.selected.map(Number) : []);
    const legend = poll.type === "approval" ? "Approve any options" : `Choose ${poll.config.minChoices ?? 1}-${poll.config.maxChoices ?? 1}`;
    return `<fieldset><legend>${legend}</legend>${options.map((option) => `
      <label><input type="checkbox" name="selected" value="${option.id}" ${selected.has(option.id) ? "checked" : ""}> ${escapeHtml(option.label)}${option.meaning ? ` - ${escapeHtml(option.meaning)}` : ""}</label>
    `).join("")}</fieldset>`;
  }

  if (poll.type === "score") {
    const scores = ballot.scores && typeof ballot.scores === "object" ? ballot.scores as Record<string, unknown> : {};
    const min = poll.config.scoreMin ?? 0;
    const max = poll.config.scoreMax ?? 5;
    return `<fieldset><legend>Score every option (${min}-${max})</legend>${options.map((option) => `
      <label>${escapeHtml(option.label)} <input type="number" name="score_${option.id}" min="${min}" max="${max}" value="${escapeHtml(String(scores[String(option.id)] ?? min))}" required></label>
    `).join("")}</fieldset>`;
  }

  if (poll.type === "allocate") {
    const allocations = ballot.allocations && typeof ballot.allocations === "object" ? ballot.allocations as Record<string, unknown> : {};
    return `<fieldset><legend>Allocate up to ${poll.config.pointBudget ?? 8} points</legend>${options.map((option) => `
      <label>${escapeHtml(option.label)} <input type="number" name="allocation_${option.id}" min="0" step="1" value="${escapeHtml(String(allocations[String(option.id)] ?? 0))}"></label>
    `).join("")}</fieldset>`;
  }

  if (poll.type === "rank" || poll.type === "irv" || poll.type === "stv") {
    const rankings = Array.isArray(ballot.rankings) ? ballot.rankings.map(Number) : [];
    const max = poll.type === "rank" ? (poll.config.rankCount ?? options.length) : options.length;
    return `<fieldset><legend>Rank options</legend>
      <p class="hint">Put each option in at most one rank. Rank 1 is most preferred.</p>
      ${Array.from({ length: max }, (_, index) => `
        <label>Rank ${index + 1}
          <select name="rank_${index + 1}">
            <option value="">No selection</option>
            ${options.map((option) => `<option value="${option.id}" ${rankings[index] === option.id ? "selected" : ""}>${escapeHtml(option.label)}</option>`).join("")}
          </select>
        </label>
      `).join("")}
    </fieldset>`;
  }

  if (poll.type === "time_poll") {
    const availability = ballot.availability && typeof ballot.availability === "object" ? ballot.availability as Record<string, unknown> : {};
    return `<fieldset><legend>Availability</legend>${options.map((option) => {
      const current = String(availability[String(option.id)] ?? "unavailable");
      return `<div class="row"><strong>${escapeHtml(option.label)}</strong>
        ${["available", "if_needed", "unavailable"].map((state) => `
          <label><input type="radio" name="availability_${option.id}" value="${state}" ${current === state ? "checked" : ""} required> ${state.replace("_", " ")}</label>
        `).join("")}
      </div>`;
    }).join("")}</fieldset>`;
  }

  return "";
}

function renderReasonField(poll: Poll, value: string): string {
  if (poll.config.reasonMode === "disabled") return "";
  return `
    <label>
      Reason ${poll.config.reasonMode === "required" ? "(required)" : "(optional)"}
      <textarea name="reason" rows="3" ${poll.config.reasonMode === "required" ? "required" : ""}>${escapeHtml(value)}</textarea>
    </label>
  `;
}

function renderResults(tally: TallyResult, poll: Poll): string {
  return `
    <p><strong>${escapeHtml(tally.outcome)}</strong></p>
    <p>${escapeHtml(tally.quorumText)}${tally.quorumMet === null ? "" : tally.quorumMet ? " · quorum met" : " · quorum not met"}</p>
    ${tally.quota ? `<p>Quota: ${formatNumber(tally.quota)}</p>` : ""}
    <table>
      <thead><tr>${resultHeaders(tally)}</tr></thead>
      <tbody>${tally.rows.map((row) => `<tr>${resultCells(tally, row)}</tr>`).join("")}</tbody>
    </table>
    ${tally.roundLogs?.length ? renderRoundLogs(tally.roundLogs) : ""}
    ${!poll.config.anonymous && tally.voteDetails?.length ? renderVoteDetails(tally, poll) : ""}
  `;
}

function resultHeaders(tally: TallyResult): string {
  if (tally.type === "score") return "<th>Rank</th><th>Option</th><th>Total</th><th>Mean</th><th>Voters</th>";
  if (tally.type === "allocate" || tally.type === "rank") return "<th>Rank</th><th>Option</th><th>Points</th><th>% points</th><th>Mean</th>";
  if (tally.type === "time_poll") return "<th>Rank</th><th>Timeslot</th><th>Available</th><th>If needed</th><th>Unavailable</th>";
  if (tally.type === "irv") return "<th>Status</th><th>Candidate</th><th>First prefs</th><th>Final tally</th><th>Elected round</th>";
  if (tally.type === "stv") return "<th>Status</th><th>Candidate</th><th>First prefs</th><th>Final tally</th><th>Elected round</th><th>Surplus</th>";
  return "<th>Option</th><th>Votes</th><th>%</th>";
}

function resultCells(tally: TallyResult, row: TallyResult["rows"][number]): string {
  if (tally.type === "score") return `<td>${row.rank ?? ""}</td><td>${escapeHtml(row.label)}</td><td>${formatNumber(row.points ?? 0)}</td><td>${formatNumber(row.mean ?? 0)}</td><td>${row.count ?? 0}</td>`;
  if (tally.type === "allocate" || tally.type === "rank") return `<td>${row.rank ?? ""}</td><td>${escapeHtml(row.label)}</td><td>${formatNumber(row.points ?? 0)}</td><td>${formatNumber(row.percent ?? 0)}%</td><td>${formatNumber(row.mean ?? 0)}</td>`;
  if (tally.type === "time_poll") return `<td>${row.rank ?? ""}</td><td>${escapeHtml(row.label)}</td><td>${row.available ?? 0}</td><td>${row.ifNeeded ?? 0}</td><td>${row.unavailable ?? 0}</td>`;
  if (tally.type === "irv") return `<td>${escapeHtml(row.status ?? "")}</td><td>${escapeHtml(row.label)}</td><td>${formatNumber(row.firstPreferences ?? 0)}</td><td>${formatNumber(row.finalTally ?? 0)}</td><td>${row.electedRound ?? ""}</td>`;
  if (tally.type === "stv") return `<td>${escapeHtml(row.status ?? "")}</td><td>${escapeHtml(row.label)}</td><td>${formatNumber(row.firstPreferences ?? 0)}</td><td>${formatNumber(row.finalTally ?? 0)}</td><td>${row.electedRound ?? ""}</td><td>${formatNumber(row.surplus ?? 0)}</td>`;
  return `<td>${escapeHtml(row.label)}</td><td>${row.count ?? 0}</td><td>${formatNumber(row.percent ?? 0)}%</td>`;
}

function renderRoundLogs(logs: TallyResult["roundLogs"]): string {
  if (!logs?.length) return "";
  return `
    <details>
      <summary>Round log</summary>
      <table>
        <thead><tr><th>Round</th><th>Action</th><th>Tallies</th><th>Note</th></tr></thead>
        <tbody>${logs.map((log) => `<tr><td>${log.round}</td><td>${escapeHtml(log.action)}</td><td>${escapeHtml(JSON.stringify(formatTallies(log.tallies)))}</td><td>${escapeHtml(log.note ?? "")}</td></tr>`).join("")}</tbody>
      </table>
    </details>
  `;
}

function renderVoteDetails(tally: TallyResult, poll: Poll): string {
  if (poll.config.reasonMode === "disabled") return "";
  return `
    <details>
      <summary>Vote reasons</summary>
      <ul>${tally.voteDetails?.map((detail) => `<li><strong>${escapeHtml(detail.voterName)}</strong>${detail.reason ? `: ${escapeHtml(detail.reason)}` : ""}</li>`).join("")}</ul>
    </details>
  `;
}

function renderHiddenResultsNotice(poll: Poll, viewerName: string): string {
  if (poll.config.hideResults === "after_vote") {
    return `
      <p>Results are hidden until you vote.</p>
      <form method="get" action="/poll/${poll.id}">
        <label>Already voted? Enter your display name <input name="voterName" value="${escapeHtml(viewerName)}"></label>
        <button type="submit">Reveal if voted</button>
      </form>
    `;
  }
  return "<p>Results are hidden until this poll closes.</p>";
}

function renderExports(poll: Poll): string {
  return `
    <section>
      <h2>Export</h2>
      <p><a href="/poll/${poll.id}/export.json">Export JSON</a> · <a href="/poll/${poll.id}/export.csv">Export CSV</a></p>
    </section>
  `;
}

async function handleCreatePoll(request: Request, store: Store): Promise<Response> {
  const input = await inputFromRequest(request);
  const pollId = store.createPoll(input);
  return wantsJson(request) ? json({ id: pollId }) : redirect(`/poll/${pollId}`);
}

async function handleUpdatePoll(request: Request, store: Store, pollId: number): Promise<Response> {
  const poll = store.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  if (poll.status !== "draft") throw new Error("Only draft polls can be edited.");
  const input = { id: poll.id, ...(await inputFromRequest(request)) };
  if (!store.updatePoll(input)) throw new Error("Could not update draft.");
  return wantsJson(request) ? json({ ok: true }) : redirect(`/poll/${poll.id}`);
}

async function inputFromRequest(request: Request): Promise<CreatePollInput> {
  const data = await readData(request);
  const type = parseType(data.type);
  if (!type) throw new Error("Invalid poll type.");
  const title = stringField(data.title).trim();
  if (!title) throw new Error("Title is required.");
  const options = parseOptions(stringField(data.optionsText));
  const config = parseConfig(type, data);
  validatePollSetup(type, config, options);
  return {
    type,
    title,
    details: stringField(data.details),
    config,
    opensAt: dateField(data.opensAt),
    closesAt: dateField(data.closesAt),
    options
  };
}

function validatePollSetup(type: PollType, config: PollConfig, options: Array<{ label: string; meaning: string }>) {
  if (options.length < 1) throw new Error("At least one option is required.");

  if (["sense_check", "consent", "consensus", "majority"].includes(type)) {
    const expected = templateByType.get(type)?.defaultOptions.map((option) => option.label) ?? [];
    const actual = options.map((option) => option.label);
    if (expected.length !== actual.length || expected.some((label, index) => label !== actual[index])) {
      throw new Error(`${templateByType.get(type)?.label ?? type} uses fixed voting positions: ${expected.join(", ")}.`);
    }
  }

  if (type === "choose") {
    const min = config.minChoices ?? 1;
    const max = config.maxChoices ?? 1;
    if (min < 0) throw new Error("Minimum choices cannot be negative.");
    if (max < 1) throw new Error("Maximum choices must be at least 1.");
    if (min > max) throw new Error("Minimum choices cannot exceed maximum choices.");
    if (max > options.length) throw new Error("Maximum choices cannot exceed the number of options.");
  }

  if (type === "score" && (config.scoreMin ?? 0) > (config.scoreMax ?? 5)) {
    throw new Error("Maximum score must be greater than or equal to minimum score.");
  }

  if (type === "allocate" && (config.pointBudget ?? 8) < 1) {
    throw new Error("Point budget must be at least 1.");
  }

  if (type === "rank") {
    const rankCount = config.rankCount ?? options.length;
    if (rankCount < 1) throw new Error("Number of ranked choices must be at least 1.");
    if (rankCount > options.length) throw new Error("Number of ranked choices cannot exceed the number of options.");
  }

  if (type === "irv" && options.length < 2) {
    throw new Error("IRV needs at least 2 candidates.");
  }

  if (type === "stv") {
    const seats = config.seats ?? 1;
    if (options.length < 2) throw new Error("STV needs at least 2 candidates.");
    if (seats < 1) throw new Error("STV seats must be at least 1.");
    if (seats >= options.length) throw new Error("STV seats must be less than the number of candidates.");
  }

  if (type === "time_poll" && (config.meetingDurationMinutes ?? 60) < 1) {
    throw new Error("Meeting duration must be at least 1 minute.");
  }
}

function handleOpen(request: Request, store: Store, pollId: number): Response {
  const poll = store.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  if (!store.openPoll(poll.id)) throw new Error("Only draft polls can be opened.");
  return wantsJson(request) ? json({ ok: true }) : redirect(`/poll/${poll.id}`);
}

async function handleVote(request: Request, store: Store, pollId: number): Promise<Response> {
  const poll = store.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  if (!isOpen(poll)) throw new Error("Voting is not open.");
  const options = store.getOptions(poll.id);
  const data = await readData(request);
  const voterName = stringField(data.voterName).trim();
  if (!voterName) throw new Error("Display name is required.");
  const reason = poll.config.reasonMode === "disabled" ? "" : stringField(data.reason).trim();
  if (poll.config.reasonMode === "required" && !reason) throw new Error("A reason is required.");
  const ballot = parseBallot(poll, options, data);
  const ballotError = validateBallot(poll, options, ballot);
  if (ballotError) throw new Error(ballotError);
  store.upsertVote(poll.id, voterName, ballot, reason);
  return wantsJson(request) ? json({ ok: true }) : redirect(`/poll/${poll.id}?voterName=${encodeURIComponent(voterName)}`);
}

function handleClose(request: Request, store: Store, pollId: number): Response {
  const poll = store.getPoll(pollId);
  if (!poll) throw new Error("Poll not found.");
  if (poll.status === "draft") throw new Error("Open the draft before closing it.");
  store.closePoll(poll.id);
  return wantsJson(request) ? json({ ok: true }) : redirect(`/poll/${poll.id}`);
}

function handleJsonExport(store: Store, pollId: number): Response {
  const poll = store.getPoll(pollId);
  if (!poll) return json({ error: "Poll not found." }, 404);
  if (!isClosed(poll)) return json({ error: "Exports are available only after this poll closes." }, 400);
  const options = store.getOptions(poll.id);
  const votes = store.getVotes(poll.id);
  const tally = tallyPoll(poll, options, votes);
  return new Response(JSON.stringify({
    poll,
    options,
    tally,
    votes: exportVotes(poll, votes)
  }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="poll-${poll.id}.json"`
    }
  });
}

function handleCsvExport(store: Store, pollId: number): Response {
  const poll = store.getPoll(pollId);
  if (!poll) return text("Poll not found.", 404);
  if (!isClosed(poll)) return text("Exports are available only after this poll closes.", 400);
  const rows = exportVotes(poll, store.getVotes(poll.id));
  const header = ["poll_id", "poll_title", "poll_type", "voter_name", "ballot_json", "reason", "updated_at"];
  const csv = [
    header.join(","),
    ...rows.map((row) => [
      poll.id,
      poll.title,
      poll.type,
      row.voterName,
      JSON.stringify(row.ballot),
      row.reason,
      row.updatedAt
    ].map(csvCell).join(","))
  ].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="poll-${poll.id}.csv"`
    }
  });
}

function exportVotes(poll: Poll, votes: Vote[]): Array<{ voterName: string; ballot: unknown; reason: string; updatedAt: string }> {
  return votes.map((vote, index) => ({
    voterName: poll.config.anonymous ? `Voter ${index + 1}` : vote.voterName,
    ballot: vote.ballot,
    reason: poll.config.anonymous ? "" : vote.reason,
    updatedAt: vote.updatedAt
  }));
}

function parseConfig(type: PollType, data: Record<string, unknown>): PollConfig {
  const config = { ...defaultConfigFor(type) };
  config.anonymous = boolField(data.anonymous);
  config.hideResults = ["off", "after_vote", "after_close"].includes(stringField(data.hideResults)) ? stringField(data.hideResults) as PollConfig["hideResults"] : baseConfig.hideResults;
  config.reasonMode = ["optional", "required", "disabled"].includes(stringField(data.reasonMode)) ? stringField(data.reasonMode) as PollConfig["reasonMode"] : baseConfig.reasonMode;
  config.quorumPercent = numberField(data.quorumPercent, 0);
  config.eligibleVoterCount = numberField(data.eligibleVoterCount, 0);
  config.allowComments = boolField(data.allowComments);
  config.allowReactions = boolField(data.allowReactions);
  config.shuffleOptions = boolField(data.shuffleOptions);
  if (type === "choose") {
    config.minChoices = numberField(data.minChoices, 1);
    config.maxChoices = numberField(data.maxChoices, 1);
  }
  if (type === "score") {
    config.scoreMin = numberField(data.scoreMin, 0);
    config.scoreMax = numberField(data.scoreMax, 5);
  }
  if (type === "allocate") config.pointBudget = numberField(data.pointBudget, 8);
  if (type === "rank") config.rankCount = numberField(data.rankCount, 3);
  if (type === "stv") {
    config.seats = numberField(data.seats, 1);
    config.stvMethod = stringField(data.stvMethod) === "meek" ? "meek" : "scottish";
    config.quotaType = stringField(data.quotaType) === "hare" ? "hare" : "droop";
  }
  if (type === "time_poll") config.meetingDurationMinutes = numberField(data.meetingDurationMinutes, 60);
  return config;
}

function parseBallot(poll: Poll, options: Option[], data: Record<string, unknown>): unknown {
  if (["sense_check", "consent", "consensus", "majority"].includes(poll.type)) return { optionId: numberField(data.optionId, 0) };
  if (poll.type === "choose" || poll.type === "approval") return { selected: arrayField(data.selected).map(Number) };
  if (poll.type === "score") return { scores: Object.fromEntries(options.map((option) => [option.id, numberField(data[`score_${option.id}`], poll.config.scoreMin ?? 0)])) };
  if (poll.type === "allocate") return { allocations: Object.fromEntries(options.map((option) => [option.id, numberField(data[`allocation_${option.id}`], 0)])) };
  if (poll.type === "rank" || poll.type === "irv" || poll.type === "stv") {
    const limit = poll.type === "rank" ? (poll.config.rankCount ?? options.length) : options.length;
    const rankings = Array.from({ length: limit }, (_, index) => numberField(data[`rank_${index + 1}`], 0)).filter((id) => id > 0);
    return { rankings };
  }
  if (poll.type === "time_poll") return { availability: Object.fromEntries(options.map((option) => [option.id, stringField(data[`availability_${option.id}`])])) };
  return {};
}

function parseOptions(text: string): Array<{ label: string; meaning: string }> {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [label, ...meaning] = line.split("|");
      return { label: (label ?? "").trim(), meaning: meaning.join("|").trim() };
    })
    .filter((option) => option.label);
}

async function readData(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) return await request.json() as Record<string, unknown>;
  const form = await request.formData();
  const data: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (Object.hasOwn(data, key)) {
      const existing = data[key];
      data[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      data[key] = value;
    }
  }
  return data;
}

function canShowResults(poll: Poll, viewerVote: Vote | null): boolean {
  if (poll.status === "draft") return false;
  if (isClosed(poll)) return true;
  if (poll.config.hideResults === "off") return true;
  if (poll.config.hideResults === "after_vote") return Boolean(viewerVote);
  return false;
}

function isOpen(poll: Poll): boolean {
  const now = new Date();
  if (poll.status !== "open") return false;
  if (isClosed(poll)) return false;
  if (poll.opensAt && new Date(poll.opensAt) > now) return false;
  return true;
}

function isClosed(poll: Poll): boolean {
  const now = new Date();
  return poll.status === "closed" || Boolean(poll.manuallyClosedAt) || Boolean(poll.closesAt && new Date(poll.closesAt) <= now);
}

function statusLabel(poll: Poll): string {
  if (poll.status === "draft") return "Draft";
  return isClosed(poll) ? "Closed" : "Active";
}

function parseType(value: unknown): PollType | null {
  return POLL_TYPES.includes(value as PollType) ? value as PollType : null;
}

function stringField(value: unknown): string {
  if (Array.isArray(value)) return stringField(value[0]);
  return typeof value === "string" ? value : "";
}

function numberField(value: unknown, fallback: number): number {
  const n = Number(stringField(value) || value);
  return Number.isFinite(n) ? n : fallback;
}

function boolField(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return value === true || value === "true" || value === "on" || value === "1";
}

function arrayField(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [value];
}

function dateField(value: unknown): string | null {
  const raw = stringField(value);
  return raw ? new Date(raw).toISOString() : null;
}

function dateTimeLocalValue(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatTallies(tallies: Record<number, number>): Record<string, string> {
  return Object.fromEntries(Object.entries(tallies).map(([key, value]) => [key, formatNumber(value)]));
}

function csvCell(value: unknown): string {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8" } });
}

function redirect(location: string): Response {
  return new Response(null, { status: 303, headers: { Location: location } });
}

function wantsJson(request: Request): boolean {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

function page(title: string, body: string): string {
  return `<!doctype html>
  <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${escapeHtml(title)}</title>
      <style>
        *,
        *::before,
        *::after { box-sizing: border-box; }

        * { margin: 0; }

        html {
          -webkit-text-size-adjust: 100%;
          text-size-adjust: 100%;
        }

        body {
          min-height: 100vh;
          font-family: system-ui, sans-serif;
          line-height: 1.45;
          color: #111;
          background: #fff;
        }

        img,
        picture,
        video,
        canvas,
        svg { display: block; max-width: 100%; }

        input,
        select,
        textarea,
        button {
          font: inherit;
          color: inherit;
        }

        textarea { resize: vertical; }

        button,
        select,
        summary { cursor: pointer; }

        button:disabled,
        input:disabled,
        select:disabled,
        textarea:disabled { cursor: not-allowed; }

        table {
          border-collapse: collapse;
          border-spacing: 0;
        }

        fieldset {
          min-inline-size: 0;
          border: 0;
          padding: 0;
        }

        legend { padding: 0 4px; }

        a {
          color: #00e;
          text-decoration-thickness: 0.08em;
          text-underline-offset: 0.14em;
        }

        ul,
        ol { padding-left: 1.5rem; }

        :focus-visible {
          outline: 2px solid #1a73e8;
          outline-offset: 2px;
        }

        body { max-width: 980px; margin-inline: auto; padding: 24px; }
        h1, h2, h3 { line-height: 1.2; }
        h1 { margin-bottom: 32px; }
        h2 { margin-bottom: 12px; }
        h3 { margin-bottom: 8px; }
        p + p { margin-top: 8px; }
        .top { display: flex; justify-content: space-between; align-items: start; gap: 16px; }
        .actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
        .actions form { margin: 0; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
        .card, fieldset { border: 1px solid #bbb; padding: 12px; border-radius: 4px; }
        .card > * + * { margin-top: 8px; }
        form > * + * { margin-top: 16px; }
        fieldset > * + * { margin-top: 10px; }
        .type-help { margin: 16px 0; }
        .type-help > * + * { margin-top: 8px; }
        .option-editor { margin: 16px 0 8px; }
        .option-editor-head { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 8px; }
        .option-editor-head h2 { font-size: 1rem; font-weight: 400; margin: 0; }
        .option-blocks { display: grid; gap: 8px; }
        .option-block { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; border: 1px solid #999; border-left-width: 8px; padding: 10px; border-radius: 4px; background: #f8f8f8; }
        .option-block-proposal, .option-block-sense_check, .option-block-consent, .option-block-consensus, .option-block-majority { background: #f2f2f2; }
        .option-block-consent, .option-block-majority { border-left-color: #555; }
        .option-block-consensus { border-left-color: #777; }
        .option-block-sense_check { border-left-color: #999; }
        .option-block-choose, .option-block-approval { border-left-color: #2878bd; }
        .option-block-score, .option-block-allocate { border-left-color: #b7791f; }
        .option-block-rank, .option-block-irv, .option-block-stv { border-left-color: #6b5fb5; }
        .option-block-time_poll { border-left-color: #3b7f58; }
        .option-handle { min-width: 56px; }
        .option-fields { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(220px, 2fr); gap: 8px; }
        .option-actions { display: flex; gap: 6px; flex-wrap: wrap; justify-content: end; }
        .raw-options { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
        .advanced-settings { margin: 16px 0; }
        .advanced-settings summary { cursor: pointer; }
        .field-help { color: #555; font-size: 0.95rem; margin-top: 4px; max-width: 680px; }
        label { display: block; }
        label > input:not([type="checkbox"]):not([type="radio"]), label > select, label > textarea { display: block; margin-top: 4px; }
        .inline-field { display: grid; grid-template-columns: 120px minmax(220px, 1fr) auto; gap: 8px; align-items: center; margin: 10px 0; }
        .inline-field label { margin: 0; }
        input:not([type="checkbox"]):not([type="radio"]), select, textarea { width: 100%; max-width: none; }
        table { border-collapse: collapse; width: 100%; margin: 12px 0; }
        th, td { border: 1px solid #bbb; padding: 6px; text-align: left; vertical-align: top; }
        section { margin: 24px 0; }
        .row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
        .hint { color: #555; font-size: 0.95rem; }
        .button { display: inline-block; }
        @media (max-width: 640px) { .inline-field, .option-block, .option-fields { grid-template-columns: 1fr; } .top { display: block; } .option-actions { justify-content: start; } }
      </style>
    </head>
    <body>${body}</body>
  </html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function nl2br(value: string): string {
  return escapeHtml(value).replaceAll("\n", "<br>");
}

function shorten(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}...`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString();
}
