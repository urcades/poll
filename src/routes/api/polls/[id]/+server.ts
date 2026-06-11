import { json } from "@sveltejs/kit";
import { getStore, inputFromRequest } from "$lib/server/app";

export async function POST({ params, request }) {
  const poll = getStore().getPoll(Number(params.id));
  if (!poll) return json({ error: "Poll not found." }, { status: 404 });
  if (poll.status !== "draft") return json({ error: "Only draft polls can be edited." }, { status: 400 });
  try {
    const input = { id: poll.id, ...(await inputFromRequest(request)) };
    if (!getStore().updatePoll(input)) throw new Error("Could not update draft.");
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
