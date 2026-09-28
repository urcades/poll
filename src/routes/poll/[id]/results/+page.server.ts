import { error } from "@sveltejs/kit";
import { canShowResults, getStore, publicTally, tallyFor, viewerContext } from "$lib/server/app";
import type { PageServerLoad } from "./$types";

/**
 * Results only, for sharing. Follows the same visibility rules as the poll page:
 * hidden results never reach the payload. Drafts and scheduled polls have none.
 */
export const load = (({ params, cookies }) => {
  const poll = getStore().getPollBySlug(params.id);
  if (!poll) error(404, "Poll not found.");
  if (poll.status === "draft" || poll.status === "scheduled") error(404, "This poll has no results yet.");
  const votes = getStore().getVotes(poll.id);
  const showResults = canShowResults(poll, viewerContext(poll, cookies).viewerVote);
  return {
    poll,
    voteCount: votes.length,
    showResults,
    tally: showResults ? publicTally(tallyFor(poll, getStore().getOptions(poll.id), votes)) : null
  };
}) satisfies PageServerLoad;
