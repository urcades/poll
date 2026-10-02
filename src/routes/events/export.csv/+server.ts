import { error } from "@sveltejs/kit";
import { csvCell, isOperator } from "$lib/server/app";
import { eventsToCsv, filterFromInput, readEvents } from "$lib/server/events";
import type { RequestHandler } from "./$types";

/** The usage log as CSV (operator only; same filters as the page, default limit 5000). */
export const GET: RequestHandler = ({ url, cookies }) => {
  if (!isOperator(cookies)) error(404, "Not found");
  const filter = filterFromInput((key) => url.searchParams.get(key));
  const events = readEvents({ ...filter, limit: filter.limit ?? 5000 });
  return new Response(eventsToCsv(events, csvCell), {
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="usage-events.csv"', "Cache-Control": "no-store" }
  });
};
