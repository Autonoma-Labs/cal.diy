import logger from "@calcom/lib/logger";
import type {
  Calendar,
  CalendarEvent,
  CalendarServiceEvent,
  EventBusyDate,
  GetAvailabilityParams,
  IntegrationCalendar,
  NewCalendarEventType,
} from "@calcom/types/Calendar";
import type { CredentialForCalendarService } from "@calcom/types/Credential";

const log = logger.getSubLogger({ prefix: ["MockCalendarService"] });

/**
 * Announce the mock once per process at warn, the default visible level: an
 * instance serving synthetic calendar data should say so out loud, and debug
 * lines would be invisible under the default minLevel of 4 - which makes "the
 * mock never ran" and "the mock ran silently" impossible to tell apart.
 */
let hasAnnounced = false;
function announceOnce() {
  if (hasAnnounced) return;
  hasAnnounced = true;
  log.warn("MOCK_CALENDAR_SERVICE is set - calendar availability and events are synthetic");
}

/**
 * Busy blocks the mock reports, expressed as offsets from the moment of the
 * request rather than absolute timestamps. Absolute dates would silently go
 * stale - once they fall into the past every slot reads as free and the mock
 * stops exercising the "external calendar blocks a slot" path at all.
 */
const MOCK_BUSY_BLOCKS = [
  { dayOffset: 1, startHourUtc: 12, durationMinutes: 60 },
  { dayOffset: 3, startHourUtc: 15, durationMinutes: 60 },
];

function buildBusyBlock(
  reference: Date,
  { dayOffset, startHourUtc, durationMinutes }: (typeof MOCK_BUSY_BLOCKS)[number]
): EventBusyDate {
  const start = new Date(reference);
  start.setUTCDate(start.getUTCDate() + dayOffset);
  start.setUTCHours(startHourUtc, 0, 0, 0);
  return {
    start,
    end: new Date(start.valueOf() + durationMinutes * 60 * 1000),
    source: "mock-calendar",
    timeZone: "UTC",
  };
}

/**
 * A `Calendar` that answers from fixed data instead of a third-party API.
 *
 * Preview and E2E environments have calendar credentials seeded but no app keys
 * for the provider, so the real service throws while loading them (Google's
 * `getGoogleAppKeys` parses `client_id`/`client_secret` with zod). That failure
 * surfaces as "no availability" and blocks every booking flow. Selected
 * explicitly via MOCK_CALENDAR_SERVICE in `getCalendar` - never inferred from
 * missing keys, so a real misconfiguration still fails loudly in production.
 */
export class MockCalendarService implements Calendar {
  constructor(private readonly credential: CredentialForCalendarService) {}

  getCredentialId(): number {
    return this.credential.id;
  }

  async getAvailability({ dateFrom, dateTo }: GetAvailabilityParams): Promise<EventBusyDate[]> {
    announceOnce();
    const now = new Date();
    const windowStart = new Date(dateFrom).valueOf();
    const windowEnd = new Date(dateTo).valueOf();

    return MOCK_BUSY_BLOCKS.map((block) => buildBusyBlock(now, block)).filter(
      (busy) => new Date(busy.start).valueOf() < windowEnd && new Date(busy.end).valueOf() > windowStart
    );
  }

  async listCalendars(): Promise<IntegrationCalendar[]> {
    return [
      {
        externalId: `mock-calendar-${this.credential.id}`,
        integration: this.credential.type,
        name: "Mock Calendar",
        primary: true,
        readOnly: false,
        credentialId: this.credential.id,
      },
    ];
  }

  async createEvent(event: CalendarServiceEvent, credentialId: number): Promise<NewCalendarEventType> {
    announceOnce();
    const uid = event.uid ?? `mock-event-${credentialId}-${event.startTime}`;
    log.debug("createEvent handled by the mock calendar", { uid });
    return {
      uid,
      id: uid,
      type: this.credential.type,
      password: "",
      url: "",
      additionalInfo: {},
      iCalUID: event.iCalUID ?? uid,
    };
  }

  async updateEvent(uid: string, event: CalendarServiceEvent): Promise<NewCalendarEventType> {
    return this.createEvent(event, this.credential.id).then((created) => ({ ...created, uid, id: uid }));
  }

  async deleteEvent(uid: string, _event: CalendarEvent): Promise<void> {
    log.debug("deleteEvent handled by the mock calendar", { uid });
  }
}
