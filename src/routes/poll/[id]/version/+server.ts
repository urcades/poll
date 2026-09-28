import { json } from "@sveltejs/kit";
import { getStore } from "$lib/server/app";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = ({ params }) => {
  const version = getStore().pollVersion(params.id);
  const headers = { "Cache-Control": "no-store" };
  if (version === null) return json({ error: "Poll not found." }, { status: 404, headers });
  return json({ version }, { headers });
};
