import { error } from "@sveltejs/kit";
import { isOperator } from "$lib/server/app";
import { correctionRows, correctionStats, type Outcome } from "$lib/server/corrections";
import type { PageServerLoad } from "./$types";

/** How Jev's readings fare against what people save (operator only). */
export const load = (({ url, cookies }) => {
  if (!isOperator(cookies)) error(404, "Not found");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 300, 1), 2000);
  const all = correctionRows({ since: url.searchParams.get("since") || undefined, until: url.searchParams.get("until") || undefined, limit });
  const outcome = url.searchParams.get("outcome") as Outcome | null;
  return {
    stats: correctionStats(all),
    rows: outcome ? all.filter((row) => row.outcome === outcome) : all,
    query: { since: url.searchParams.get("since") ?? "", until: url.searchParams.get("until") ?? "", outcome: outcome ?? "", limit: String(limit) }
  };
}) satisfies PageServerLoad;
