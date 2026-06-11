import { json } from "@sveltejs/kit";
import { closePollOrThrow } from "$lib/server/app";

export function POST({ params }) {
  try {
    closePollOrThrow(Number(params.id));
    return json({ ok: true });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
