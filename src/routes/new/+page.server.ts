import { fail, redirect } from "@sveltejs/kit";
import { defaultConfigFor, defaultOptionsText } from "../../templates";
import { POLL_TYPES, type PollType } from "../../types";
import { createPollWithAdmin, inputFromRequest } from "$lib/server/app";
import type { Actions, PageServerLoad } from "./$types";

export const load = (({ url }) => {
  const selected = parseType(url.searchParams.get("type")) ?? "sense_check";
  return {
    selected,
    values: {
      title: "",
      details: "",
      optionsText: defaultOptionsText(selected),
      opensAt: "",
      closesAt: "",
      inviteesText: "",
      config: defaultConfigFor(selected)
    }
  };
}) satisfies PageServerLoad;

export const actions = {
  default: async ({ request, cookies }) => {
    let slug: string;
    try {
      const input = await inputFromRequest(request);
      slug = createPollWithAdmin(input, cookies).id;
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${slug}`);
  }
} satisfies Actions;

function parseType(value: unknown): PollType | null {
  return POLL_TYPES.includes(value as PollType) ? value as PollType : null;
}
