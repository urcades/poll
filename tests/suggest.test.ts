import { afterEach, describe, expect, test } from "bun:test";
import { actions as homeActions, load as homeLoad } from "../src/routes/+page.server";
import { resetStoreForTesting } from "../src/lib/server/app";
import { editorValuesFor } from "../src/lib/suggestion";
import { classifyRequest } from "../src/lib/server/ratelimit";
import {
  candidateItems,
  findNumbers,
  setAskForTesting,
  suggestPoll,
  SuggestError,
  titleFor,
  TYPESAFE_ENDPOINT,
  CLEF_MODEL_ID,
  clefBindingAsk,
  clefRestAsk,
  currentAsk,
  typesafeAsk,
  type Ask,
  type SystemOneRequest
} from "../src/lib/server/suggest";

afterEach(() => setAskForTesting(null));

/** A stand-in model: answers each closed question from a small spec. */
function fakeAsk(spec: {
  type: Record<string, number>;
  yes?: string[]; // noul questions answered 0.95 (everything else 0.02)
  numbers?: Record<string, string>; // number_<i> -> role
  count?: string;
  seen?: SystemOneRequest[];
}): Ask {
  return async (request) => {
    spec.seen?.push(request);
    const answers: Record<string, unknown> = {};
    for (const [id, question] of Object.entries(request.questions)) {
      if (question.type === "noul") {
        answers[id] = { type: "noul", noul: spec.yes?.includes(id) ? 0.95 : 0.02 };
      } else if (id === "type") {
        const [choice] = Object.entries(spec.type).sort((a, b) => b[1] - a[1])[0]!;
        answers[id] = { type: "choice", choice, confidence: spec.type[choice], probabilities: spec.type };
      } else if (id === "option_count") {
        const choice = spec.count ?? "unknown";
        answers[id] = { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } };
      } else {
        const choice = spec.numbers?.[id] ?? "other";
        answers[id] = { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } };
      }
    }
    return { answers } as never;
  };
}

describe("finding options and numbers in a description", () => {
  test("a list after a colon, with every name kept whole", () => {
    const { items, before } = candidateItems("Which two films Friday: Past Lives, The Holdovers or Anatomy of a Fall?");
    expect(items).toEqual(["Past Lives", "The Holdovers", "Anatomy of a Fall"]);
    expect(before).toBe("Which two films Friday");
  });

  test("a list ends where its sentence ends", () => {
    expect(candidateItems("Elect 2 organizers from Ada, Ben and Eli. Rank your choices.").items).toEqual(["Ada", "Ben", "Eli"]);
  });

  test("bullet and numbered lines", () => {
    expect(candidateItems("Pick a name:\n- Loom\n- Fieldwork\n* Open Door").items).toEqual(["Loom", "Fieldwork", "Open Door"]);
    expect(candidateItems("Name?\n1. Loom\n2) Fieldwork").items).toEqual(["Loom", "Fieldwork"]);
  });

  test("a list in the closing sentence, without a colon", () => {
    const { items, before } = candidateItems("Which restaurants are OK for lunch? Burma Superstar, Nopa, Souvla, Zuni");
    expect(items).toEqual(["Burma Superstar", "Nopa", "Souvla", "Zuni"]);
    expect(before).toBe("Which restaurants are OK for lunch?");
  });

  test("no list means no items", () => {
    expect(candidateItems("Should we move the offsite to the coast?").items).toEqual([]);
    expect(candidateItems("Rate our onboarding, but keep it short and sweet please").items).toEqual([]);
  });

  test("long phrases are not options, and duplicates are dropped", () => {
    expect(candidateItems("Pick: Loom, loom, Fieldwork").items).toEqual(["Loom", "Fieldwork"]);
    expect(candidateItems("Decide: whether we should maybe try something new next quarter, Loom").items).toEqual([]);
  });

  test("numbers as digits or words, with context", () => {
    const found = findNumbers("Elect two organizers; 3 mentors; 90 minutes");
    expect(found.map((n) => [n.text, n.value])).toEqual([["two", 2], ["3", 3], ["90", 90]]);
    expect(found[0]!.context).toContain("organizers");
    expect(findNumbers("7pm on the 5:30 slot").map((n) => n.value)).toEqual([5, 30]);
    expect(findNumbers("1 2 3 4 5 6 7 8")).toHaveLength(4);
  });

  test("titles come from the question, not the list or a run-on clause", () => {
    expect(titleFor("Which film: A, B", "Which film")).toBe("Which film");
    expect(titleFor("Should we go? Maybe.", "Should we go? Maybe.")).toBe("Should we go?");
    expect(titleFor("We need to decide where to eat tonight because everyone is hungry and tired, any ideas", "We need to decide where to eat tonight because everyone is hungry and tired, any ideas"))
      .toBe("We need to decide where to eat tonight because everyone is hungry and tired");
    expect(titleFor("x".repeat(300), "")).toHaveLength(200);
  });
});

describe("suggestPoll", () => {
  test("choose: options from the text, the pick limit from the number it means", async () => {
    const seen: SystemOneRequest[] = [];
    const ask = fakeAsk({ type: { choose: 0.96, approval: 0.04 }, yes: ["item_0", "item_1", "item_2"], numbers: { number_0: "max_picks" }, seen });
    const s = await suggestPoll("Which two films: Past Lives, Perfect Days, Poor Things?", ask);
    expect(s).toMatchObject({ type: "choose", title: "Which two films", optionsText: "Past Lives\nPerfect Days\nPoor Things", config: { maxChoices: 2 } });
    expect(s.notes.join(" | ")).toContain("3 options taken from your description");
    expect(s.alternatives).toEqual([]);
    // One request, closed questions only, the prompt as state.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.state).toEqual({ request: "Which two films: Past Lives, Perfect Days, Poor Things?" });
    expect(Object.keys(seen[0]!.questions)).toEqual(expect.arrayContaining(["type", "anonymous", "changes", "reason", "option_count", "number_0", "item_0"]));
  });

  test("candidate items the model rejects are dropped, and too few leaves the defaults", async () => {
    const ask = fakeAsk({ type: { choose: 1 }, yes: ["item_0"] });
    const s = await suggestPoll("Pick: Alpha, Beta, Gamma", ask);
    expect(s.optionsText).toBeNull();
  });

  test("settings the wording asks for", async () => {
    const ask = fakeAsk({ type: { majority: 0.9 }, yes: ["anonymous", "changes", "reason"] });
    const s = await suggestPoll("Should we do it? Anonymous, let people change their minds, and make them explain.", ask);
    expect(s.config).toEqual({ anonymous: true, allowVoteChanges: true, reasonMode: "required" });
    expect(s.optionsText).toBeNull();
  });

  test("numbers only apply where they fit the type", async () => {
    // STV: seats must be fewer than the candidates.
    const stv = fakeAsk({ type: { stv: 1 }, yes: ["item_0", "item_1", "item_2"], numbers: { number_0: "seats" } });
    expect((await suggestPoll("Elect 3 from Ada, Ben, Cy", stv)).config.seats).toBeUndefined();
    expect((await suggestPoll("Elect 2 from Ada, Ben, Cy", fakeAsk({ type: { stv: 1 }, yes: ["item_0", "item_1", "item_2"], numbers: { number_0: "seats" } }))).config.seats).toBe(2);

    // A pick limit above the number of options is cut down to it.
    const choose = fakeAsk({ type: { choose: 1 }, yes: ["item_0", "item_1"], numbers: { number_0: "max_picks" } });
    expect((await suggestPoll("Pick up to 9 from A, B", choose)).config.maxChoices).toBe(2);

    // The same number means nothing for a type that has no such setting.
    const approval = fakeAsk({ type: { approval: 1 }, yes: ["item_0", "item_1"], numbers: { number_0: "max_picks" } });
    expect((await suggestPoll("Pick 2 from A, B", approval)).config).toEqual({});

    expect((await suggestPoll("Split 10 points: A, B", fakeAsk({ type: { allocate: 1 }, yes: ["item_0", "item_1"], numbers: { number_0: "points" } }))).config.pointBudget).toBe(10);
    expect((await suggestPoll("Rate 0 to 10: A, B", fakeAsk({ type: { score: 1 }, yes: ["item_0", "item_1"], numbers: { number_1: "scale_max" } }))).config.scoreMax).toBe(10);
    expect((await suggestPoll("Rank your top 3: A, B, C, D", fakeAsk({ type: { rank: 1 }, yes: ["item_0", "item_1", "item_2", "item_3"], numbers: { number_0: "ranks" } }))).config.rankCount).toBe(3);
  });

  test("meeting length from minutes or hours; time slots are left to the person", async () => {
    const minutes = await suggestPoll("A 90 minute call", fakeAsk({ type: { time_poll: 1 }, numbers: { number_0: "minutes" } }));
    expect(minutes.config.meetingDurationMinutes).toBe(90);
    expect(minutes.optionsText).toBeNull();
    expect(minutes.notes.join(" ")).toContain("Pick the time slots yourself");
    const hours = await suggestPoll("A 2 hour workshop", fakeAsk({ type: { time_poll: 1 }, numbers: { number_0: "hours" } }));
    expect(hours.config.meetingDurationMinutes).toBe(120);
  });

  test("blank rows when the text only says how many", async () => {
    const stated = await suggestPoll("Where to eat? 6 places on the shortlist", fakeAsk({ type: { choose: 1 }, numbers: { number_0: "option_count" } }));
    expect(stated.optionsText).toBe("Option A\nOption B\nOption C\nOption D\nOption E\nOption F");
    const candidates = await suggestPoll("Choose a winner, five finalists", fakeAsk({ type: { irv: 1 }, count: "five" }));
    expect(candidates.optionsText?.split("\n")).toEqual(["Candidate A", "Candidate B", "Candidate C", "Candidate D", "Candidate E"]);
    const unknown = await suggestPoll("Where to eat?", fakeAsk({ type: { choose: 1 }, count: "unknown" }));
    expect(unknown.optionsText).toBeNull();
    // Proposals have fixed positions: never any rows.
    expect((await suggestPoll("Yes or no, 5 of us", fakeAsk({ type: { majority: 1 }, numbers: { number_0: "option_count" } }))).optionsText).toBeNull();
  });

  test("close calls are reported with the other likely methods", async () => {
    const s = await suggestPoll("Which restaurants are OK?", fakeAsk({ type: { choose: 0.62, approval: 0.35, rank: 0.03 } }));
    expect(s.type).toBe("choose");
    expect(s.confidence).toBeCloseTo(0.62);
    expect(s.alternatives).toEqual([{ type: "approval", label: "Approval", percent: 35 }]);
  });

  test("refuses empty, oversized, or unusable answers", async () => {
    await expect(suggestPoll("   ", fakeAsk({ type: { choose: 1 } }))).rejects.toMatchObject({ status: 400 });
    await expect(suggestPoll("x".repeat(2001), fakeAsk({ type: { choose: 1 } }))).rejects.toMatchObject({ status: 400 });
    await expect(suggestPoll("Hello", async () => ({ answers: {} }))).rejects.toBeInstanceOf(SuggestError);
    await expect(suggestPoll("Hello", fakeAsk({ type: { not_a_method: 1 } }))).rejects.toBeInstanceOf(SuggestError);
  });

  test("the suggestion lays over the editor defaults", async () => {
    const s = await suggestPoll("Elect 2 from Ada, Ben, Cy. Anonymous.", fakeAsk({ type: { stv: 1 }, yes: ["anonymous", "item_0", "item_1", "item_2"], numbers: { number_0: "seats" } }));
    const values = editorValuesFor(s);
    expect(values).toMatchObject({ title: "Elect 2", optionsText: "Ada\nBen\nCy", details: "", inviteesText: "" });
    expect(values.config).toMatchObject({ seats: 2, anonymous: true, stvMethod: "scottish", hideResults: "after_vote" });
    // No options in the text: the type's own defaults.
    expect(editorValuesFor({ ...s, optionsText: null }).optionsText).toBe("Candidate A\nCandidate B\nCandidate C\nCandidate D");
  });
});

describe("the TypeSafe client", () => {
  const request: SystemOneRequest = { model: "jev-latest", state: { request: "x" }, questions: {} };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("posts the request with the key as a bearer token", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const ask = typesafeAsk("secret-key", async (url, init) => {
      captured = { url: String(url), init: init! };
      return json({ answers: { ok: { type: "noul", noul: 1 } } });
    });
    expect(await ask(request)).toEqual({ answers: { ok: { type: "noul", noul: 1 } } });
    expect(captured!.url).toBe(TYPESAFE_ENDPOINT);
    expect((captured!.init.headers as Record<string, string>).authorization).toBe("Bearer secret-key");
    expect(JSON.parse(String(captured!.init.body))).toMatchObject({ model: "jev-latest", state: { request: "x" } });
  });

  test("friendly errors that never mention the key", async () => {
    const rejected = await typesafeAsk("secret-key", async () => json({}, 401))(request).catch((error) => error);
    expect(rejected).toBeInstanceOf(SuggestError);
    expect(rejected.message).toContain("rejected");
    expect(rejected.message).not.toContain("secret-key");

    const invalid = await typesafeAsk("k", async () => json({}, 422))(request).catch((error) => error);
    expect(invalid.message).toContain("couldn't read that");

    const offline = await typesafeAsk("k", async () => {
      throw new Error("ECONNREFUSED secret-key");
    })(request).catch((error) => error);
    expect(offline.status).toBe(503);
    expect(offline.message).not.toContain("ECONNREFUSED");
  });

  test("a busy service is retried once", async () => {
    let calls = 0;
    const ask = typesafeAsk("k", async () => (++calls === 1 ? json({}, 429) : json({ answers: {} })));
    expect(await ask(request)).toEqual({ answers: {} });
    expect(calls).toBe(2);

    let always = 0;
    const busy = await typesafeAsk("k", async () => (++always, json({}, 529)))(request).catch((error) => error);
    expect(always).toBe(2);
    expect(busy.message).toContain("busy");
  });
});

describe("the home page action", () => {
  const run = (prompt: string, headers: Record<string, string> = { "x-sveltekit-action": "true" }) =>
    homeActions.suggest({
      request: new Request("http://local.test/?/suggest", { method: "POST", headers, body: new URLSearchParams({ prompt }) })
    } as never);

  test("returns a suggestion and creates nothing", async () => {
    const db = resetStoreForTesting();
    setAskForTesting(fakeAsk({ type: { majority: 0.9 } }));
    const result = (await run("Should we book the 7pm table?")) as { suggestion: { type: string; title: string } };
    expect(result.suggestion).toMatchObject({ type: "majority", title: "Should we book the 7pm table?" });
    expect(db.listPolls()).toHaveLength(0);
  });

  test("without JavaScript it redirects to the editor on the chosen method", async () => {
    resetStoreForTesting();
    setAskForTesting(fakeAsk({ type: { irv: 1 } }));
    await expect(run("Pick a name", {})).rejects.toMatchObject({ status: 303, location: "/new?type=irv" });
  });

  test("failures come back as messages", async () => {
    resetStoreForTesting();
    setAskForTesting(fakeAsk({ type: { choose: 1 } }));
    expect(await run("   ")).toMatchObject({ status: 400, data: { error: "Describe the vote first." } });
    setAskForTesting(async () => {
      throw new SuggestError("The description service is busy. Try again in a moment.", 503);
    });
    expect(await run("anything")).toMatchObject({ status: 503, data: { error: expect.stringContaining("busy") } });
    setAskForTesting(async () => {
      throw new Error("boom with secrets");
    });
    const unexpected = (await run("anything")) as { status: number; data: { error: string } };
    expect(unexpected.status).toBe(500);
    expect(unexpected.data.error).not.toContain("secrets");
  });

  test("the page says whether describing is available", () => {
    resetStoreForTesting();
    const cookies = { get: () => undefined, getAll: () => [], set() {}, delete() {} };
    setAskForTesting(fakeAsk({ type: { choose: 1 } }));
    expect((homeLoad as Function)({ cookies }).canDescribe).toBe(true);
    const saved = process.env.TYPESAFE_API_KEY;
    delete process.env.TYPESAFE_API_KEY;
    setAskForTesting(null);
    try {
      expect((homeLoad as Function)({ cookies }).canDescribe).toBe(false);
    } finally {
      if (saved !== undefined) process.env.TYPESAFE_API_KEY = saved;
    }
  });

  test("each description counts against the creation rate limit", () => {
    expect(classifyRequest("POST", "/", "?/suggest")).toBe("create");
    expect(classifyRequest("POST", "/", "")).toBe("mutate");
  });
});

describe("Clef", () => {
  const request: SystemOneRequest = { model: "jev-latest", state: { request: "x" }, questions: {} };
  const reply = { model: "clef", answers: { a: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 3, output_tokens: 0 } };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  test("the REST client posts the request to the account's model with a bearer token and unwraps the result", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const ask = clefRestAsk("acct123", "tok-secret", async (url, init) => {
      captured = { url, init };
      return json({ success: true, result: reply });
    });
    expect(await ask(request)).toEqual(reply);
    expect(captured!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/acct123/ai/run/${CLEF_MODEL_ID}`);
    expect((captured!.init.headers as Record<string, string>).authorization).toBe("Bearer tok-secret");
    expect(JSON.parse(String(captured!.init.body))).toMatchObject({ model: "clef", state: { request: "x" } });
    expect(ask.providerName).toBe("clef");
  });

  test("REST failures are friendly and never mention the token", async () => {
    const rejected = await clefRestAsk("a", "tok-secret", async () => json({}, 401))(request).catch((error) => error);
    expect(rejected).toBeInstanceOf(SuggestError);
    expect(rejected.message).toContain("rejected");
    expect(rejected.message).not.toContain("tok-secret");
    expect((await clefRestAsk("a", "t", async () => json({}, 422))(request).catch((error) => error)).message).toContain("couldn't read that");
    expect((await clefRestAsk("a", "t", async () => { throw new Error("ECONNREFUSED tok-secret"); })(request).catch((error) => error)).message).not.toContain("ECONNREFUSED");
    let calls = 0;
    expect(await clefRestAsk("a", "t", async () => (++calls === 1 ? json({}, 429) : json({ result: reply })))(request)).toEqual(reply);
    expect(calls).toBe(2);
    expect((await clefRestAsk("a", "t", async () => json({ success: true, result: null }))(request).catch((error) => error)).message).toContain("usable answer");
  });

  test("the Workers AI binding is called with the model id and accepts bare or wrapped replies", async () => {
    const calls: Array<{ model: string; input: Record<string, unknown> }> = [];
    const ask = clefBindingAsk({ run: async (model, input) => (calls.push({ model, input: input as Record<string, unknown> }), reply) });
    expect(await ask(request)).toEqual(reply);
    expect(calls[0]).toMatchObject({ model: CLEF_MODEL_ID, input: { model: "clef", state: { request: "x" } } });
    expect(await clefBindingAsk({ run: async () => ({ result: reply }) })(request)).toEqual(reply);

    const failed = await clefBindingAsk({ run: async () => { throw Object.assign(new Error("AiError 3040: capacity"), { status: 429 }); } })(request).catch((error) => error);
    expect(failed.message).toContain("busy");
    const broken = await clefBindingAsk({ run: async () => { throw new Error("boom with details"); } })(request).catch((error) => error);
    expect(broken).toBeInstanceOf(SuggestError);
    expect(broken.message).not.toContain("details");
  });

  test("Clef is used when available, Jev otherwise, and DESCRIBE_PROVIDER forces either", () => {
    const keep = { ...process.env };
    const g = globalThis as { __pollAi?: unknown };
    const reset = () => {
      for (const key of ["DESCRIBE_PROVIDER", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN", "TYPESAFE_API_KEY"]) delete process.env[key];
      delete g.__pollAi;
    };
    try {
      reset();
      expect(currentAsk()).toBeNull();
      process.env.TYPESAFE_API_KEY = "jev-key";
      expect(currentAsk()?.providerName).toBe("jev");
      process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
      expect(currentAsk()?.providerName).toBe("jev"); // an account id alone is not enough
      process.env.CLOUDFLARE_API_TOKEN = "tok";
      expect(currentAsk()?.providerName).toBe("clef");
      process.env.DESCRIBE_PROVIDER = "jev";
      expect(currentAsk()?.providerName).toBe("jev");
      delete process.env.DESCRIBE_PROVIDER;
      reset();
      g.__pollAi = { run: async () => reply };
      expect(currentAsk()?.providerName).toBe("clef"); // the Worker's binding
      process.env.DESCRIBE_PROVIDER = "jev";
      expect(currentAsk()).toBeNull(); // forced to a provider that is not configured
      process.env.DESCRIBE_PROVIDER = "clef";
      expect(currentAsk()?.providerName).toBe("clef");
    } finally {
      reset();
      Object.assign(process.env, keep);
    }
  });
});
