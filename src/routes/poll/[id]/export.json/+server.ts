import { json } from "@sveltejs/kit";
import { exportVotes, getStore } from "$lib/server/app";
import { isClosed } from "$lib/shared";
import { tallyPoll } from "../../../../tally";

export function GET({ params }) {
  const poll = getStore().getPoll(Number(params.id));
  if (!poll) return json({ error: "Poll not found." }, { status: 404 });
  if (!isClosed(poll)) return json({ error: "Exports are available only after this poll closes." }, { status: 400 });
  const options = getStore().getOptions(poll.id);
  const votes = getStore().getVotes(poll.id);
  const tally = tallyPoll(poll, options, votes);
  return new Response(JSON.stringify({
    poll,
    options,
    tally,
    votes: exportVotes(poll, votes)
  }, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="poll-${poll.id}.json"`
    }
  });
}
