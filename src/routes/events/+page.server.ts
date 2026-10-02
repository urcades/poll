import { error, redirect } from "@sveltejs/kit";
import { getStore, grantOperatorFromUrl, isOperator } from "$lib/server/app";
import { filterFromInput } from "$lib/server/events";
import type { PageServerLoad } from "./$types";

/**
 * The usage log, for the instance operator only (anyone else gets a 404, as if
 * the page did not exist). `?admin=<OPERATOR_TOKEN>` signs the browser in, the
 * same link that grants operator access on poll pages.
 */
export const load = (({ url, cookies }) => {
  const token = url.searchParams.get("admin");
  if (token && grantOperatorFromUrl(cookies, token)) redirect(303, "/events");
  if (!isOperator(cookies)) error(404, "Not found");
  const filter = filterFromInput((key) => url.searchParams.get(key));
  const limit = filter.limit ?? 100;
  const events = getStore().listEvents({ ...filter, limit: limit + 1 });
  const page = events.slice(0, limit);
  return {
    events: page,
    next: events.length > limit ? (page[page.length - 1]?.id ?? null) : null,
    summary: getStore().eventSummary({ ...filter, before: undefined, limit: undefined }),
    query: Object.fromEntries(["kind", "kindPrefix", "poll", "session", "source", "since", "until", "text", "limit"].map((key) => [key, url.searchParams.get(key) ?? ""]))
  };
}) satisfies PageServerLoad;
