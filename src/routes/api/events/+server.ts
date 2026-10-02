import { json } from "@sveltejs/kit";
import { getStore } from "$lib/server/app";
import { cleanPath, logEvent, pollSlugOf } from "$lib/server/events";
import type { RequestHandler } from "./$types";

/**
 * Receives the browser tracker's batches (lib/track.ts): page views, clicks,
 * field changes (names only, never values), form submits, time on page and
 * script errors. Everything is clipped and allow-listed here; the client is
 * not trusted. The session comes from the poll_sid cookie, set in hooks.
 */

const KINDS = new Set(["page_view", "click", "field_change", "form_submit", "page_leave", "client_error"]);
const MAX_BODY = 40_000;
const MAX_EVENTS = 50;

const clip = (value: unknown, max = 120): string => (typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "");
const num = (value: unknown, max = 100_000): number | undefined => (typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(Math.round(value), 0), max) : undefined);

export const POST: RequestHandler = async ({ request }) => {
  const body = await request.text();
  if (body.length > MAX_BODY) return json({ error: "Too large." }, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return json({ error: "Invalid JSON." }, { status: 400 });
  }
  const events = Array.isArray((parsed as { events?: unknown })?.events) ? ((parsed as { events: unknown[] }).events.slice(0, MAX_EVENTS)) : [];
  let accepted = 0;
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    const kind = clip(event.kind, 30);
    if (!KINDS.has(kind)) continue;
    const path = cleanPath(event.path);
    const data: Record<string, unknown> = { path };
    for (const key of ["tag", "type", "role", "text", "id", "name", "label", "target", "action", "message"] as const) {
      const value = clip(event[key], key === "message" ? 300 : 120);
      if (value) data[key] = value;
    }
    const href = cleanPath(event.href);
    if (href) data.href = href;
    for (const key of ["ms", "viewportWidth", "viewportHeight", "scrollPercent"] as const) {
      const value = num(event[key]);
      if (value !== undefined) data[key] = value;
    }
    if (typeof event.touch === "boolean") data.touch = event.touch;
    const language = clip(event.language, 20);
    if (language) data.language = language;
    const clientTime = clip(event.t, 40);
    if (clientTime) data.clientTime = clientTime;
    const pollSlug = pollSlugOf(path);
    // Nothing from anonymous polls' pages: no clicks or sessions that could be lined up with a ballot.
    if (pollSlug && getStore().getPollBySlug(pollSlug)?.config.anonymous) continue;
    logEvent(`client_${kind}`, data, { pollSlug, source: "browser" });
    accepted += 1;
  }
  return json({ accepted });
};
