import { csvCell, exportVotes, getStore } from "$lib/server/app";
import { isClosed } from "$lib/shared";

export function GET({ params }) {
  const poll = getStore().getPoll(Number(params.id));
  if (!poll) return text("Poll not found.", 404);
  if (!isClosed(poll)) return text("Exports are available only after this poll closes.", 400);
  const rows = exportVotes(poll, getStore().getVotes(poll.id));
  const header = ["poll_id", "poll_title", "poll_type", "voter_name", "ballot_json", "reason", "updated_at"];
  const csv = [
    header.join(","),
    ...rows.map((row) => [
      poll.id,
      poll.title,
      poll.type,
      row.voterName,
      JSON.stringify(row.ballot),
      row.reason,
      row.updatedAt
    ].map(csvCell).join(","))
  ].join("\n");
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="poll-${poll.id}.csv"`
    }
  });
}

function text(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}
