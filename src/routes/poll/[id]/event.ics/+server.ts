import { createHash } from "node:crypto";
import { getStore, tallyFor } from "$lib/server/app";
import { buildIcs } from "$lib/ics";
import { isClosed, parseSlot } from "$lib/shared";
import type { RequestHandler } from "./$types";

/** Calendar file for a closed time poll's winning slot. Anyone who can see the results can download it. */
export const GET: RequestHandler = ({ params, url }) => {
  const poll = getStore().getPollBySlug(params.id);
  if (!poll) return text("Poll not found.", 404);
  const options = getStore().getOptions(poll.id);
  if (poll.type !== "time_poll" || !options.length || options.some((option) => !parseSlot(option.label))) {
    return text("This poll has no calendar-ready timeslots.", 404);
  }
  if (!isClosed(poll)) return text("The calendar event is available after this poll closes.", 400);
  const tally = tallyFor(poll, options, getStore().getVotes(poll.id));
  const top = tally.rows[0];
  const winner = top && (top.available ?? 0) + (top.ifNeeded ?? 0) > 0 ? top : undefined;
  const start = winner ? parseSlot(winner.label) : null;
  if (!winner || !start) return text("No timeslot won: nobody is available for any slot.", 404);
  const minutes = poll.config.meetingDurationMinutes ?? 60;
  const uid = createHash("sha256").update(`${poll.slug}:${winner.optionId}`).digest("hex").slice(0, 32);
  const body = buildIcs({
    uid: `${uid}@${url.hostname}`,
    stamp: new Date(poll.closedAt ?? Date.now()),
    start,
    end: new Date(start.getTime() + Math.max(1, minutes) * 60_000),
    summary: poll.title,
    description: poll.details
  });
  return new Response(body, {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": `attachment; filename="poll-${poll.slug}.ics"`
    }
  });
};

function text(body: string, status: number): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
