import { json } from "@sveltejs/kit";
import { closePollOrThrow } from "$lib/server/app";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ params, cookies }) => {
  try {
    closePollOrThrow(params.id, cookies);
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
};
