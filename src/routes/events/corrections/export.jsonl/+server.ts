import { error } from "@sveltejs/kit";
import { isOperator } from "$lib/server/app";
import { correctionRows, trainingJsonl } from "$lib/server/corrections";
import type { RequestHandler } from "./$types";

/** Prompt -> the model's reading -> what was saved, one JSON object per line (operator only). Add `?saved=1` for rows that have a saved poll, the labelled ones. */
export const GET: RequestHandler = ({ url, cookies }) => {
  if (!isOperator(cookies)) error(404, "Not found");
  const rows = correctionRows({ since: url.searchParams.get("since") || undefined, until: url.searchParams.get("until") || undefined, limit: 5000 });
  const body = trainingJsonl(url.searchParams.get("saved") ? rows.filter((row) => row.final) : rows);
  return new Response(body, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": 'attachment; filename="jev-corrections.jsonl"', "Cache-Control": "no-store" } });
};
