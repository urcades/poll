import { json } from "@sveltejs/kit";
import { getStore, inputFromRequest } from "$lib/server/app";

export async function POST({ request }) {
  try {
    const input = await inputFromRequest(request);
    return json({ id: getStore().createPoll(input) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
