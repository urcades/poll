import { json } from "@sveltejs/kit";
import { duplicatePollOrThrow } from "$lib/server/app";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = ({ params, cookies }) => {
  try {
    return json(duplicatePollOrThrow(params.id, cookies));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
};
