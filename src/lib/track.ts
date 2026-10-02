/**
 * Browser side of the usage log (server side: routes/api/events, lib/server/events.ts).
 * Records page views, clicks, which fields were changed (names, never values),
 * form submits, time on page and script errors, in batches. Nothing is sent
 * from anonymous polls, or when the browser sends Do Not Track or Global
 * Privacy Control. The only identifier is a random id in the poll_sid cookie.
 */

const SESSION_COOKIE = "poll_sid";
const FLUSH_MS = 4000;
const FLUSH_AT = 20;
const ENDPOINT = "/api/events";

type TrackedEvent = Record<string, string | number | boolean>;

let queue: TrackedEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let allowed = true;
let currentPath = "";
let enteredAt = 0;

function optedOut(): boolean {
  return navigator.doNotTrack === "1" || (navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true;
}

function ensureSession() {
  if (document.cookie.split("; ").some((part) => part.startsWith(`${SESSION_COOKIE}=`))) return;
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 20);
  document.cookie = `${SESSION_COOKIE}=${id}; Path=/; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}

function dropSession() {
  document.cookie = `${SESSION_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}

function trackingOn(): boolean {
  return started && allowed && !optedOut();
}

function push(event: TrackedEvent) {
  if (!trackingOn()) return;
  queue.push({ ...event, path: location.pathname, t: new Date().toISOString() });
  if (queue.length >= FLUSH_AT) flush();
  else timer ??= setTimeout(flush, FLUSH_MS);
}

export function flush() {
  clearTimeout(timer);
  timer = undefined;
  if (!queue.length) return;
  const body = JSON.stringify({ events: queue });
  queue = [];
  try {
    if (!navigator.sendBeacon(ENDPOINT, new Blob([body], { type: "application/json" }))) throw new Error("beacon refused");
  } catch {
    void fetch(ENDPOINT, { method: "POST", body, keepalive: true, headers: { "content-type": "application/json" } }).catch(() => {});
  }
}

/** Anonymous polls switch tracking off entirely (and forget the session). */
export function setTrackingAllowed(value: boolean) {
  allowed = value;
  if (!value) {
    queue = [];
    dropSession();
  } else if (started && !optedOut()) {
    ensureSession();
  }
}

const clip = (value: string | null | undefined, max = 80) => (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A label's own words, without the select options or inputs nested inside it. */
function labelText(label: Element): string {
  const copy = label.cloneNode(true) as Element;
  copy.querySelectorAll("select, input, textarea, option").forEach((node) => node.remove());
  return copy.textContent ?? "";
}

function describeTarget(start: Element): TrackedEvent {
  const el = start.closest("a, button, summary, input, select, textarea, label, [role=button], [role=tab], [role=option], [data-track]") ?? start;
  const tag = el.tagName.toLowerCase();
  const isField = tag === "input" || tag === "textarea" || tag === "select";
  const label = isField ? (el as HTMLInputElement).labels?.[0] : null;
  const event: TrackedEvent = { tag };
  const type = el.getAttribute("type") ?? el.getAttribute("role");
  if (type) event.type = type;
  if (el.id) event.id = clip(el.id);
  const name = el.getAttribute("name");
  if (name) event.name = clip(name);
  // Fields are named by their label, never by what was typed into them.
  const text = isField ? (label ? labelText(label) : el.getAttribute("aria-label")) : (el.getAttribute("aria-label") ?? el.textContent);
  if (clip(text)) event.text = clip(text);
  const href = tag === "a" ? el.getAttribute("href") : null;
  if (href) event.href = href;
  return event;
}

function leavePage() {
  if (!currentPath) return;
  const height = document.documentElement.scrollHeight - innerHeight;
  const leaving: TrackedEvent = { kind: "page_leave", ms: Date.now() - enteredAt };
  if (height > 0) leaving.scrollPercent = Math.round((Math.min(scrollY, height) / height) * 100);
  push({ ...leaving });
  // The leave event belongs to the page being left, not the one now showing.
  const last = queue[queue.length - 1];
  if (last) last.path = currentPath;
}

/** Call after each navigation (and once on load). */
export function trackPage() {
  if (!started) return;
  if (currentPath && currentPath !== location.pathname) leavePage();
  if (currentPath === location.pathname) return;
  currentPath = location.pathname;
  enteredAt = Date.now();
  push({ kind: "page_view", viewportWidth: innerWidth, viewportHeight: innerHeight, touch: matchMedia("(pointer: coarse)").matches, language: navigator.language });
}

export function startTracking() {
  if (started) return;
  started = true;
  if (!optedOut() && allowed) ensureSession();
  document.addEventListener("click", (event) => event.target instanceof Element && push({ kind: "click", ...describeTarget(event.target) }), true);
  document.addEventListener("change", (event) => event.target instanceof Element && push({ kind: "field_change", ...describeTarget(event.target) }), true);
  document.addEventListener(
    "submit",
    (event) => {
      const form = event.target instanceof HTMLFormElement ? event.target : null;
      if (form) push({ kind: "form_submit", id: clip(form.id), action: /\?\/\w+/.exec(form.getAttribute("action") ?? "")?.[0] ?? "" });
    },
    true
  );
  window.addEventListener("error", (event) => push({ kind: "client_error", message: clip(event.message, 300) }));
  window.addEventListener("unhandledrejection", (event) => push({ kind: "client_error", message: clip(String((event.reason as Error)?.message ?? event.reason), 300) }));
  window.addEventListener("pagehide", () => {
    leavePage();
    flush();
  });
  document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && flush());
}
