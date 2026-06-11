import { fail, redirect } from "@sveltejs/kit";
import { defaultConfigFor, defaultOptionsText } from "../../templates";
import { POLL_TYPES, type PollType } from "../../types";
import { getStore, inputFromRequest } from "$lib/server/app";

export function load({ url }) {
  const selected = parseType(url.searchParams.get("type")) ?? "sense_check";
  return {
    selected,
    values: {
      title: "",
      details: "",
      optionsText: defaultOptionsText(selected),
      opensAt: "",
      closesAt: "",
      config: defaultConfigFor(selected)
    }
  };
}

export const actions = {
  default: async ({ request }) => {
    let pollId: number;
    try {
      const input = await inputFromRequest(request);
      pollId = getStore().createPoll(input);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : String(error) });
    }
    redirect(303, `/poll/${pollId}`);
  }
};

function parseType(value: unknown): PollType | null {
  return POLL_TYPES.includes(value as PollType) ? value as PollType : null;
}
