// An in-memory stand-in for iCloud CalDAV, faithful enough to run the real tsdav client and the
// Worker's calendar code end to end: service discovery, principal and home lookup, calendar listing,
// calendar-query with time-range and server-side expansion, calendar-multiget, and conditional
// PUT/DELETE with ETags. Nothing here talks to Apple.

import ICAL from "ical.js";
import { tzlib_get_ical_block } from "timezones-ical-library";

export interface FakeCalendar {
  slug: string;
  name: string;
  timeZone?: string;
  components?: string[];
  readOnly?: boolean;
}

interface StoredObject {
  data: string;
  etag: string;
}

const USER = "123456";
const ROOT = "https://caldav.icloud.com";
const HOST = "https://p01-caldav.icloud.com";

function escapeXml(value: string): string {
  return value.replace(/[&<>]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]!);
}

function multistatus(responses: string[]): Response {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>\n<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">${responses.join("")}</d:multistatus>`, {
    status: 207,
    headers: { "content-type": "text/xml; charset=utf-8" },
  });
}

function propstat(href: string, props: string, status = "HTTP/1.1 200 OK"): string {
  return `<d:response><d:href>${escapeXml(href)}</d:href><d:propstat><d:prop>${props}</d:prop><d:status>${status}</d:status></d:propstat></d:response>`;
}

function icalTime(value: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) throw new Error(`bad time-range value ${value}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
}

function utcTime(time: ICAL.Time): ICAL.Time {
  if (time.isDate) return time;
  return ICAL.Time.fromJSDate(new Date(time.toUnixTime() * 1000), true);
}

function epochOf(time: ICAL.Time): number {
  if (time.isDate) return Date.UTC(time.year, time.month - 1, time.day);
  return time.toUnixTime() * 1000;
}

export class FakeICloud {
  readonly objects = new Map<string, StoredObject>();
  readonly log: Array<{ method: string; path: string; status: number }> = [];
  private readonly calendars: FakeCalendar[];
  private etagCounter = 0;
  // Hook to simulate someone else editing between our read and write.
  beforeWrite: ((path: string) => void) | undefined;

  constructor(readonly username: string, readonly password: string, calendars: FakeCalendar[]) {
    this.calendars = calendars;
  }

  calendarPath(slug: string): string {
    return `/${USER}/calendars/${slug}/`;
  }

  calendarUrl(slug: string): string {
    return `${HOST}${this.calendarPath(slug)}`;
  }

  nextEtag(): string {
    this.etagCounter += 1;
    return `"etag-${this.etagCounter}-${crypto.randomUUID().slice(0, 8)}"`;
  }

  put(slug: string, filename: string, data: string): string {
    const etag = this.nextEtag();
    this.objects.set(`${this.calendarPath(slug)}${filename}`, { data, etag });
    return etag;
  }

  objectsIn(slug: string): Array<{ path: string; data: string; etag: string }> {
    const prefix = this.calendarPath(slug);
    return [...this.objects.entries()].filter(([path]) => path.startsWith(prefix)).map(([path, object]) => ({ path, ...object }));
  }

  // Simulates an edit made elsewhere (for example on the iPhone) so the stored ETag changes.
  touch(path: string, mutate: (data: string) => string = (data) => data): void {
    const object = this.objects.get(path);
    if (!object) throw new Error(`no object at ${path}`);
    this.objects.set(path, { data: mutate(object.data), etag: this.nextEtag() });
  }

  externalSubrequests(): number {
    return this.log.length;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const response = await this.handle(request);
    this.log.push({ method: request.method, path: new URL(request.url).pathname, status: response.status });
    return response;
  };

  private authorized(request: Request): boolean {
    return request.headers.get("authorization") === `Basic ${btoa(`${this.username}:${this.password}`)}`;
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!this.authorized(request)) return new Response("Unauthorized", { status: 401 });
    const body = request.method === "PUT" || request.method === "DELETE" ? "" : await request.text();

    if (url.origin === ROOT) {
      if (url.pathname === "/.well-known/caldav") return new Response(null, { status: 301, headers: { location: `${ROOT}/` } });
      if (request.method === "PROPFIND" && url.pathname === "/" && body.includes("current-user-principal")) {
        return multistatus([propstat("/", `<d:current-user-principal><d:href>/${USER}/principal/</d:href></d:current-user-principal>`)]);
      }
      if (request.method === "PROPFIND" && url.pathname === `/${USER}/principal/` && body.includes("calendar-home-set")) {
        return multistatus([propstat(`/${USER}/principal/`, `<cal:calendar-home-set><d:href>${HOST}:443/${USER}/calendars/</d:href></cal:calendar-home-set>`)]);
      }
    }
    // iCloud serves the calendar home on both the shared host and the account's partition host.
    if (url.origin !== HOST && url.origin !== ROOT) return new Response("Unknown host", { status: 404 });

    if (request.method === "PROPFIND" && url.pathname === `/${USER}/calendars/`) {
      const home = propstat(url.pathname, `<d:resourcetype><d:collection/></d:resourcetype>`);
      const calendars = this.calendars.map((calendar) => {
        const components = (calendar.components ?? ["VEVENT"]).map((name) => `<cal:comp name="${name}"/>`).join("");
        const block = calendar.timeZone ? (tzlib_get_ical_block(calendar.timeZone) as string[])[0] : undefined;
        const timezone = block ? `<cal:calendar-timezone><![CDATA[BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${block}\r\nEND:VCALENDAR]]></cal:calendar-timezone>` : "";
        return propstat(
          this.calendarPath(calendar.slug),
          `<d:displayname><![CDATA[${calendar.name}]]></d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype><cal:supported-calendar-component-set>${components}</cal:supported-calendar-component-set><cs:getctag>ctag-1</cs:getctag>${timezone}`,
        );
      });
      return multistatus([home, ...calendars]);
    }

    const calendar = this.calendars.find((candidate) => url.pathname.startsWith(this.calendarPath(candidate.slug)));
    if (!calendar) return new Response("Not found", { status: 404 });

    if (request.method === "PROPFIND") {
      return multistatus([propstat(url.pathname, `<d:supported-report-set/>`)]);
    }

    if (request.method === "REPORT") {
      if (body.includes("calendar-multiget")) {
        const hrefs = [...body.matchAll(/<d:href>([^<]+)<\/d:href>/g)].map((match) => decodeURIComponent(match[1]!));
        return multistatus(hrefs.map((href) => {
          const object = this.objects.get(href);
          if (!object) return `<d:response><d:href>${escapeXml(href)}</d:href><d:status>HTTP/1.1 404 Not Found</d:status></d:response>`;
          return propstat(href, `<d:getetag>${escapeXml(object.etag)}</d:getetag><cal:calendar-data><![CDATA[${object.data}]]></cal:calendar-data>`);
        }));
      }
      const range = /<c(?:al)?:time-range[^>]*start="(\d{8}T\d{6}Z)"[^>]*end="(\d{8}T\d{6}Z)"/.exec(body);
      const expand = /<c(?:al)?:expand[^>]*start="(\d{8}T\d{6}Z)"[^>]*end="(\d{8}T\d{6}Z)"/.exec(body);
      const start = range ? icalTime(range[1]!) : Number.NEGATIVE_INFINITY;
      const end = range ? icalTime(range[2]!) : Number.POSITIVE_INFINITY;
      const responses: string[] = [];
      for (const { path, data, etag } of this.objectsIn(calendar.slug)) {
        const instances = this.instances(data, start, end);
        if (instances.length === 0) continue;
        const payload = expand ? this.expanded(data, instances) : data;
        responses.push(propstat(path, `<d:getetag>${escapeXml(etag)}</d:getetag>${expand ? `<cal:calendar-data><![CDATA[${payload}]]></cal:calendar-data>` : ""}`));
      }
      return multistatus(responses);
    }

    if (request.method === "PUT") {
      if (calendar.readOnly) return new Response("Forbidden", { status: 403 });
      this.beforeWrite?.(url.pathname);
      const existing = this.objects.get(url.pathname);
      if (request.headers.get("if-none-match") === "*" && existing) return new Response("Precondition Failed", { status: 412 });
      const ifMatch = request.headers.get("if-match");
      if (ifMatch && (!existing || existing.etag !== ifMatch)) return new Response("Precondition Failed", { status: 412 });
      const data = await request.text();
      ICAL.Component.fromString(data);
      const etag = this.nextEtag();
      this.objects.set(url.pathname, { data, etag });
      return new Response(null, { status: existing ? 204 : 201, headers: { etag } });
    }

    if (request.method === "DELETE") {
      if (calendar.readOnly) return new Response("Forbidden", { status: 403 });
      this.beforeWrite?.(url.pathname);
      const existing = this.objects.get(url.pathname);
      if (!existing) return new Response("Not found", { status: 404 });
      const ifMatch = request.headers.get("if-match");
      if (ifMatch && existing.etag !== ifMatch) return new Response("Precondition Failed", { status: 412 });
      this.objects.delete(url.pathname);
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed", { status: 405 });
  }

  // Every concrete instance (start/end in epoch ms) of an object overlapping [start, end).
  private instances(data: string, start: number, end: number): Array<{ component: ICAL.Component; recurrenceId?: ICAL.Time; startTime: ICAL.Time; endTime: ICAL.Time }> {
    const root = ICAL.Component.fromString(data);
    for (const timezone of root.getAllSubcomponents("vtimezone")) {
      const zone = new ICAL.Timezone(timezone);
      if (!ICAL.TimezoneService.has(zone.tzid)) ICAL.TimezoneService.register(zone);
    }
    const events = root.getAllSubcomponents("vevent");
    const master = events.find((component) => !component.hasProperty("recurrence-id")) ?? events[0]!;
    const masterEvent = new ICAL.Event(master);
    const overridesById = new Map(events.filter((component) => component !== master).map((component) => [epochOf(component.getFirstPropertyValue("recurrence-id") as ICAL.Time), component]));
    const overlaps = (a: ICAL.Time, b: ICAL.Time) => epochOf(a) < end && epochOf(b) > start;
    const result: Array<{ component: ICAL.Component; recurrenceId?: ICAL.Time; startTime: ICAL.Time; endTime: ICAL.Time }> = [];
    if (!masterEvent.isRecurring()) {
      if (overlaps(masterEvent.startDate, masterEvent.endDate)) result.push({ component: master, startTime: masterEvent.startDate, endTime: masterEvent.endDate });
      return result;
    }
    const iterator = masterEvent.iterator();
    for (let index = 0; index < 5000; index += 1) {
      const next = iterator.next();
      if (!next) break;
      if (epochOf(next) >= end + 366 * 86_400_000) break;
      const override = overridesById.get(epochOf(next));
      if (override) {
        const event = new ICAL.Event(override);
        if (overlaps(event.startDate, event.endDate)) result.push({ component: override, recurrenceId: next, startTime: event.startDate, endTime: event.endDate });
        continue;
      }
      const instanceEnd = next.clone();
      instanceEnd.addDuration(masterEvent.duration);
      if (overlaps(next, instanceEnd)) result.push({ component: master, recurrenceId: next, startTime: next, endTime: instanceEnd });
    }
    return result;
  }

  // iCloud-style expansion: one VEVENT per instance, times in UTC, no RRULE or VTIMEZONE.
  private expanded(data: string, instances: ReturnType<FakeICloud["instances"]>): string {
    const out = new ICAL.Component("vcalendar");
    out.addPropertyWithValue("version", "2.0");
    out.addPropertyWithValue("prodid", "-//Fake iCloud//EN");
    for (const instance of instances) {
      const copy = new ICAL.Component(structuredClone(instance.component.toJSON()));
      copy.removeAllProperties("rrule");
      copy.removeAllProperties("rdate");
      copy.removeAllProperties("exdate");
      copy.removeAllProperties("dtstart");
      copy.removeAllProperties("dtend");
      copy.removeAllProperties("duration");
      copy.removeAllProperties("recurrence-id");
      const startProperty = copy.addPropertyWithValue("dtstart", utcTime(instance.startTime));
      if (instance.startTime.isDate) startProperty.resetType("date");
      const endProperty = copy.addPropertyWithValue("dtend", utcTime(instance.endTime));
      if (instance.endTime.isDate) endProperty.resetType("date");
      if (instance.recurrenceId) {
        const recurrenceProperty = copy.addPropertyWithValue("recurrence-id", utcTime(instance.recurrenceId));
        if (instance.recurrenceId.isDate) recurrenceProperty.resetType("date");
      }
      out.addSubcomponent(copy);
    }
    return out.toString();
  }
}
