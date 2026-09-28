import { error, fail, redirect } from "@sveltejs/kit";
import { dateTimeLocalValue } from "$lib/shared";
import { getStore, inputFromRequest, isPollAdmin, updateDraftOrThrow } from "$lib/server/app";
import type { Actions, PageServerLoad } from "./$types";

export const load = (({ params, cookies }) => {
  const poll = getStore().getPollBySlug(params.id);
  if (!poll) error(404, "Poll not found.");
  if (!isPollAdmin(cookies, poll.id)) error(403, "Only the poll admin can edit this draft.");
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
      inviteesText: getStore().getInvites(poll.id).map((invite) => invite.name).join("\n"),
      config: poll.config
    }
  };
}) satisfies PageServerLoad;

export const actions = {
  default: async ({ params, request, cookies }) => {
    const poll = getStore().getPollBySlug(params.id);
    if (!poll) return fail(404, { error: "Poll not found." });
    if (!isPollAdmin(cookies, poll.id)) return fail(403, { error: "Only the poll admin can edit this draft." });
    if (poll.status !== "draft") return fail(400, { error: "Only draft polls can be edited." });
    try {
      updateDraftOrThrow(poll, await inputFromRequest(request), cookies);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${poll.slug}`);
  }
} satisfies Actions;
