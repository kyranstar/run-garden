/**
 * Google Calendar behind `fetch`, for the suites that need recurring events (the condition cues, and the sync's budget
 * with cues on the calendar). Never calls Google.
 *
 *  - Sync-token semantics: a token is a change sequence number, and an incremental read answers every event changed
 *    after it, this app's own writes included.
 *  - The one recurrence rule a cue uses (`FREQ=MONTHLY;BYMONTHDAY=…`) is expanded as Google does: the start is the first
 *    occurrence, then the rule's days, at the start's wall clock in its zone. A read with `singleEvents=true` answers the
 *    occurrences (each carrying its series' private properties) — within timeMin/timeMax on a full read, and on a token
 *    read up to `horizonDays` past `now` (Google's own horizon for an endless series is not known: this is a stand-in).
 *  - A series listing (`singleEvents=false`) answers a series' start with its zone's offset, as Google does, and also the
 *    occurrences the athlete changed or deleted one by one (`recurringEventId`), as Google documents, listed first.
 *  - Pages of `pageSize` items (`nextPageToken`); the sync token comes on the last page only.
 *  - Failures injected by method and count: 500, 403, 401, a dropped connection, an answer lost after Google acted, and
 *    a request that never comes back after Google acted.
 */
import { DateTime } from "luxon";
import { addDays } from "@rg/domain";

export type FakeBody = {
  summary?: string;
  description?: string;
  start: { dateTime: string; timeZone?: string };
  end: { dateTime: string; timeZone?: string };
  recurrence?: string[];
  transparency?: string;
  reminders?: unknown;
  extendedProperties?: { private?: Record<string, string> };
};
export interface FakeStored {
  id: string;
  calendarId: string;
  status: "confirmed" | "cancelled";
  seq: number;
  body: FakeBody;
}
export type FakeFailure = "500" | "403" | "401" | "throw" | "lost" | "lost-throw" | "hang";

export interface FakeGoogleOptions {
  /** The test's clock, for the token read's horizon. */
  now: string;
  /** The zone `addCue` makes series in. */
  zone: string;
  /** The app's origin `addCue` stamps. */
  origin: string;
  /** The first day `addCue`'s series sound. */
  firstDay: string;
  /** Items per page (Google's most is 250, what the client asks for). */
  pageSize?: number;
  /** How far past `now` a token read expands an endless series. */
  horizonDays?: number;
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

export class FakeGoogle {
  events = new Map<string, FakeStored>();
  /** The calendars this account has; any other answers 404. */
  calendars = new Set(["cal", "cal2"]);
  /** Every events call: "GET cal", "POST cal", "DELETE cal/ev3", "PATCH cal/ev3". */
  calls: string[] = [];
  /** Every list's query string. */
  queries: string[] = [];
  /** Every events call's Authorization header. */
  bearers: string[] = [];
  fetches = 0;
  refreshes = 0;
  /** The token endpoint refuses (a dead refresh token). */
  refuseRefresh = false;
  /** A list answers more than its private-property search asked for. */
  ignoreProperty = false;
  /** A list answers deleted events though it asked for none. */
  answersDeleted = false;
  /** What each list page answered, item by item. */
  listed: Array<Record<string, unknown>> = [];
  /** Occurrences the athlete changed or deleted one by one. */
  private exceptions: Array<{ calendarId: string; item: Record<string, unknown> }> = [];
  private failures: Array<{ method: string; nth: number; answer: FakeFailure }> = [];
  private counts = new Map<string, number>();
  private seq = 1;
  private n = 0;

  constructor(private readonly o: FakeGoogleOptions) {}

  /** The `nth` (1-based) call of `method` from now on answers `answer`. */
  fail(method: string, nth: number, answer: FakeFailure): void {
    this.failures.push({ method, nth: (this.counts.get(method) ?? 0) + nth, answer });
  }

  add(calendarId: string, body: FakeBody): string {
    const id = `ev${++this.n}`;
    this.events.set(id, { id, calendarId, status: "confirmed", seq: ++this.seq, body: structuredClone(body) });
    return id;
  }

  /** A cue series already on the calendar (as an earlier request, or another deployment, made it). */
  addCue(time: string, opts: { calendarId?: string; origin?: string; profileId?: string; timezone?: string } = {}): string {
    const zone = opts.timezone ?? this.o.zone;
    const priv: Record<string, string> = { rgCue: opts.profileId ?? "tmj", rgApp: "Run Garden" };
    if (opts.origin !== "") priv.rgOrigin = opts.origin ?? this.o.origin;
    return this.add(opts.calendarId ?? "cal", {
      summary: "cue",
      description: "",
      start: { dateTime: `${this.o.firstDay}T${time}:00`, timeZone: zone },
      end: { dateTime: wallPlus(`${this.o.firstDay}T${time}:00`, 5), timeZone: zone },
      recurrence: ["RRULE:FREQ=MONTHLY;BYMONTHDAY=1,2,3,4,5,6,7"],
      transparency: "transparent",
      extendedProperties: { private: priv },
    });
  }

  /** The athlete deletes an event in Google by hand. */
  cancel(id: string): void {
    const e = this.events.get(id)!;
    e.status = "cancelled";
    e.seq = ++this.seq;
  }

  /** The athlete drags a whole series to another time of day. */
  moveSeries(id: string, time: string): void {
    const e = this.events.get(id)!;
    const date = e.body.start.dateTime.slice(0, 10);
    e.body = { ...e.body, start: { ...e.body.start, dateTime: `${date}T${time}:00` }, end: { ...e.body.end, dateTime: wallPlus(`${date}T${time}:00`, 5) } };
    e.seq = ++this.seq;
  }

  /** The athlete deletes one occurrence of a series (that day only). */
  cancelOccurrence(seriesId: string, date: string): void {
    this.exception(seriesId, date, { status: "cancelled" });
  }

  /** The athlete changes one occurrence of a series (that day only): Google keeps it as its own confirmed event. */
  modifyOccurrence(seriesId: string, date: string): void {
    this.exception(seriesId, date, { status: "confirmed", summary: "retitled by hand" });
  }

  private exception(seriesId: string, date: string, over: Record<string, unknown>): void {
    const e = this.events.get(seriesId)!;
    const zone = e.body.start.timeZone!;
    const start = DateTime.fromISO(`${date}T${e.body.start.dateTime.slice(11, 16)}`, { zone });
    const at = { dateTime: start.toISO({ suppressMilliseconds: true }), timeZone: zone };
    this.exceptions.push({
      calendarId: e.calendarId,
      item: {
        id: `${e.id}_${start.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")}`,
        recurringEventId: e.id,
        originalStartTime: at,
        start: at,
        end: { dateTime: start.plus({ minutes: 5 }).toISO({ suppressMilliseconds: true }), timeZone: zone },
        extendedProperties: structuredClone(e.body.extendedProperties),
        ...over,
      },
    });
  }

  live(calendarId = "cal"): FakeStored[] {
    return [...this.events.values()].filter((e) => e.calendarId === calendarId && e.status === "confirmed");
  }

  liveCues(calendarId = "cal"): FakeStored[] {
    return this.live(calendarId).filter((e) => e.body.extendedProperties?.private?.rgCue !== undefined);
  }

  writes(): string[] {
    return this.calls.filter((c) => !c.startsWith("GET"));
  }

  /** The series' occurrences from `from` to `to` (instants), as Google expands its one rule. */
  occurrences(e: FakeStored, from: string, to: string): Array<{ start: DateTime; end: DateTime }> {
    const rule = e.body.recurrence ?? [];
    const m = rule.length === 1 ? /^RRULE:FREQ=MONTHLY;BYMONTHDAY=([\d,]+)$/.exec(rule[0]!) : null;
    if (!m) throw new Error(`the fake expands one monthly by-day rule, not ${JSON.stringify(rule)}`);
    const days = new Set(m[1]!.split(",").map(Number));
    const zone = e.body.start.timeZone;
    if (!zone || /(Z|[+-]\d\d:\d\d)$/.test(e.body.start.dateTime)) throw new Error("a recurring event's start is a wall clock and a zone");
    const [date, clock] = e.body.start.dateTime.split("T") as [string, string];
    const wall = (s: string) => DateTime.fromISO(s, { zone: "UTC" });
    const minutes = wall(e.body.end.dateTime).diff(wall(e.body.start.dateTime), "minutes").minutes;
    const out: Array<{ start: DateTime; end: DateTime }> = [];
    const lo = DateTime.fromISO(from);
    const hi = DateTime.fromISO(to);
    for (let i = 0; i < 2000; i++) {
      const day = addDays(date, i);
      // DTSTART is the first occurrence; after it, the rule's days.
      if (i > 0 && !days.has(Number(day.slice(8)))) continue;
      const start = DateTime.fromISO(`${day}T${clock}`, { zone });
      if (start > hi) break;
      if (start >= lo) out.push({ start, end: start.plus({ minutes }) });
    }
    return out;
  }

  firstOccurrence(id: string): string {
    const e = this.events.get(id)!;
    return this.occurrences(e, "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")[0]!.start.toUTC().toISO()!;
  }

  private item(e: FakeStored): Record<string, unknown> {
    // Google answers a series' start with the zone's offset, beside its zone.
    const zone = e.body.start.timeZone;
    const withOffset = (t: { dateTime: string; timeZone?: string }) =>
      zone && e.body.recurrence ? { ...t, dateTime: DateTime.fromISO(t.dateTime, { zone }).toISO({ suppressMilliseconds: true }) } : t;
    return { id: e.id, status: e.status, ...structuredClone(e.body), start: withOffset(e.body.start), end: withOffset(e.body.end) };
  }

  private instances(e: FakeStored, from: string, to: string): Array<Record<string, unknown>> {
    return this.occurrences(e, from, to).map(({ start, end }) => ({
      id: `${e.id}_${start.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")}`,
      recurringEventId: e.id,
      status: e.status,
      summary: e.body.summary,
      description: e.body.description,
      transparency: e.body.transparency,
      start: { dateTime: start.toISO({ suppressMilliseconds: true }), timeZone: e.body.start.timeZone },
      end: { dateTime: end.toISO({ suppressMilliseconds: true }), timeZone: e.body.start.timeZone },
      // An instance carries its series' private properties.
      extendedProperties: structuredClone(e.body.extendedProperties),
    }));
  }

  fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    this.fetches += 1;
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
      this.refreshes += 1;
      return this.refuseRefresh ? json({ error: "invalid_grant" }, 400) : json({ access_token: "fresh-access", expires_in: 3600 });
    }
    const m = url.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
    if (url.hostname !== "www.googleapis.com" || !m) return json({}, 404);
    const calendarId = decodeURIComponent(m[1]!);
    const eventId = m[2] ? decodeURIComponent(m[2]) : undefined;
    this.calls.push(`${method} ${calendarId}${eventId ? `/${eventId}` : ""}`);
    if (method === "GET") this.queries.push(url.search);
    this.bearers.push(new Headers(init?.headers).get("Authorization") ?? "");
    const count = (this.counts.get(method) ?? 0) + 1;
    this.counts.set(method, count);
    const failure = this.failures.find((f) => f.method === method && f.nth === count);
    if (failure?.answer === "500") return json({ error: "backend" }, 500);
    if (failure?.answer === "403") return json({ error: "forbidden" }, 403);
    if (failure?.answer === "401") return json({ error: "expired" }, 401);
    if (failure?.answer === "throw") throw new TypeError("network connection lost");
    if (!this.calendars.has(calendarId)) return json({ error: "notFound" }, 404);
    const answer = this.handle(method, calendarId, eventId, url, init);
    if (failure?.answer === "lost") return json({ error: "backend" }, 500);
    if (failure?.answer === "lost-throw") throw new TypeError("network connection lost");
    // Google did it, and the request never comes back: the invocation dies here.
    if (failure?.answer === "hang") return new Promise<Response>(() => undefined);
    return answer;
  }) as typeof fetch;

  private handle(method: string, calendarId: string, eventId: string | undefined, url: URL, init?: RequestInit): Response {
    if (method === "GET" && !eventId) {
      const p = url.searchParams;
      const token = p.get("syncToken");
      const single = p.get("singleEvents") === "true";
      const showDeleted = p.get("showDeleted") === "true" || this.answersDeleted;
      const property = p.get("privateExtendedProperty");
      let series = [...this.events.values()].filter((e) => e.calendarId === calendarId);
      if (property && !this.ignoreProperty) {
        const [k, v] = property.split("=") as [string, string];
        series = series.filter((e) => e.body.extendedProperties?.private?.[k] === v);
      }
      if (token) series = series.filter((e) => e.seq > Number(token));
      if (!showDeleted) series = series.filter((e) => e.status === "confirmed");
      const from = token ? "2000-01-01T00:00:00Z" : (p.get("timeMin") ?? "2000-01-01T00:00:00Z");
      const to = token ? DateTime.fromISO(this.o.now).plus({ days: this.o.horizonDays ?? 400 }).toISO()! : (p.get("timeMax") ?? "2100-01-01T00:00:00Z");
      const items = series.flatMap((e) => {
        if (single && e.body.recurrence) return this.instances(e, from, to);
        if (single && !token) {
          const at = DateTime.fromISO(e.body.start.dateTime);
          if (at < DateTime.fromISO(from) || at > DateTime.fromISO(to)) return [];
        }
        return [this.item(e)];
      });
      if (!single && !token) {
        const listed = new Set(series.map((e) => e.id));
        items.unshift(...this.exceptions.filter((x) => x.calendarId === calendarId && listed.has(x.item.recurringEventId as string)).map((x) => structuredClone(x.item)));
      }
      const size = Math.min(Number(p.get("maxResults") ?? 250), this.o.pageSize ?? 250);
      const offset = Number(p.get("pageToken") ?? 0);
      const page = items.slice(offset, offset + size);
      this.listed.push(...page);
      const more = offset + size < items.length;
      return json(more ? { items: page, nextPageToken: String(offset + size) } : { items: page, nextSyncToken: String(this.seq) });
    }
    if (method === "POST" && !eventId) {
      const body = JSON.parse(String(init!.body)) as FakeBody;
      const id = this.add(calendarId, body);
      return json({ id, ...body });
    }
    const e = eventId ? this.events.get(eventId) : undefined;
    if (!e || e.calendarId !== calendarId) return json({ error: "notFound" }, 404);
    if (method === "PATCH") {
      e.body = { ...e.body, ...(JSON.parse(String(init!.body)) as FakeBody) };
      e.seq = ++this.seq;
      return json({ id: e.id });
    }
    if (method === "DELETE") {
      if (e.status === "cancelled") return json({ error: "deleted" }, 410);
      e.status = "cancelled";
      e.seq = ++this.seq;
      return new Response(null, { status: 204 });
    }
    return json({}, 400);
  }
}

/** A wall-clock "YYYY-MM-DDTHH:MM:SS" `minutes` later. */
function wallPlus(wall: string, minutes: number): string {
  return DateTime.fromISO(wall, { zone: "UTC" }).plus({ minutes }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
}
