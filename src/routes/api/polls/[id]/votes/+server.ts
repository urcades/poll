import { json } from "@sveltejs/kit";
import { getStore, InviteRequiredError, submitVote } from "$lib/server/app";
import { isOpen } from "$lib/shared";

export async function POST({ params, request, cookies }) {
  const poll = getStore().getPollBySlug(params.id);
  if (!poll) return json({ error: "Poll not found." }, { status: 404 });
  if (!isOpen(poll)) return json({ error: "Voting is not open." }, { status: 400 });
  const options = getStore().getOptions(poll.id);
  try {
    await submitVote(poll, options, request, cookies);
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: error instanceof InviteRequiredError ? 403 : 400 });
  }
}
