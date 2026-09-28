import { json } from "@sveltejs/kit";
import { createPollWithAdmin, inputFromRequest } from "$lib/server/app";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, cookies }) => {
  try {
    const input = await inputFromRequest(request);
    return json(createPollWithAdmin(input, cookies));
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
};
