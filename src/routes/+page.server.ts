import { involvedPolls } from "$lib/server/app";
import { isClosed } from "$lib/shared";
import type { PageServerLoad } from "./$types";

/**
 * "My polls": only polls this browser holds a capability cookie for (admin or
 * vote token). A poll is otherwise shared purely by its link. The instance
 * operator sees everything.
 */
export const load = (({ cookies }) => {
  const items = involvedPolls(cookies).map(({ poll, role }) => ({ poll, role }));
  return {
    // Scheduled polls (only ever listed for their admin) sit with the drafts.
    drafts: items.filter(({ poll }) => poll.status === "draft" || poll.status === "scheduled"),
    active: items.filter(({ poll }) => poll.status === "open" && !isClosed(poll)),
    closed: items.filter(({ poll }) => poll.status !== "draft" && poll.status !== "scheduled" && isClosed(poll))
  };
}) satisfies PageServerLoad;
