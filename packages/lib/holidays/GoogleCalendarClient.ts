import dayjs from "@calcom/dayjs";

import { GOOGLE_HOLIDAY_CALENDARS } from "./constants";

interface GoogleCalendarEvent {
  id: string;
  summary: string;
  description?: string;
  start: {
    date?: string;
    dateTime?: string;
  };
  end: {
    date?: string;
    dateTime?: string;
  };
}

interface GoogleCalendarEventsResponse {
  items?: GoogleCalendarEvent[];
  error?: {
    code: number;
    message: string;
  };
}

export interface GoogleCalendarHoliday {
  id: string;
  countryCode: string;
  eventId: string;
  name: string;
  date: Date;
  year: number;
}

let hasWarnedAboutMissingKey = false;

export class GoogleCalendarClient {
  private apiKey: string | undefined;

  /**
   * A missing key degrades holiday lookups instead of throwing. It used to throw
   * here, but this constructor runs eagerly from `getHolidayService()`, so every
   * caller died on it - including `getSupportedCountries` and `getUserSettings`,
   * which need no key of their own, and the availability calculation, which took
   * booking down with it. Holidays enrich a schedule; they should not be able to
   * break one.
   */
  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.GOOGLE_CALENDAR_API_KEY;
  }

  async fetchHolidays(countryCode: string, year: number): Promise<GoogleCalendarHoliday[]> {
    if (!this.apiKey) {
      if (!hasWarnedAboutMissingKey) {
        hasWarnedAboutMissingKey = true;
        console.warn(
          "GOOGLE_CALENDAR_API_KEY is not set - holiday lookups return nothing. Set it to enable holidays."
        );
      }
      return [];
    }

    const calendarConfig = GOOGLE_HOLIDAY_CALENDARS[countryCode];
    if (!calendarConfig) {
      return [];
    }

    const calendarId = encodeURIComponent(calendarConfig.calendarId);

    const timeMin = dayjs(`${year}-01-01`).startOf("day").toISOString();
    const timeMax = dayjs(`${year}-12-31`).endOf("day").toISOString();

    const url = `https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?key=${this.apiKey}&timeMin=${timeMin}&timeMax=${timeMax}&singleEvents=true&orderBy=startTime`;

    const response = await fetch(url);
    const data: GoogleCalendarEventsResponse = await response.json();

    if (data.error) {
      console.error(`Google Calendar API error for ${countryCode}:`, data.error);
      throw new Error(`Google Calendar API error: ${data.error.message}`);
    }

    if (!data.items) {
      return [];
    }

    return data.items.map((event) => {
      const dateStr = event.start.date || event.start.dateTime?.split("T")[0];
      const date = dateStr ? dayjs(dateStr).toDate() : new Date();

      return {
        id: `${countryCode}_${event.id}`,
        countryCode,
        eventId: event.id,
        name: event.summary,
        date,
        year,
      };
    });
  }
}

let defaultClient: GoogleCalendarClient | null = null;

export function getGoogleCalendarClient(): GoogleCalendarClient {
  if (!defaultClient) {
    defaultClient = new GoogleCalendarClient();
  }
  return defaultClient;
}
