import { json } from "@sveltejs/kit";
import { getStore, inputFromRequest, isPollAdmin, updateDraftOrThrow } from "$lib/server/app";

export async function POST({ params, request, cookies }) {
  const poll = getStore().getPollBySlug(params.id);
  if (!poll) return json({ error: "Poll not found." }, { status: 404 });
  if (!isPollAdmin(cookies, poll.id)) return json({ error: "Only the poll admin can edit this draft." }, { status: 403 });
  if (poll.status !== "draft") return json({ error: "Only draft polls can be edited." }, { status: 400 });
  try {
    updateDraftOrThrow(poll, await inputFromRequest(request), cookies);
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
