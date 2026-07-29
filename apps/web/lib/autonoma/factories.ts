import type { FactoryRegistry } from "@autonoma-ai/sdk";
import * as bookings from "./factories/bookings";
import * as eventTypes from "./factories/eventTypes";
import * as integrations from "./factories/integrations";
import * as organization from "./factories/organization";
import * as users from "./factories/users";

/**
 * Every model the entity audit lists gets a factory. Keys are the Prisma model
 * names, which is what the recipe's `create` graph keys on.
 */
export const factories: FactoryRegistry = {
  // Organization & teams
  Team: organization.Team,
  OrganizationSettings: organization.OrganizationSettings,
  ManagedOrganization: organization.ManagedOrganization,
  DSyncData: organization.DSyncData,
  DSyncTeamGroupMapping: organization.DSyncTeamGroupMapping,
  Role: organization.Role,
  RolePermission: organization.RolePermission,
  Attribute: organization.Attribute,
  AttributeOption: organization.AttributeOption,
  AttributeToUser: organization.AttributeToUser,
  IntegrationAttributeSync: organization.IntegrationAttributeSync,
  AttributeSyncRule: organization.AttributeSyncRule,
  AttributeSyncFieldMapping: organization.AttributeSyncFieldMapping,
  TeamBilling: organization.TeamBilling,
  OrganizationBilling: organization.OrganizationBilling,
  SeatChangeLog: organization.SeatChangeLog,
  MonthlyProration: organization.MonthlyProration,
  PlatformBilling: organization.PlatformBilling,
  OrganizationOnboarding: organization.OrganizationOnboarding,
  InternalNotePreset: organization.InternalNotePreset,
  TempOrgRedirect: organization.TempOrgRedirect,
  Avatar: organization.Avatar,

  // Users & profiles
  User: users.User,
  UserPassword: users.UserPassword,
  Profile: users.Profile,
  Membership: users.Membership,
  SecondaryEmail: users.SecondaryEmail,
  Schedule: users.Schedule,
  Availability: users.Availability,
  TravelSchedule: users.TravelSchedule,
  NotificationsSubscriptions: users.NotificationsSubscriptions,
  UserHolidaySettings: users.UserHolidaySettings,
  HolidayCache: users.HolidayCache,
  OutOfOfficeReason: users.OutOfOfficeReason,
  OutOfOfficeEntry: users.OutOfOfficeEntry,
  VerifiedNumber: users.VerifiedNumber,
  VerifiedEmail: users.VerifiedEmail,
  VerificationToken: users.VerificationToken,
  ResetPasswordRequest: users.ResetPasswordRequest,
  Session: users.Session,
  Account: users.Account,
  Feedback: users.Feedback,
  FilterSegment: users.FilterSegment,
  UserFilterSegmentPreference: users.UserFilterSegmentPreference,

  // Event types
  EventType: eventTypes.EventType,
  Host: eventTypes.Host,
  HostGroup: eventTypes.HostGroup,
  HostLocation: eventTypes.HostLocation,
  CalVideoSettings: eventTypes.CalVideoSettings,
  EventTypeCustomInput: eventTypes.EventTypeCustomInput,
  EventTypeTranslation: eventTypes.EventTypeTranslation,
  HashedLink: eventTypes.HashedLink,
  SelectedSlots: eventTypes.SelectedSlots,

  // Bookings
  Booking: bookings.Booking,
  Attendee: bookings.Attendee,
  BookingSeat: bookings.BookingSeat,
  BookingReference: bookings.BookingReference,
  VideoCallGuest: bookings.VideoCallGuest,
  Tracking: bookings.Tracking,
  Payment: bookings.Payment,
  AssignmentReason: bookings.AssignmentReason,
  BookingDenormalized: bookings.BookingDenormalized,
  InstantMeetingToken: bookings.InstantMeetingToken,
  ReminderMail: bookings.ReminderMail,
  BookingInternalNote: bookings.BookingInternalNote,
  AuditActor: bookings.AuditActor,
  BookingAudit: bookings.BookingAudit,
  BookingReport: bookings.BookingReport,
  WrongAssignmentReport: bookings.WrongAssignmentReport,
  Watchlist: bookings.Watchlist,
  WatchlistAudit: bookings.WatchlistAudit,
  WatchlistEventAudit: bookings.WatchlistEventAudit,

  // Apps, credentials & calendars
  App: integrations.App,
  Credential: integrations.Credential,
  WorkspacePlatform: integrations.WorkspacePlatform,
  DelegationCredential: integrations.DelegationCredential,
  SelectedCalendar: integrations.SelectedCalendar,
  DestinationCalendar: integrations.DestinationCalendar,
  CalendarCache: integrations.CalendarCache,
  CalendarCacheEvent: integrations.CalendarCacheEvent,

  // Webhooks, keys & flags
  Webhook: integrations.Webhook,
  WebhookScheduledTriggers: integrations.WebhookScheduledTriggers,
  ApiKey: integrations.ApiKey,
  RateLimit: integrations.RateLimit,
  Feature: integrations.Feature,
  UserFeatures: integrations.UserFeatures,
  TeamFeatures: integrations.TeamFeatures,
  Deployment: integrations.Deployment,

  // Credits & OAuth
  CreditBalance: integrations.CreditBalance,
  CreditPurchaseLog: integrations.CreditPurchaseLog,
  CreditExpenseLog: integrations.CreditExpenseLog,
  PlatformOAuthClient: integrations.PlatformOAuthClient,
  PlatformAuthorizationToken: integrations.PlatformAuthorizationToken,
  AccessToken: integrations.AccessToken,
  RefreshToken: integrations.RefreshToken,
  OAuthClient: integrations.OAuthClient,
  AccessCode: integrations.AccessCode,

  // Misc
  Task: integrations.Task,
  Agent: integrations.Agent,
  CalAiPhoneNumber: integrations.CalAiPhoneNumber,
};
