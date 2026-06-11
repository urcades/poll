import { error, fail, redirect } from "@sveltejs/kit";
import { canShowResults, closePollOrThrow, getStore, openPollOrThrow, voteInputFromRequest } from "$lib/server/app";
import { isOpen } from "$lib/shared";
import { tallyPoll } from "../../../tally";

export function load({ params, url }) {
  const poll = getStore().getPoll(Number(params.id));
  if (!poll) error(404, "Poll not found.");
  const options = getStore().getOptions(poll.id);
  const votes = getStore().getVotes(poll.id);
  const viewerName = url.searchParams.get("voterName")?.trim() ?? "";
  const viewerVote = viewerName ? getStore().getVoteByName(poll.id, viewerName) : null;
  const tally = tallyPoll(poll, options, votes);
  return {
    poll,
    options,
    votes,
    viewerName,
    viewerVote,
    tally,
    showResults: canShowResults(poll, viewerVote)
  };
}

export const actions = {
  open: async ({ params }) => {
    let pollId: number;
    try {
      const poll = openPollOrThrow(Number(params.id));
      pollId = poll.id;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${pollId}`);
  },
  close: async ({ params }) => {
    let pollId: number;
    try {
      const poll = closePollOrThrow(Number(params.id));
      pollId = poll.id;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${pollId}`);
  },
  vote: async ({ params, request }) => {
    const poll = getStore().getPoll(Number(params.id));
    if (!poll) return fail(404, { error: "Poll not found." });
    if (!isOpen(poll)) return fail(400, { error: "Voting is not open." });
    const options = getStore().getOptions(poll.id);
    let voterName: string;
    try {
      const vote = await voteInputFromRequest(request, poll, options);
      getStore().upsertVote(poll.id, vote.voterName, vote.ballot, vote.reason);
      voterName = vote.voterName;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${poll.id}?voterName=${encodeURIComponent(voterName)}`);
  }
};
