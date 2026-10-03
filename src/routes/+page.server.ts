import { fail, redirect } from "@sveltejs/kit";
import { involvedPolls } from "$lib/server/app";
import { logEvent } from "$lib/server/events";
import { currentAsk, SuggestError, suggestPoll, type Ask, type SystemOneResponse } from "$lib/server/suggest";
import { isClosed } from "$lib/shared";
import type { Actions, PageServerLoad } from "./$types";

/**
 * "My polls": only polls this browser holds a capability cookie for (admin or
 * vote token). A poll is otherwise shared purely by its link. The instance
 * operator sees everything.
 */
export const load = (({ cookies }) => {
  const items = involvedPolls(cookies).map(({ poll, role }) => ({ poll, role }));
  return {
    // Scheduled polls (only ever listed for their admin) sit with the drafts.
    drafts: items.filter(({ poll }) => poll.status === "draft" || poll.status === "scheduled"),
    active: items.filter(({ poll }) => poll.status === "open" && !isClosed(poll)),
    closed: items.filter(({ poll }) => poll.status !== "draft" && poll.status !== "scheduled" && isClosed(poll)),
    /** Whether this server can interpret a typed description (it needs a TypeSafe key). */
    canDescribe: currentAsk() !== null
  };
}) satisfies PageServerLoad;

export const actions = {
  /** Reads a description and returns a pre-filled poll; nothing is created. */
  suggest: async ({ request }) => {
    const ask = currentAsk();
    if (!ask) return fail(503, { error: "Describing a vote isn't set up on this server." });
    const data = await request.formData();
    const prompt = String(data.get("prompt") ?? "");
    // The usage log keeps the whole exchange with the model, to judge it against what people then save.
    const started = Date.now();
    let reply: SystemOneResponse | null = null;
    const traced: Ask = async (modelRequest) => (reply = await ask(modelRequest));
    let suggestion;
    try {
      suggestion = await suggestPoll(prompt, traced);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logEvent("describe_failed", { prompt, message, status: error instanceof SuggestError ? error.status : 500, latencyMs: Date.now() - started });
      if (error instanceof SuggestError) return fail(error.status, { error: error.message });
      console.error("Describing a vote failed", error);
      return fail(500, { error: "Something went wrong reading that. Try again." });
    }
    const answered = reply as SystemOneResponse | null;
    logEvent("describe", { suggestionId: suggestion.id, prompt, suggestion, provider: ask.providerName ?? "unknown", modelAnswers: answered?.answers ?? null, model: answered?.model ?? null, usage: answered?.usage ?? null, latencyMs: Date.now() - started });
    // Without JavaScript the form can't carry the whole suggestion across; open the editor on the right method.
    if (!request.headers.has("x-sveltekit-action")) redirect(303, `/new?type=${suggestion.type}`);
    return { suggestion };
  }
} satisfies Actions;
