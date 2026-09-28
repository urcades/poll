import { error, fail, redirect } from "@sveltejs/kit";
import { addInviteesOrThrow, adminCookieToken, ballotOptionsFor, canShowResults, closePollOrThrow, deletePollOrThrow, duplicatePollOrThrow, getStore, grantAdminFromUrl, grantInviteFromUrl, InviteRequiredError, invitationsFor, isPollAdmin, openPollOrThrow, publicTally, schedulePollOrThrow, submitVote, tallyFor, unschedulePollOrThrow, viewerContext } from "$lib/server/app";
import { isOpen } from "$lib/shared";
import type { Actions, PageServerLoad } from "./$types";

export const load = (({ params, url, cookies }) => {
  const poll = getStore().getPollBySlug(params.id);
  if (!poll) error(404, "Poll not found.");
  if (url.searchParams.has("admin") || url.searchParams.has("invite")) {
    // Swap the token for a cookie, then drop it from the address bar so it
    // does not linger in history or get copied along with the voter link.
    if (url.searchParams.has("admin")) grantAdminFromUrl(cookies, poll.id, url.searchParams.get("admin") ?? "");
    if (url.searchParams.has("invite")) grantInviteFromUrl(cookies, poll, url.searchParams.get("invite") ?? "");
    redirect(303, `/poll/${poll.slug}`);
  }
  const isAdmin = isPollAdmin(cookies, poll.id);
  const adminToken = adminCookieToken(cookies, poll.id);
  const options = getStore().getOptions(poll.id);
  const votes = getStore().getVotes(poll.id);
  // In invite mode the viewer is whoever their invite cookie says, and the
  // invite token is the ballot's edit token.
  const { inviteMode, invite, viewerName, viewerVote } = viewerContext(poll, cookies);
  const showResults = canShowResults(poll, viewerVote);
  // A scheduled poll shows visitors only when it opens; its ballot is for the admin's preview.
  const hideBallot = poll.status === "scheduled" && !isAdmin;
  return {
    poll,
    options: hideBallot ? [] : options,
    /** Options in this viewer's ballot order (shuffled when the poll asks for it); results use `options`. */
    ballotOptions: hideBallot ? [] : ballotOptionsFor(poll, options, cookies),
    voteCount: votes.length,
    viewerName,
    viewerVote,
    // Hidden results must not reach the client at all; the UI toggle alone
    // would still leak them through the serialized page data.
    tally: showResults ? publicTally(tallyFor(poll, options, votes)) : null,
    showResults,
    isAdmin,
    /** Invite-only poll and this browser holds no valid personal link. */
    inviteRequired: inviteMode && !invite,
    invitations: isAdmin && inviteMode ? invitationsFor(poll, votes, adminToken) : null,
    // Rebuilt from the admin's own cookie (only hashes are stored). Operators
    // who are not this poll's admin get no link.
    adminLink: adminToken ? `/poll/${poll.slug}?admin=${encodeURIComponent(adminToken)}` : null,
    /** Change marker the page compares against /poll/[id]/version to know when to reload. */
    version: getStore().pollVersion(poll.slug) ?? ""
  };
}) satisfies PageServerLoad;

export const actions = {
  open: async ({ params, cookies }) => {
    let slug: string;
    try {
      const poll = openPollOrThrow(params.id, cookies);
      slug = poll.slug;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${slug}`);
  },
  schedule: async ({ params, cookies }) => {
    try {
      schedulePollOrThrow(params.id, cookies);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${params.id}`);
  },
  unschedule: async ({ params, cookies }) => {
    try {
      unschedulePollOrThrow(params.id, cookies);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${params.id}`);
  },
  duplicate: async ({ params, cookies }) => {
    let slug: string;
    try {
      slug = duplicatePollOrThrow(params.id, cookies).id;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${slug}/edit`);
  },
  close: async ({ params, cookies }) => {
    let slug: string;
    try {
      const poll = closePollOrThrow(params.id, cookies);
      slug = poll.slug;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${slug}`);
  },
  delete: async ({ params, cookies }) => {
    try {
      deletePollOrThrow(params.id, cookies);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, "/");
  },
  addInvitees: async ({ params, request, cookies }) => {
    try {
      const data = await request.formData();
      addInviteesOrThrow(params.id, cookies, String(data.get("inviteesText") ?? ""));
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${params.id}`);
  },
  vote: async ({ params, request, cookies }) => {
    const poll = getStore().getPollBySlug(params.id);
    if (!poll) return fail(404, { error: "Poll not found." });
    if (!isOpen(poll)) return fail(400, { error: "Voting is not open." });
    const options = getStore().getOptions(poll.id);
    try {
      await submitVote(poll, options, request, cookies);
    } catch (error) {
      return fail(error instanceof InviteRequiredError ? 403 : 400, { error: error instanceof Error ? error.message : String(error) });
    }
    // The viewer's name travels in a cookie (set by recordVote), not the URL.
    redirect(303, `/poll/${poll.slug}`);
  }
} satisfies Actions;
