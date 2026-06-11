import { error, fail, redirect } from "@sveltejs/kit";
import { dateTimeLocalValue } from "$lib/shared";
import { getStore, inputFromRequest } from "$lib/server/app";

export function load({ params }) {
  const poll = getStore().getPoll(Number(params.id));
  if (!poll) error(404, "Poll not found.");
  if (poll.status !== "draft") error(400, "This poll is no longer a draft, so its setup is frozen.");
  const options = getStore().getOptions(poll.id);
  return {
    poll,
    selected: poll.type,
    values: {
      title: poll.title,
      details: poll.details,
      optionsText: options.map((option) => option.meaning ? `${option.label} | ${option.meaning}` : option.label).join("\n"),
      opensAt: dateTimeLocalValue(poll.opensAt),
      closesAt: dateTimeLocalValue(poll.closesAt),
      config: poll.config
    }
  };
}

export const actions = {
  default: async ({ params, request }) => {
    const poll = getStore().getPoll(Number(params.id));
    if (!poll) return fail(404, { error: "Poll not found." });
    if (poll.status !== "draft") return fail(400, { error: "Only draft polls can be edited." });
    try {
      const input = { id: poll.id, ...(await inputFromRequest(request)) };
      if (!getStore().updatePoll(input)) throw new Error("Could not update draft.");
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${poll.id}`);
  }
};
