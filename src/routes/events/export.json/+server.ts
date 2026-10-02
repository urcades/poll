import { error } from "@sveltejs/kit";
import { isOperator } from "$lib/server/app";
import { filterFromInput, readEvents } from "$lib/server/events";
import type { RequestHandler } from "./$types";

/** The usage log as JSON (operator only; same filters as the page, default limit 5000). */
export const GET: RequestHandler = ({ url, cookies }) => {
  if (!isOperator(cookies)) error(404, "Not found");
  const filter = filterFromInput((key) => url.searchParams.get(key));
  const events = readEvents({ ...filter, limit: filter.limit ?? 5000 });
  return new Response(JSON.stringify({ events }, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="usage-events.json"', "Cache-Control": "no-store" }
  });
};
