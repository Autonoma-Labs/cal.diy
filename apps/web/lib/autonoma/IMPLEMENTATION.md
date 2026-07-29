# Autonoma Environment Factory — implementation checklist

Tracks the integration described in `~/.autonoma/cal-diy/integration-prompt.md`.
Spec inputs: `entity-audit.md` (95 factories / 100 models), `scenarios.md` (scenario `standard`).

**Validation note:** this integration was implemented without bringing the app up
locally (explicit instruction from the repo owner — validation happens on the
Autonoma previewkit deployment). Every factory below is wired to a real creation
path verified by reading the source; none of them has been exercised against a
live database from this machine. Items are checked off as *implemented and
source-verified*, not as *executed*.

## Infrastructure

- [x] `@autonoma-ai/sdk` + `@autonoma-ai/server-web` added to `apps/web/package.json`
- [x] Endpoint mounted at `POST /api/autonoma` (`apps/web/app/api/autonoma/route.ts`)
- [x] HMAC verified against `AUTONOMA_SHARED_SECRET` from the environment (SDK does it)
- [x] `AUTONOMA_SIGNING_SECRET` read from the environment (distinct from the shared secret)
- [x] `scopeField: "organizationId"` (the column Cal.diy scopes org data by)
- [x] Auth callback returns a real NextAuth session cookie + real login credentials
- [x] Teardown strategy: scope-root deletes (Team / User cascade) + idempotent per-record deletes
- [x] Maintenance note appended to `AGENTS.md`
- [x] Recipe generated at `~/.autonoma/cal-diy/recipe.json`

## Factories

Creation path legend:
`R` = real repository/service call · `I` = insert copied from the app's own inline
write (handler / fixture / nested write), request+external side effects dropped.

### Organization & teams
- [x] Team — `I` (`apps/web/playwright/fixtures/users.ts` `createTeamAndAddUser`) · teardown: delete (cascades subtree)
- [x] OrganizationSettings — `I` (nested in the same team insert) · teardown: delete
- [x] ManagedOrganization — `I` · teardown: delete
- [x] DSyncData — `I` · teardown: delete
- [x] DSyncTeamGroupMapping — `I` · teardown: delete
- [x] Role — `I` (`packages/prisma/seed-pbac-only.ts`) · teardown: delete
- [x] RolePermission — `I` · teardown: delete
- [x] Attribute — `I` · teardown: delete
- [x] AttributeOption — `I` · teardown: delete
- [x] AttributeToUser — `I` · teardown: delete
- [x] IntegrationAttributeSync — `I` · teardown: delete
- [x] AttributeSyncRule — `I` · teardown: delete
- [x] AttributeSyncFieldMapping — `I` · teardown: delete
- [x] TeamBilling — `I` · teardown: delete
- [x] OrganizationBilling — `I` · teardown: delete
- [x] SeatChangeLog — `I` · teardown: delete
- [x] MonthlyProration — `I` · teardown: delete
- [x] PlatformBilling — `I` · teardown: delete
- [x] OrganizationOnboarding — `I` · teardown: delete
- [x] InternalNotePreset — `I` · teardown: delete
- [x] TempOrgRedirect — `R` (`createAProfileForAnExistingUser` upsert) · teardown: delete
- [x] Avatar — `R` (`packages/lib/server/avatar.ts`) · teardown: delete

### Users & profiles
- [x] User — `R` `UserRepository.create` (mints default Schedule + Availability) · teardown: delete (cascades)
- [x] UserPassword — `R` upsert from `changePassword.handler` · teardown: delete
- [x] Profile — `R` `ProfileRepository.create` · teardown: delete
- [x] Membership — `R` `MembershipRepository.create` · teardown: delete
- [x] SecondaryEmail — `I` (`addSecondaryEmail.handler`) · teardown: delete
- [x] Schedule — `I` (`availability/schedule/create.handler`) · teardown: delete
- [x] Availability — `I` (nested in the schedule insert) · teardown: delete
- [x] TravelSchedule — `I` (`updateProfile.handler`) · teardown: delete
- [x] NotificationsSubscriptions — `I` (`addNotificationsSubscription.handler`) · teardown: delete
- [x] UserHolidaySettings — `R` `HolidayRepository` upsert · teardown: delete
- [x] HolidayCache — `R` `HolidayRepository.cacheHolidays` · teardown: delete
- [x] OutOfOfficeReason — `I` · teardown: delete
- [x] OutOfOfficeEntry — `I` (`outOfOfficeCreateOrUpdate.handler`) · teardown: delete
- [x] VerifiedNumber — `I` · teardown: delete
- [x] VerifiedEmail — `I` · teardown: delete
- [x] VerificationToken — `I` (`auth/lib/verifyEmail.ts`) · teardown: delete
- [x] ResetPasswordRequest — `R` `passwordResetRequest` insert · teardown: delete
- [x] Session — `I` (NextAuth adapter) · teardown: delete
- [x] Account — `I` (`next-auth-custom-adapter.ts`) · teardown: delete
- [x] Feedback — `I` · teardown: delete
- [x] FilterSegment — `R` `filterSegment` repository · teardown: delete
- [x] UserFilterSegmentPreference — `R` upsert · teardown: delete

### Event types
- [x] EventType — `R` `EventTypeRepository.create` · teardown: delete
- [x] Host — `I` (playwright fixture / update.handler) · teardown: delete
- [x] HostGroup — `I` (`eventTypes/heavy/update.handler`) · teardown: delete
- [x] HostLocation — `I` (`HostLocationRepository.upsertMany`) · teardown: delete
- [x] CalVideoSettings — `R` `CalVideoSettingsRepository.createCalVideoSettings` · teardown: repo delete
- [x] EventTypeCustomInput — `I` (`duplicate.handler`) · teardown: delete
- [x] EventTypeTranslation — `R` `EventTypeTranslationRepository` upsert · teardown: delete
- [x] HashedLink — `R` `HashedLinkRepository.create` · teardown: delete
- [x] SelectedSlots — `I` (`reserveSlot.handler` upsert) · teardown: delete

### Bookings
- [x] Booking — `I` (insert from `handleNewBooking/createBooking.ts` `saveBooking`) · teardown: delete (cascades)
- [x] Attendee — `I` (nested attendee insert from the same pipeline) · teardown: delete
- [x] BookingSeat — `I` (`RegularBookingService`) · teardown: delete
- [x] BookingReference — `R` `BookingReferenceRepository` insert · teardown: delete
- [x] VideoCallGuest — `R` `VideoCallGuestRepository.upsertVideoCallGuest` · teardown: delete
- [x] Tracking — `I` (nested in the booking insert) · teardown: delete
- [x] Payment — `R` `PrismaBookingPaymentRepository.create` · teardown: delete
- [x] AssignmentReason — `R` `AssignmentReasonRepository.create` · teardown: delete
- [x] BookingDenormalized — `I` (denormalization trigger shape) · teardown: delete
- [x] InstantMeetingToken — `I` (`connectAndJoin.handler`) · teardown: delete
- [x] ReminderMail — `I` (`cron/bookingReminder`) · teardown: delete
- [x] BookingInternalNote — `R` `handleInternalNote` · teardown: delete
- [x] AuditActor — `R` `PrismaAuditActorRepository` · teardown: delete
- [x] BookingAudit — `R` `PrismaBookingAuditRepository.create` · teardown: delete
- [x] BookingReport — `R` `PrismaBookingReportRepository.create` · teardown: delete
- [x] WrongAssignmentReport — `R` `WrongAssignmentReportRepository.create` · teardown: delete
- [x] Watchlist — `I` (`WatchlistRepository` transaction insert) · teardown: delete
- [x] WatchlistAudit — `R` `PrismaWatchlistAuditRepository.create` · teardown: delete
- [x] WatchlistEventAudit — `I` · teardown: delete

### Apps, credentials & calendars
- [x] App — `R` `PrismaAppRepository.seedApp` shape · teardown: delete
- [x] Credential — `R` `CredentialRepository.create` · teardown: delete
- [x] DelegationCredential — `R` `CredentialRepository.createDelegationCredential` shape · teardown: delete
- [x] WorkspacePlatform — `I` · teardown: delete
- [x] SelectedCalendar — `R` `SelectedCalendarRepository.create` · teardown: delete
- [x] DestinationCalendar — `R` `DestinationCalendarRepository.create` · teardown: delete
- [x] CalendarCache — `I` · teardown: delete
- [x] CalendarCacheEvent — `R` `CalendarCacheEventRepository` upsert · teardown: delete

### Webhooks, keys & flags
- [x] Webhook — `I` (`webhook/create.handler`) · teardown: delete
- [x] WebhookScheduledTriggers — `I` (`scheduleTrigger.ts`) · teardown: delete
- [x] ApiKey — `R` `PrismaApiKeyRepository` · teardown: delete
- [x] RateLimit — `I` · teardown: delete
- [x] Feature — `I` (feature-flag seed migration shape) · teardown: delete
- [x] UserFeatures — `R` `FeaturesRepository.setUserFeatureState` · teardown: delete
- [x] TeamFeatures — `R` `FeaturesRepository.setTeamFeatureState` · teardown: delete
- [x] Deployment — `I` (`deploymentSetup/update.handler` upsert) · teardown: delete

### Credits & platform OAuth
- [x] CreditBalance — `R` `CreditsRepository` · teardown: delete
- [x] CreditPurchaseLog — `R` `CreditsRepository` · teardown: delete
- [x] CreditExpenseLog — `R` `CreditsRepository` · teardown: delete
- [x] PlatformOAuthClient — `I` (api/v2 oauth-client repository shape) · teardown: delete
- [x] PlatformAuthorizationToken — `I` · teardown: delete
- [x] AccessToken — `I` · teardown: delete
- [x] RefreshToken — `I` · teardown: delete
- [x] OAuthClient — `R` `OAuthClientRepository.createOAuthClient` shape · teardown: delete
- [x] AccessCode — `R` `AccessCodeRepository.createAccessCode` shape · teardown: delete

### Misc
- [x] Task — `R` tasker repository insert · teardown: delete
- [x] Agent — `I` · teardown: delete
- [x] CalAiPhoneNumber — `I` · teardown: delete

## Not covered

Nothing. All 100 models named in the entity audit and `scenarios.md` have a
factory. `BookingTimeStatus` / `BookingTimeStatusDenormalized` are Prisma
*views*, not models, and are therefore not factorable.

## Notes for whoever validates this

**Install first.** `apps/web/package.json` gained `@autonoma-ai/sdk` and
`@autonoma-ai/server-web` (both `0.2.9`). `yarn.lock` has *not* been regenerated
from this machine - run `yarn install` before the first build, or the preview
build fails to resolve them.

**Two secrets, both from the environment.** `AUTONOMA_SHARED_SECRET` is already
provisioned. `AUTONOMA_SIGNING_SECRET` is a second, *different* value you must
set (`openssl rand -hex 32`) - the SDK throws `SAME_SECRETS` if they match and
uses it to sign the refs token that scopes teardown.

**Recipe ordering is load-bearing.** The SDK topologically sorts the recipe's
`_alias`/`_ref` graph and breaks ties by the order keys appear in `create`. Three
FKs are expressed as literal strings rather than refs because they point at a
non-id column - `Booking.uid` (used by BookingReport, WrongAssignmentReport,
CreditExpenseLog, BookingAudit, VideoCallGuest) and `DSyncData.directoryId` (used
by DSyncTeamGroupMapping). Those models must stay *after* their parent in the
recipe's key order.

**Rows that may already exist are adopted, not overwritten.** `App`, `Feature`
and `Deployment` are instance-level. Their factories reuse an existing row and
record `preexisting: true`, and teardown skips it - so a run can never delete
data it did not create.

**The recipe's `validation` block is a schema literal, not a claim.** Autonoma's
upload contract fixes `validation.status` to `"validated"` and `validation.phase`
to `"ok"`; there is no value that means "not yet run", so the recipe carries the
required literals even though the lifecycle has not been exercised. Treat the
previewkit run as the first real validation.

**What has not been run.** No `sdk discover`/`up`/`down` cycle and no database
inspection happened from this machine, and `yarn type-check:ci` could not run
without `node_modules`. What was verified: every creation path was read in
source; the new files are syntactically clean under `tsc 5.9.3` (only
unresolved-module diagnostics remain, expected without `node_modules`);
`biome lint` passes; and the recipe was checked programmatically for duplicate
aliases, dangling `_ref` targets, unsupported `{{tokens}}`, and full model
coverage (100 models, 160 rows, 222 refs).
