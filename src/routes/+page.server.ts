import { getStore } from "$lib/server/app";
import { isClosed } from "$lib/shared";

export function load() {
  const polls = getStore().listPolls();
  return {
    drafts: polls.filter((poll) => poll.status === "draft"),
    active: polls.filter((poll) => poll.status !== "draft" && !isClosed(poll)),
    closed: polls.filter((poll) => poll.status !== "draft" && isClosed(poll))
  };
}
