import { json } from "@sveltejs/kit";
import { getStore, recordVote, voteInputFromRequest } from "$lib/server/app";
import { isOpen } from "$lib/shared";

export async function POST({ params, request, cookies }) {
  const poll = getStore().getPollBySlug(params.id);
  if (!poll) return json({ error: "Poll not found." }, { status: 404 });
  if (!isOpen(poll)) return json({ error: "Voting is not open." }, { status: 400 });
  const options = getStore().getOptions(poll.id);
  try {
    const vote = await voteInputFromRequest(request, poll, options);
    recordVote(poll, vote, cookies);
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
