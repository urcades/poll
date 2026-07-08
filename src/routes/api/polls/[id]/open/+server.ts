import { json } from "@sveltejs/kit";
import { openPollOrThrow } from "$lib/server/app";

export function POST({ params, cookies }) {
  try {
    openPollOrThrow(Number(params.id), cookies);
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
