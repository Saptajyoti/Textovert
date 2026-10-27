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
2. In `client/.env`, set `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and `VITE_API_URL` to the Express server origin (default `http://localhost:5000`).
3. In `server/.env`, set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, and `CLIENT_URL`. `CLIENT_URL` accepts a comma-separated list of trusted frontend origins.
4. In Supabase **Authentication → Providers**, enable Email. Configure whether email confirmation is required.
5. In **Authentication → URL Configuration**, add `http://localhost:5173/login` to the allowed redirect URLs. For production, add the deployed frontend's corresponding login URL.
6. The initial schema migration has already been applied for this project. Apply the additive `database/migrations/202610260002_private_conversation_invitations.sql` migration once in the Supabase SQL Editor to enable private invitations. Do not rerun the initial migration or this additive migration after it succeeds; it is an ordered, one-time migration rather than an idempotent script. The new migration wraps its preflight, DDL, and backfill in one transaction. Apply it as the project database owner (`postgres`); the migration assigns its guarded `SECURITY DEFINER` functions to that role. It aborts on usernames outside the supported format, case-insensitive username collisions, private conversations with zero or more than two members, missing creators or non-member roles, or duplicate participant pairs. A valid single-member conversation is left unpaired because its intended recipient cannot be inferred and will not be available through the private messaging API.

The environment variable names and empty placeholders are documented in `client/.env.example` and `server/.env.example`. Use only the publishable key in the browser and server's authenticated Supabase client. A service-role key is not required; never put one in frontend code.

### Authentication behavior

- Registration uses email, password, and a 3–32 character username (lowercase letters, numbers, and underscores). Passwords must be at least 8 characters and match the confirmation field.
- With email confirmation enabled, the username is stored in Supabase Auth metadata during sign-up. The profile row is created after the user confirms and signs in, because an unconfirmed user has no authenticated database session to satisfy the existing profile RLS policy.
- Profile creation runs as the signed-in user under RLS. If a username conflicts with the database's unique constraint, Textovert asks the user to choose another one. Temporary profile setup failures can be retried after sign-in.
- Supabase Auth persists and refreshes sessions in the browser. Authentication-state changes are observed by the app; `/chat` requires a signed-in user and completed profile setup.
- Express protected routes validate the bearer access token with Supabase Auth's `getUser` endpoint. For example, `GET /api/auth/me` returns only the identity verified from that token, never a client-supplied user ID. The server's publishable key is used only for this authenticated verification.
- Messaging REST requests and Socket.IO connections use the current user's access token. The server verifies the token and uses a per-user Supabase client so reads and inserts remain subject to existing RLS policies.
- Private invitations and participant-only username lookup use narrowly scoped `SECURITY DEFINER` RPCs with an empty `search_path`, `auth.uid()` identity checks, authenticated-only execution grants, and a database-enforced per-user search quota. The browser never receives a service-role key or direct access to invitation/pair/quota tables.

## Production deployment

This deployment uses a Vercel static frontend, one Render Web Service for Express and Socket.IO, and the existing Supabase project for Auth and PostgreSQL. These steps configure hosting only: they do not create or alter Supabase data and do not run database migrations. Use a Supabase project whose schema already supports the features you intend to deploy.

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
| `CLIENT_URL` | `https://textovert.vercel.app`; comma-separate additional trusted origins |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key |
| `PORT` | Do not set manually; Render assigns it |

Render Web Services support WebSocket upgrades. The server listens on the assigned `PORT` at `0.0.0.0`; its Socket.IO endpoint uses that same HTTP server. Choose an always-on instance for dependable realtime; sleeping/scale-to-zero services cannot keep WebSockets available. Keep one service instance for now: conversations and rate limits are process-local, so multiple instances need a shared Socket.IO adapter and a distributed rate-limit store before scaling. Platform restarts can still disconnect clients temporarily; the app reconnects and reauthenticates with the current Supabase token.

The Express app trusts the single Render proxy hop so IP-based API rate limits use the client IP forwarded by Render rather than treating all visitors as one address.

Once deployed, note the service URL, such as `https://textovert-api.onrender.com`. Verify `https://<service-host>/api/health` returns `{"status":"ok","service":"textovert-api"}` and `/api/ready` returns `ready`. Health is a liveness check; readiness confirms required configuration but does not test a live Supabase query.

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
| `VITE_API_URL` | `https://textovert-xpff.onrender.com` |
| `VITE_SUPABASE_URL` | The same Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | The same Supabase publishable key |

Set `VITE_API_URL` to the Render origin only; do not append `/api`, because the client adds that path. The currently served `textovert.vercel.app` bundle was found pointing at the old `textovert-hu6f.onrender.com` service. Redeploy Vercel from this repository after correcting the variable. In Render, set `CLIENT_URL` to the exact frontend origin `https://textovert.vercel.app`; do not use a wildcard or a full page URL.

Vite embeds `VITE_*` values into the public frontend at build time. They must never contain a service-role key, database password, or other secret. Redeploy after changing them. For Preview deployments, use a separate test backend/project when possible; do not allow arbitrary preview domains in production `CLIENT_URL`.

### 3. Allow the deployed login redirect in Supabase

In Supabase **Authentication → URL Configuration**, set the Site URL to the canonical Vercel frontend URL and add its `/login` URL to the allowed redirect URLs (for example `https://textovert.vercel.app/login`). Add any custom production domain and its `/login` URL as well. Registration redirects to `/login` on the current frontend origin. Keep email confirmation settings consistent with the production signup experience.

### Environment variable inventory

| Variable | Where | Required | Notes |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Vercel build environment; `client/.env` locally | Yes | Public Supabase project URL |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Vercel build environment; `client/.env` locally | Yes | Browser-safe publishable key, not a service-role key |
| `VITE_API_URL` | Vercel build environment; `client/.env` locally | Yes in production | HTTPS origin of the Render API; localhost fallback is development-only |
| `SUPABASE_URL` | Render service; `server/.env` locally | Yes | Server-side Supabase project URL |
| `SUPABASE_PUBLISHABLE_KEY` | Render service; `server/.env` locally | Yes | Used with each verified user's access token; no service-role key is used |
| `CLIENT_URL` | Render service; `server/.env` locally | Yes in production | Exact trusted frontend origin(s), comma-separated |
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

- Frontend: <http://localhost:5173>
- API health: <http://localhost:5000/api/health>
- API readiness: <http://localhost:5000/api/ready>

The readiness endpoint reports `not_ready` until both server-side Supabase settings are configured. The health endpoint only reports API process health. Protected messaging endpoints require an `Authorization: Bearer <access-token>` header:

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

The server tests include unit checks and static migration security/schema-contract checks. Static checks verify the locking and membership-deletion guard are present; they do not execute concurrent transactions or prove PostgreSQL trigger behavior. They do not replace applying and exercising the migration against a local PostgreSQL/Supabase instance.

## Security and current limitations

- Login and registration use Supabase Auth. Registration profile creation and recovery are subject to the existing profile RLS policies.
- Authenticated users can load paginated history and exchange text messages in conversations where they already have membership. Message inserts use the verified sender identity, require membership, and are persisted under the existing RLS policies.
- The chat screen supports exact-username lookup, invitations, incoming accept/decline, existing conversation detection, and one-to-one conversation lists. Search returns username/display name only, never email or a public profile listing. Exact username lookup can still enable limited username enumeration; it is authenticated and rate-limited both by the API and in the database.
- Attachments, calls, groups, and notifications are not implemented.
- **Private invitations require applying `202610260002_private_conversation_invitations.sql` after reviewing its preflight checks.** The migration preserves the existing policies, adds canonical pair uniqueness and transaction-scoped pair locking, recipient-only acceptance, immutable invitation identity and state-transition guards, membership insert/update/delete guards, and a restrictive policy that prevents messaging until the invite is accepted with exactly two ordinary members. After rejection, only the original inviter can reopen the same invitation; the recipient cannot silently replace the inviter.
- Socket.IO connections are authenticated with Supabase `getUser`; membership is checked before room joins and every message insert. Private broadcasts target only the authorized conversation room.
- `requireAuth` verifies Supabase access tokens with `auth.getUser(token)` and is used by `/api/auth/me`.
- RLS is enabled for all messaging tables. The initial policies allow users to create a conversation and add themselves, but intentionally do not provide invitations, group membership administration, message editing/deletion, public profile discovery, or a trusted receipt-delivery service.
- Profiles are readable and writable only by their owner under the existing schema policies. Passwords are handled by Supabase Auth and are never stored in the profile table.
- Configure `CLIENT_URL` as a comma-separated list of trusted frontend origins in production. Production has no permissive CORS fallback.

## Planned phases

1. Verify the additive migration against a local Supabase database and add live integration tests.
2. Add receipt handling and delivery recovery.
3. Add secure media upload, accessibility review, and deployment configuration.
