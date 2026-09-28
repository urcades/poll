import { involvedPolls } from "$lib/server/app";
import { isClosed } from "$lib/shared";

/**
 * "My polls": only polls this browser holds a capability cookie for (admin or
 * vote token). A poll is otherwise shared purely by its link. The instance
 * operator sees everything.
 */
export function load({ cookies }) {
  const items = involvedPolls(cookies).map(({ poll, role }) => ({ poll, role }));
  return {
    drafts: items.filter(({ poll }) => poll.status === "draft"),
    active: items.filter(({ poll }) => poll.status !== "draft" && !isClosed(poll)),
    closed: items.filter(({ poll }) => poll.status !== "draft" && isClosed(poll))
  };
}
