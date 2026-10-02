/**
 * Every human-facing capability (a page load, a form action, or an HTTP
 * handler under src/routes) mapped to the MCP tool(s) that give agents the
 * same capability, or to the reason agents do not need one.
 *
 * tests/mcp-parity.test.ts scans src/routes and fails when a capability is
 * missing from this map or names a tool that does not exist. Adding a route,
 * action or handler therefore means adding its entry here, and usually a tool
 * (see .claude/skills/mcp-parity/SKILL.md).
 *
 * Keys are `<path under src/routes>#<load | action name | HTTP method>`.
 */
export type Counterpart = { tools: string[] } | { excluded: string };

export const HUMAN_CAPABILITIES: Record<string, Counterpart> = {
  // Pages people read
  "+page.server.ts#load": { tools: ["list_my_polls"] },
  "+page.server.ts#suggest": { excluded: "Turns a person's plain-language description into a pre-filled editor. An agent already picks the method and fills the settings itself, using list_poll_types and create_poll." },
  "new/+page.server.ts#load": { tools: ["list_poll_types"] },
  "poll/[id]/+page.server.ts#load": { tools: ["get_poll"] },
  "poll/[id]/edit/+page.server.ts#load": { tools: ["get_poll"] },
  "poll/[id]/results/+page.server.ts#load": { tools: ["get_results"] },

  // Form actions
  "new/+page.server.ts#default": { tools: ["create_poll"] },
  "poll/[id]/edit/+page.server.ts#default": { tools: ["update_draft"] },
  "poll/[id]/+page.server.ts#open": { tools: ["open_poll"] },
  "poll/[id]/+page.server.ts#schedule": { tools: ["schedule_poll"] },
  "poll/[id]/+page.server.ts#unschedule": { tools: ["unschedule_poll"] },
  "poll/[id]/+page.server.ts#duplicate": { tools: ["duplicate_poll"] },
  "poll/[id]/+page.server.ts#close": { tools: ["close_poll"] },
  "poll/[id]/+page.server.ts#delete": { tools: ["delete_poll"] },
  "poll/[id]/+page.server.ts#addInvitees": { tools: ["add_invitees"] },
  "poll/[id]/+page.server.ts#vote": { tools: ["cast_vote"] },

  // JSON API
  "api/polls/+server.ts#POST": { tools: ["create_poll"] },
  "api/polls/[id]/+server.ts#POST": { tools: ["update_draft"] },
  "api/polls/[id]/open/+server.ts#POST": { tools: ["open_poll"] },
  "api/polls/[id]/schedule/+server.ts#POST": { tools: ["schedule_poll"] },
  "api/polls/[id]/unschedule/+server.ts#POST": { tools: ["unschedule_poll"] },
  "api/polls/[id]/duplicate/+server.ts#POST": { tools: ["duplicate_poll"] },
  "api/polls/[id]/close/+server.ts#POST": { tools: ["close_poll"] },
  "api/polls/[id]/invitees/+server.ts#POST": { tools: ["add_invitees"] },
  "api/polls/[id]/votes/+server.ts#POST": { tools: ["cast_vote"] },

  // Downloads and polling endpoints
  "poll/[id]/export.json/+server.ts#GET": { tools: ["export_results"] },
  "poll/[id]/export.csv/+server.ts#GET": { tools: ["export_results"] },
  "poll/[id]/event.ics/+server.ts#GET": { tools: ["get_results"] }, // results.calendarUrl
  "poll/[id]/version/+server.ts#GET": { tools: ["get_poll"] }, // the `version` field

  // The operator's usage log
  "events/+page.server.ts#load": { tools: ["get_usage_events"] },
  "events/export.json/+server.ts#GET": { tools: ["get_usage_events"] },
  "events/export.csv/+server.ts#GET": { tools: ["get_usage_events"] }, // rows are the same events; CSV is a download format
  "events/corrections/+page.server.ts#load": { tools: ["get_jev_corrections"] },
  "events/corrections/export.jsonl/+server.ts#GET": { tools: ["get_jev_corrections"] }, // format: "jsonl"
  "api/events/+server.ts#POST": { excluded: "The browser tracker's beacon for page views and clicks (lib/track.ts); there is no page for an agent to click." },

  // The MCP endpoint itself
  "mcp/+server.ts#POST": { excluded: "This is the MCP endpoint." },
  "mcp/+server.ts#GET": { excluded: "This is the MCP endpoint." },
  "mcp/+server.ts#DELETE": { excluded: "This is the MCP endpoint." }
};
