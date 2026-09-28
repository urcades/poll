import { json } from "@sveltejs/kit";
import { addInviteesOrThrow, readData } from "$lib/server/app";
import type { RequestHandler } from "./$types";

/** Admin only: add invitees to an invite-only poll (draft or open). Body: `{ "inviteesText": "Ada\nBo" }`. */
export const POST: RequestHandler = async ({ params, request, cookies }) => {
  try {
    const data = await readData(request);
    const text = typeof data.inviteesText === "string" ? data.inviteesText : "";
    const { added } = addInviteesOrThrow(params.id, cookies, text);
    return json({ ok: true, added });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
};
