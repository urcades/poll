import { json } from "@sveltejs/kit";
import { openPollOrThrow } from "$lib/server/app";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ params, cookies }) => {
  try {
    openPollOrThrow(params.id, cookies);
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
};
