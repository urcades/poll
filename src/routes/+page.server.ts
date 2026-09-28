import { getStore, isPollAdmin } from "$lib/server/app";
import { isClosed } from "$lib/shared";

export function load({ cookies }) {
  const polls = getStore().listPolls();
  return {
    // Drafts are private to their admin; everyone sees open/closed polls.
    drafts: polls.filter((poll) => poll.status === "draft" && isPollAdmin(cookies, poll.id)),
    active: polls.filter((poll) => poll.status !== "draft" && !isClosed(poll)),
    closed: polls.filter((poll) => poll.status !== "draft" && isClosed(poll))
  };
}
