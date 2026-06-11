import { json } from "@sveltejs/kit";
import { getStore, voteInputFromRequest } from "$lib/server/app";
import { isOpen } from "$lib/shared";

export async function POST({ params, request }) {
  const poll = getStore().getPoll(Number(params.id));
  if (!poll) return json({ error: "Poll not found." }, { status: 404 });
  if (!isOpen(poll)) return json({ error: "Voting is not open." }, { status: 400 });
  const options = getStore().getOptions(poll.id);
  try {
    const vote = await voteInputFromRequest(request, poll, options);
    getStore().upsertVote(poll.id, vote.voterName, vote.ballot, vote.reason);
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
