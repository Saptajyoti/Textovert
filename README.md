# Textovert

Textovert is a responsive messaging-app foundation with a calm, glass-inspired interface. It includes Supabase email/password authentication, protected account pages, an authenticated Express API, and Socket.IO-based text messaging for conversations the signed-in user is authorized to access.

## Stack

- **Client:** React, Vite, JavaScript, Tailwind CSS v4, React Router, Framer Motion, Lucide, Supabase JS, Axios, Socket.IO client
- **Server:** Node.js, Express, Socket.IO, Supabase JS, Helmet, CORS, express-rate-limit
- **Data:** Supabase Postgres with Row Level Security policies in `database/migrations`

## Project structure

```text
client/                 React application
  src/components/       Shared UI and protected routes
  src/contexts/         Supabase authentication state
  src/features/         Feature-specific data and UI
  src/lib/              Supabase client
  src/pages/            Landing, login, registration, authenticated chat
server/                 Express and Socket.IO service
  src/config/           Environment-driven configuration
  src/middleware/       Error handling and Supabase token verification
  src/routes/           Authenticated identity, conversation history, health, and readiness endpoints
  src/realtime/         Socket token verification and message authorization
  src/sockets/          Authenticated private conversation rooms
database/migrations/    SQL schema and RLS policies
```

## Prerequisites

- Node.js 20.19+ or 22.12+ (Vite 7 requirement)
- npm 10+
- A Supabase project to enable authentication and database access (optional for the local visual preview)

## Install

From the repository root in PowerShell:

```powershell
npm install
Copy-Item client\.env.example client\.env
Copy-Item server\.env.example server\.env
```

The `.env` files contain placeholders and are ignored by Git. Edit them locally to configure the project. Do not commit credentials.

### Configure Supabase

In the Supabase dashboard:

1. Create a Supabase project and copy its project URL and **publishable key** (formerly the anon/public key).
2. In `client/.env`, set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_API_URL` to the Express server's local origin. Configure the API origin explicitly; the frontend has no hardcoded local or production API fallback.
3. In `server/.env`, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and `CLIENT_URL`. `CLIENT_URL` accepts a comma-separated list of trusted frontend origins. The API has no implicit browser-origin allowlist; configure it explicitly for local development and deployment.
4. In Supabase **Authentication → Providers**, enable Email. Configure whether email confirmation is required.
5. In **Authentication → URL Configuration**, add the local frontend's `/login` URL and the deployed frontend's corresponding `/login` URL to the allowed redirect URLs.
6. The initial schema migration has already been applied for this project. Apply the additive `database/migrations/202610260002_private_conversation_invitations.sql` migration once in the Supabase SQL Editor to enable private invitations. Do not rerun the initial migration or this additive migration after it succeeds; it is an ordered, one-time migration rather than an idempotent script. The new migration wraps its preflight, DDL, and backfill in one transaction. Apply it as the project database owner (`postgres`); the migration assigns its guarded `SECURITY DEFINER` functions to that role. It aborts on usernames outside the supported format, case-insensitive username collisions, private conversations with zero or more than two members, missing creators or non-member roles, or duplicate participant pairs. A valid single-member conversation is left unpaired because its intended recipient cannot be inferred and will not be available through the private messaging API.
7. After migration `202610260002_private_conversation_invitations.sql` has succeeded, apply `database/migrations/202610270001_realtime_presence_read_receipts.sql` once in the Supabase SQL Editor as `postgres`. This additive transaction backfills the existing `message_receipts` table, creates delivered receipts for future messages, adds sender-only receipt reads, and installs authenticated RPCs for marking messages read and listing authorized private-conversation partners. Do not rerun it after it succeeds.
8. After `202610270001_realtime_presence_read_receipts.sql` succeeds, apply `database/migrations/202610270002_rich_messaging.sql` once in the Supabase SQL Editor as `postgres`. It adds optional reply/attachment fields, a normalized reaction table, and a private `conversation-media` Storage bucket with a 10 MiB size cap and supported MIME allowlist. It does not insert an authenticated Storage upload policy: uploads go through the authenticated backend so it can validate file contents before using its server-only storage credential. Private reads use signed URLs, and users may delete only their own uploaded objects.
9. After `202610270002_rich_messaging.sql` succeeds, apply `database/migrations/202610270003_notifications.sql` once as `postgres`. It adds user-scoped notification preferences/history and push subscriptions, a receipt-backed unread-count RPC/index, idempotent message/invitation notification triggers, and marks message notifications read with the existing authorized read-receipt RPC. It is additive and must not be rerun.
10. After `202610270003_notifications.sql` succeeds, apply `database/migrations/202610270004_group_chats.sql` once as `postgres`. It adds group description/avatar metadata, member/admin RPCs, group-specific access checks, group notifications/mutes, and extends read receipts, reactions, and private media authorization to groups. It is additive and must not be rerun. After it succeeds, verify in SQL Editor:

   ```sql
   select
     to_regclass('public.conversation_notification_mutes') as mute_table,
     to_regprocedure('public.can_access_conversation(uuid)') as access_function,
     to_regprocedure('public.create_group_conversation(text,text,text,uuid[])') as create_function,
     to_regprocedure('public.list_my_group_conversations()') as list_function;
   ```

   Each result must be non-null. Do not mark the migration applied until the SQL Editor reports success and the verification query returns all four objects.

The environment variable names and empty placeholders are documented in `client/.env.example` and `server/.env.example`. Use only the publishable key in the browser and server's authenticated Supabase client. `SUPABASE_SERVICE_ROLE_KEY` is additionally used by the server for private media uploads and trusted push-subscription delivery; normal authenticated database reads and writes do not use it. Never put this key in frontend code or Vercel environment variables.

### Authentication behavior

- Registration uses email, password, and a 3–32 character username (lowercase letters, numbers, and underscores). Passwords must be at least 8 characters and match the confirmation field.
- With email confirmation enabled, the username is stored in Supabase Auth metadata during sign-up. The profile row is created after the user confirms and signs in, because an unconfirmed user has no authenticated database session to satisfy the existing profile RLS policy.
- Profile creation runs as the signed-in user under RLS. If a username conflicts with the database's unique constraint, Textovert asks the user to choose another one. Temporary profile setup failures can be retried after sign-in.
- Supabase Auth persists and refreshes sessions in the browser. Authentication-state changes are observed by the app; `/chat` requires a signed-in user and completed profile setup.
- Express protected routes validate the bearer access token with Supabase Auth's `getUser` endpoint. For example, `GET /api/auth/me` returns only the identity verified from that token, never a client-supplied user ID. The server's publishable key is used only for this authenticated verification.
- Messaging REST requests and Socket.IO connections use the current user's access token. The server verifies the token and uses a per-user Supabase client so reads and inserts remain subject to existing RLS policies.
- Media uploads are sent to the authenticated Express API with progress reporting. The API checks conversation membership, filename, MIME, size, and file signature/container before uploading with `SUPABASE_SERVICE_ROLE_KEY`. The key is server-only and never reaches the browser; keep it only in local `server/.env` and Render's secret environment configuration.
- Unread counts are computed from the existing per-recipient `message_receipts`, grouped in a restricted database function; no message history is loaded to count unread messages. Notifications are persisted without message text and limited by RLS to their recipient.
- Optional true Web Push uses a root-scoped service worker, browser-owned subscriptions, and server-side VAPID credentials. The app asks browser permission only after a user enables the setting. The default push text omits message contents; previews require an explicit preference. Active Socket.IO alerts and page-open browser notifications are separate from Web Push delivery.
- Private invitations and participant-only username lookup use narrowly scoped `SECURITY DEFINER` RPCs with an empty `search_path`, `auth.uid()` identity checks, authenticated-only execution grants, and a database-enforced per-user search quota. The browser never receives a service-role key or direct access to invitation/pair/quota tables.
- Group creation/member changes/settings are performed by authenticated, `auth.uid()`-scoped database RPCs. The creator starts as an admin; an admin can promote another member. The final admin cannot be removed, and when they leave the group is transferred to the earliest-joined remaining member, or the group is deleted when they are the sole member.
- Group avatar images are optional HTTPS image URLs. Group members can mute only their own group notifications; muted groups retain messages and unread counts but do not create message-alert entries or send message pushes to that user.

## Production deployment

This deployment uses a Vercel static frontend, one Render Web Service for Express and Socket.IO, and the existing Supabase project for Auth and PostgreSQL. These steps configure hosting only: they do not run database migrations. Apply the ordered migrations described above in Supabase before deploying the real-time feature changes.

### 1. Deploy the API to Render

Choose the final Vercel project URL or custom domain first; Render's `CLIENT_URL` must exactly match it. You can create the Vercel project to reserve its domain, then create the Render **Web Service** from this repository. Because the npm lockfile and workspaces are at the repository root, use these settings:

| Render setting | Value |
| --- | --- |
| Root Directory | repository root (`.`) |
| Runtime | Node 22.12+ (or Node 20.19+) |
| Build Command | `npm ci` |
| Start Command | `npm run start --workspace server` |
| Health Check Path | `/api/health` |

Add these environment variables to the service:

| Variable | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `CLIENT_URL` | The exact Vercel frontend origin; comma-separate additional trusted origins |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role/secret key; required for validated media uploads and server-side push delivery. Add it as a Render secret and never to Vercel. |
| `VAPID_PUBLIC_KEY` | VAPID public key; required only for optional browser Web Push. The authenticated API provides it to subscribed browsers. |
| `VAPID_PRIVATE_KEY` | VAPID private key; required only for optional Web Push. Render secret only; never expose or commit it. |
| `VAPID_SUBJECT` | Contact URI for the VAPID application identity, e.g. an owner-controlled `mailto:` or HTTPS URL. |
| `PORT` | Do not set manually; Render assigns it |

Render Web Services support WebSocket upgrades. The server listens on the assigned `PORT` at `0.0.0.0`; its Socket.IO endpoint uses that same HTTP server. Choose an always-on instance for dependable realtime; sleeping/scale-to-zero services cannot keep WebSockets available. Keep one service instance for now: conversations and rate limits are process-local, so multiple instances need a shared Socket.IO adapter and a distributed rate-limit store before scaling. Platform restarts can still disconnect clients temporarily; the app reconnects and reauthenticates with the current Supabase token.

The Express app trusts the single Render proxy hop so IP-based API rate limits use the client IP forwarded by Render rather than treating all visitors as one address.

Once deployed, copy the Render service origin from its dashboard. Verify `<render-service-origin>/api/health` returns `{"status":"ok","service":"textovert-api"}` and `<render-service-origin>/api/ready` returns `ready`. Health is a liveness check; readiness confirms the required Supabase keys, media-storage credential, and configured browser origin but does not test a live Supabase query.

### 2. Deploy the frontend to Vercel

Import the same repository and use these project settings:

| Vercel setting | Value |
| --- | --- |
| Root Directory | repository root (`.`) |
| Framework Preset | Other |
| Install Command | `npm ci --include=dev` |
| Build Command | `npm run build` |
| Output Directory | `client/dist` |

The root `vercel.json` sends browser routes such as `/chat` back to the Vite app, so refreshing a route does not return a static-host 404. Add these environment variables for the Production environment:

| Variable | Value |
| --- | --- |
| `VITE_API_URL` | The Render service origin only |
| `VITE_SUPABASE_URL` | The same Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The same Supabase publishable key |

Set `VITE_API_URL` to the Render origin only; do not append `/api`, because the client adds that path. In Render, set `CLIENT_URL` to the exact frontend origin configured for the Vercel project; do not use a wildcard or a full page URL.

Vite embeds `VITE_*` values into the public frontend at build time. They must never contain a service-role key, database password, or other secret. Redeploy after changing them. For Preview deployments, use a separate test backend/project when possible; do not allow arbitrary preview domains in production `CLIENT_URL`.

The frontend includes an installable PWA manifest and app icons. Vercel serves the root-scoped service worker over HTTPS; it supports the existing Web Push flow, takes control promptly on updates, and deliberately does not cache application/API responses or private data. The app checks for worker updates on startup, when a visible tab returns, and hourly. An install button appears only when the browser offers its native install prompt. When the device is offline, Textovert shows a connection-lost notice; messaging and uploads still require a live connection and are not queued offline.

### 3. Allow the deployed login redirect in Supabase

In Supabase **Authentication → URL Configuration**, set the Site URL to the canonical Vercel frontend URL and add its `/login` URL to the allowed redirect URLs. Add any custom production domain and its `/login` URL as well. Registration redirects to `/login` on the current frontend origin. Keep email confirmation settings consistent with the production signup experience.

### Environment variable inventory

| Variable | Where | Required | Notes |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Vercel build environment; `client/.env` locally | Yes | Public Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vercel build environment; `client/.env` locally | Yes | Browser-safe publishable key, not a service-role key |
| `VITE_API_URL` | Vercel build environment; `client/.env` locally | Yes | Explicit API origin; HTTPS is enforced in production |
| `SUPABASE_URL` | Render service; `server/.env` locally | Yes | Server-side Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Render service; `server/.env` locally | Yes | Used with each verified user's access token for normal authenticated database access |
| `SUPABASE_SERVICE_ROLE_KEY` | Render service; `server/.env` locally | Yes for media and Web Push delivery | Server-only secret for validated private media uploads and trusted push subscription delivery. Never add it to Vercel or a `VITE_*` variable. |
| `VAPID_PUBLIC_KEY` | Render service; `server/.env` locally | Optional | Required only to enable true browser Web Push; returned to authenticated clients through the API, not a Vite variable |
| `VAPID_PRIVATE_KEY` | Render service; `server/.env` locally | Optional | VAPID signing secret; keep only in Render/server environment |
| `VAPID_SUBJECT` | Render service; `server/.env` locally | Optional | Owner-controlled VAPID contact URI; required together with both VAPID keys |
| `CLIENT_URL` | Render service; `server/.env` locally | Yes | Exact trusted frontend origin(s), comma-separated; no implicit allowlist |
| `NODE_ENV` | Render service | Yes | Set to `production` |
| `PORT` | Assigned by Render | Platform-provided | Do not hard-code or override in Render |

Supabase JS persists browser sessions, refreshes access tokens, and observes auth changes. REST calls obtain the current session token; Socket.IO authenticates its handshake with that token and reconnects with a refreshed token. The API validates tokens with Supabase Auth and uses the verified user's identity for database access. All production frontend-to-API traffic must use HTTPS.

## Run locally

Run both applications from the root:

```powershell
npm run dev
```

Or start them separately in two PowerShell terminals:

```powershell
npm run dev:client
npm run dev:server
```

- Use the frontend and API origins printed/configured for your local Vite and Express processes. Set `VITE_API_URL` to the Express origin and `CLIENT_URL` to the Vite origin in their respective `.env` files; the application does not supply implicit localhost URL defaults.
- Check `/api/health` and `/api/ready` on the configured API origin.

The readiness endpoint reports `not_ready` until `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, and at least one valid `CLIENT_URL` are configured. The health endpoint only reports API process health; readiness does not test a live Supabase query. Protected messaging endpoints require an `Authorization: Bearer <access-token>` header:

- `GET /api/conversations` — accepted private conversations for the signed-in user
- `GET /api/conversations/users/lookup?username=<exact-username>` — limited profile discovery
- `GET /api/conversations/invitations` — incoming pending invitations
- `POST /api/conversations/invitations` with `{ "username": "..." }` — send or reuse an invitation
- `POST /api/conversations/invitations/:id/accept` and `/reject` — respond as the intended recipient
- `GET /api/conversations/:id/messages` — authorized, paginated history

## Validate

```powershell
npm run lint
npm run build
npm run test --workspace server
```

The server tests include unit checks for socket presence/typing, upload and push-endpoint validation, and static migration security/schema-contract checks. Static SQL checks do not execute PostgreSQL triggers/RLS policies, browser permission flows, service-worker delivery, external push services, or Storage behavior. They do not replace applying and exercising migrations against a local PostgreSQL/Supabase instance.

## Security and current limitations

- Login and registration use Supabase Auth. Registration profile creation and recovery are subject to the existing profile RLS policies.
- Authenticated users can load paginated history and exchange text messages in conversations where they already have membership. Message inserts use the verified sender identity, require membership, and are persisted under the existing RLS policies.
- The chat screen supports exact-username lookup, invitations, incoming accept/decline, group creation/settings/member management, and mixed private/group conversation lists. Search returns username/display name/avatar only, never email or a public profile listing. Exact username lookup can still enable limited username enumeration; it is authenticated and rate-limited in the database.
- **Private invitations require applying `202610260002_private_conversation_invitations.sql` after reviewing its preflight checks.** The migration preserves the existing policies, adds canonical pair uniqueness and transaction-scoped pair locking, recipient-only acceptance, immutable invitation identity and state-transition guards, membership insert/update/delete guards, and a restrictive policy that prevents messaging until the invite is accepted with exactly two ordinary members. After rejection, only the original inviter can reopen the same invitation; the recipient cannot silently replace the inviter.
- Socket.IO connections are authenticated with Supabase `getUser`; membership is checked before room joins, typing, read/reaction actions, and every message insert. Broadcasts target authorized conversation rooms, and removed group members' connected sockets are evicted from the room.
- `requireAuth` verifies Supabase access tokens with `auth.getUser(token)` and is used by `/api/auth/me`.
- RLS is enabled for all messaging tables. Read state is persisted in the existing `message_receipts` table. The authenticated recipient-only RPC changes only delivered receipts for incoming messages in an authorized conversation; senders can read receipt status only for their own messages. Group receipts show how many recipients have read a sent message.
- Unread message counts group delivered receipts by authorized conversation using an indexed database function; reading one conversation clears only its receipts and message notifications. Counts and notification history persist and reconcile across refreshes/devices.
- **Notifications require `202610270003_notifications.sql` after the invitation, read-receipt, and rich-messaging migrations above.** It creates recipient-only notification history/preferences and push-subscription rows and adds idempotent database triggers for incoming messages and invitation state changes. No migration has been applied by this code change; apply and verify it in the intended Supabase project before deploying.
- **Group chats require `202610270004_group_chats.sql` after the notifications migration.** The migration adds narrowly scoped group-management RPCs and enforces group membership for messages, reactions, media, receipts, and notification access. Admins can add/remove members and promote admins; a final admin is automatically transferred to the earliest-joined remaining member on leave. Group notification muting is per-user. Apply it in Supabase SQL Editor as `postgres`; this repository change does not apply or verify it against a live project.
- The notification panel supports persistent message/invitation entries, individual and bulk read actions, category preferences, and localized timestamps. Message bodies are not stored in notification payloads. Sounds are generated briefly with Web Audio and may be blocked by browser policy without affecting messaging.
- True Web Push is optional and requires `SUPABASE_SERVICE_ROLE_KEY` plus `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` on Render. From the repository root, generate a pair with `npx web-push generate-vapid-keys`; use an owner-controlled `mailto:` or HTTPS contact URI for the subject. Store the private key only as a Render secret. Browser permission is requested only when the user explicitly enables the setting; without VAPID configuration, in-app notifications, unread counts, preferences, and sounds still work.
- Socket.IO events update open tabs/devices; Web Push is separately sent to registered service-worker subscriptions when the app is backgrounded or closed. The default push text omits message content; previews require an explicit preference. Push delivery is best-effort for each event if the provider/network is unavailable, while persisted notification history and unread counts remain available. For multiple API instances, add a shared Socket.IO adapter/state store so real-time notifications and visible-conversation suppression are consistent.
- **Rich messaging requires `202610270002_rich_messaging.sql` after `202610270001_realtime_presence_read_receipts.sql`.** This migration is additive and one-time. It adds same-conversation reply enforcement, a normalized reaction table with per-user uniqueness and RLS, and the private Storage bucket/policies. Apply it in the Supabase SQL Editor as `postgres`; do not rerun it.
- Media support is limited to JPEG, PNG, WebP, PDF, UTF-8 TXT, DOCX, and XLSX, up to 10 MiB each. Express validates signatures and Office ZIP contents before using the server-only Storage credential. Supabase Storage applies the private bucket size/MIME constraints. Changing limits or file types requires coordinated updates to the client allowlist, server validation, and bucket settings/migration.
- Attachment downloads and inline image access use signed URLs valid for five minutes. Message records store metadata and a private object path, never binary data or permanent public URLs. Orphaned uploads can remain if the client loses its connection after upload but before message persistence; they are inaccessible to non-members and should be removed through a future retention cleanup job.
- Message deletion is intentionally not exposed: the existing schema has no safe per-user deletion model. Copy, replies, reactions, search, attachments, and read receipts are supported; message text is not edited or deleted by this phase.
- Presence uses authenticated sockets and a process-local connection count. This is correct for the documented single Render instance and across the user's tabs/devices connected to that instance. Before running multiple backend instances, add a shared Socket.IO adapter and move presence/typing state to a distributed store (for example Redis); otherwise online status and typing indicators can differ between instances.
- Typing events are transient, membership-checked, rate-limited, and expire after inactivity. They are never stored in PostgreSQL.
- Deploying rich messaging, notifications, and groups requires applying `202610270001_realtime_presence_read_receipts.sql`, `202610270002_rich_messaging.sql`, `202610270003_notifications.sql`, and `202610270004_group_chats.sql` in order after `202610260002_private_conversation_invitations.sql`, setting the existing `SUPABASE_SERVICE_ROLE_KEY` on Render, and redeploying the API and frontend. VAPID configuration is optional; no new Vercel environment variable is required.
- Profiles are readable and writable only by their owner under the existing schema policies. Passwords are handled by Supabase Auth and are never stored in the profile table.
- Configure `CLIENT_URL` as a comma-separated list of trusted frontend origins in production. Production has no permissive CORS fallback.

## Manual real-time verification

1. Apply the migrations in order in Supabase SQL Editor as `postgres`: `202610270001_realtime_presence_read_receipts.sql`, `202610270002_rich_messaging.sql`, `202610270003_notifications.sql`, then `202610270004_group_chats.sql`. Verify the group RPCs and mute table exist before deploying. Set `SUPABASE_SERVICE_ROLE_KEY` on Render and redeploy the API and frontend. To exercise Web Push, also configure all three VAPID variables on Render; no Vercel secret is needed.
2. Sign in as two users on separate browsers/devices with an accepted private conversation. Send messages in both directions; verify only incoming messages increment the correct unread badge, opening one chat clears only its count, and counts survive refresh, sign-out/in, offline delivery, and reconnects.
3. Keep the receiver's chat closed or browser offline and send a message. Verify the in-app notification is persisted, contains no message text, updates other active tabs, and can navigate to the correct conversation. Test invitation and acceptance notifications too.
4. In Settings, change in-app, message, invitation, sound, preview, and while-open options; verify the behavior after refresh and on another active device. Enable browser notifications with an explicit click, grant permission, close/background the page, send an incoming event, and click the browser notification to navigate. Also test denied permission and unsupported browser behavior.
5. With permission granted, verify no browser alert is sent while that conversation is visibly open unless the while-open preference is enabled. Confirm the sound is brief, respects settings, does not play for your own messages, and is not duplicated across tabs.
6. Confirm a third signed-in user without membership cannot see another user's notification history, unread counts, preferences, or push subscriptions. Disable push and sign out; confirm the current browser subscription is removed.
7. Create a group with three signed-in users using distinct browsers/devices. Verify the creator is an admin, all selected users see the group, messages arrive in real time, history persists after refresh/sign-out/in, sender names/avatars are correct, and read/typing/reaction/reply/attachment behavior works.
8. Promote a member, add a fourth user, remove a non-admin, and verify an unauthorized user cannot load group messages or join its Socket.IO room. Remove a member while they are connected and verify their socket is evicted and subsequent sends fail.
9. Verify only admins can edit details, add/remove/promote members, the last admin cannot be removed, and when the sole admin leaves the earliest-joined remaining member becomes admin. Leave a single-member group and verify the empty group is deleted.
10. Mute one user's group and verify their message alerts/push are suppressed while unread counts and group messages still work; other members should still receive alerts. Regression-check private messaging, authentication, online/offline status, typing, read receipts, invitations, replies, reactions, image/file upload/download, message search, and copy controls.
