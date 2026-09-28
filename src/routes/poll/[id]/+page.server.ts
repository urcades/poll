import { error, fail, redirect } from "@sveltejs/kit";
import { canShowResults, closePollOrThrow, deletePollOrThrow, getStore, grantAdminFromUrl, isPollAdmin, openPollOrThrow, recordVote, tallyFor, voteInputFromRequest, voteTokenFor, voterNameFor } from "$lib/server/app";
import { isOpen } from "$lib/shared";

export function load({ params, url, cookies }) {
  const poll = getStore().getPoll(Number(params.id));
  if (!poll) error(404, "Poll not found.");
  if (url.searchParams.has("admin")) {
    // Swap the token for a cookie, then drop it from the address bar so it
    // does not linger in history or get copied along with the voter link.
    grantAdminFromUrl(cookies, poll.id, url.searchParams.get("admin") ?? "");
    redirect(303, `/poll/${poll.id}`);
  }
  const isAdmin = isPollAdmin(cookies, poll.id);
  const options = getStore().getOptions(poll.id);
  const votes = getStore().getVotes(poll.id);
  const viewerName = voterNameFor(cookies, poll.id);
  const viewerVote = viewerName ? getStore().getVoteByName(poll.id, viewerName, voteTokenFor(cookies, poll.id)) : null;
  const showResults = canShowResults(poll, viewerVote);
  return {
    poll,
    options,
    voteCount: votes.length,
    viewerName,
    viewerVote,
    // Hidden results must not reach the client at all; the UI toggle alone
    // would still leak them through the serialized page data.
    tally: showResults ? tallyFor(poll, options, votes) : null,
    showResults,
    isAdmin,
    adminLink: isAdmin ? `/poll/${poll.id}?admin=${encodeURIComponent(getStore().getPollAdminToken(poll.id))}` : null
  };
}

export const actions = {
  open: async ({ params, cookies }) => {
    let pollId: number;
    try {
      const poll = openPollOrThrow(Number(params.id), cookies);
      pollId = poll.id;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${pollId}`);
  },
  close: async ({ params, cookies }) => {
    let pollId: number;
    try {
      const poll = closePollOrThrow(Number(params.id), cookies);
      pollId = poll.id;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${pollId}`);
  },
  delete: async ({ params, cookies }) => {
    try {
      deletePollOrThrow(Number(params.id), cookies);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, "/");
  },
  vote: async ({ params, request, cookies }) => {
    const poll = getStore().getPoll(Number(params.id));
    if (!poll) return fail(404, { error: "Poll not found." });
    if (!isOpen(poll)) return fail(400, { error: "Voting is not open." });
    const options = getStore().getOptions(poll.id);
    try {
      const vote = await voteInputFromRequest(request, poll, options);
      recordVote(poll, vote, cookies);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    // The viewer's name travels in a cookie (set by recordVote), not the URL.
    redirect(303, `/poll/${poll.id}`);
  }
};
