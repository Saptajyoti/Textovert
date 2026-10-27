const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const migrationPath = join(__dirname, '..', '..', 'database', 'migrations', '202610260002_private_conversation_invitations.sql')
const initialMigrationPath = join(__dirname, '..', '..', 'database', 'migrations', '202610260001_initial_schema.sql')
const migration = readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').trim().toLowerCase()
const initialMigration = readFileSync(initialMigrationPath, 'utf8').replace(/\s+/g, ' ').toLowerCase()

test('static SQL contract: canonical user pairs are unique and pair creation is transaction-serialized', () => {
  assert.match(migration, /^-- apply once as the postgres role\. the transaction makes preflight\/ddl\/backfill atomic\. begin;/)
  assert.match(migration, /commit;$/)
  assert.match(migration, /primary key \(user_low_id, user_high_id\)/)
  assert.match(migration, /check \(user_low_id < user_high_id\)/)
  assert.match(migration, /pg_advisory_xact_lock\(/)
  assert.match(migration, /hashtextextended\(v_low_id::text \|\| ':' \|\| v_high_id::text, 0\)/)
  assert.doesNotMatch(migration, /delete from public\.conversations/)
})

test('static SQL contract: private membership insert, update, and delete paths preserve invariants', () => {
  assert.match(migration, /before insert or update or delete on public\.conversation_members/)
  assert.match(migration, /private conversation memberships cannot be deleted independently/)
  assert.match(migration, /private conversation memberships cannot be updated/)
  assert.match(migration, /memberships cannot be moved into a private conversation/)
  assert.match(migration, /new\.user_id not in \(v_pair\.user_low_id, v_pair\.user_high_id\)/)
  assert.match(migration, /new\.role <> 'member'/)
  assert.match(migration, /v_invitation\.status <> 'pending'/)
  assert.match(migration, /v_invitation\.recipient_id <> new\.user_id/)
  assert.match(migration, /a pending private conversation must have exactly one inviter/)
})

test('static SQL contract: membership cascades do not create a direct delete path', () => {
  assert.match(migration, /if not found or v_kind <> 'private' or pg_catalog\.pg_trigger_depth\(\) > 1 then return old/)
  assert.match(initialMigration, /revoke all privileges on table[\s\S]*public\.conversation_members/)
  assert.match(initialMigration, /grant insert \(conversation_id, user_id\)[\s\S]*on public\.conversation_members to authenticated/)
  assert.doesNotMatch(initialMigration, /grant delete[\s\S]*on public\.conversation_members/)
})

test('static SQL contract: only the intended recipient can accept or reject immutable invitation identity', () => {
  assert.match(migration, /before insert or update or delete on public\.private_conversation_invitations/)
  assert.match(migration, /new\.inviter_id is distinct from old\.inviter_id/)
  assert.match(migration, /new\.recipient_id is distinct from old\.recipient_id/)
  assert.match(migration, /new\.conversation_id is distinct from old\.conversation_id/)
  assert.match(migration, /and \(select auth\.uid\(\)\) = old\.recipient_id/)
  assert.match(migration, /old\.status = 'pending' and new\.status in \('accepted', 'rejected'\)/)
  assert.match(migration, /the requested private invitation state transition is not authorized/)
  assert.match(migration, /old\.status = 'rejected' and new\.status = 'pending'/)
  assert.match(migration, /and \(select auth\.uid\(\)\) = old\.inviter_id/)
})

test('static SQL contract: acceptance requires exactly two ordinary members; accepted memberships cannot be changed', () => {
  assert.match(migration, /an accepted private conversation must contain exactly its two ordinary participants/)
  assert.match(migration, /v_member_count <> 2/)
  assert.match(migration, /cm\.user_id = new\.inviter_id and cm\.role = 'member'/)
  assert.match(migration, /cm\.user_id = new\.recipient_id and cm\.role = 'member'/)
  assert.match(migration, /private conversation memberships cannot be updated/)
  assert.match(migration, /private conversation memberships cannot be deleted independently/)
})

test('static SQL contract: accepted private access also requires canonical pair membership and ordinary roles', () => {
  assert.match(migration, /create policy "only accepted private participants can access messages" on public\.messages as restrictive/)
  assert.match(migration, /public\.can_access_private_conversation\(c\.id\)/)
  assert.match(migration, /i\.status = 'accepted'/)
  assert.match(migration, /i\.inviter_id = p\.user_low_id and i\.recipient_id = p\.user_high_id/)
  assert.match(migration, /cm\.role <> 'member'/)
  assert.match(migration, /create policy "private conversation details require membership" on public\.conversations as restrictive/)
  assert.match(migration, /create policy "private conversations must use invitation workflow" on public\.conversations as restrictive for insert/)
  assert.match(initialMigration, /create policy "members can read messages in their conversations"/)
  assert.match(initialMigration, /create policy "members can send messages as themselves"/)
  assert.match(initialMigration, /create policy "members can read their conversations"/)
  assert.match(initialMigration, /create policy "authenticated users can create conversations"/)
})

test('static SQL contract: pair creation derives both identities from the verified user and exact profile match', () => {
  assert.match(migration, /v_user_id uuid := \(select auth\.uid\(\)\)/)
  assert.match(migration, /where pg_catalog\.lower\(p\.username\) = pg_catalog\.lower\(pg_catalog\.btrim\(p_username\)\)/)
  assert.match(migration, /values \(v_conversation_id, v_user_id, 'member'\)/)
  assert.match(migration, /values \(v_conversation_id, v_user_id, v_target\.id\)/)
})

test('static SQL contract: case-insensitive usernames reject existing ambiguity and stay unique', () => {
  assert.match(migration, /where p\.username !~ '\^\[a-za-z0-9_\]\{3,32\}\$'/)
  assert.match(migration, /group by pg_catalog\.lower\(p\.username\) having pg_catalog\.count\(\*\) > 1/)
  assert.match(migration, /create unique index profiles_username_case_insensitive_uidx on public\.profiles \(pg_catalog\.lower\(username\)\)/)
  assert.match(migration, /private_username_lookup_limits/)
  assert.match(migration, /return v_attempts <= 30/)
  assert.equal((migration.match(/if not public\.consume_private_username_lookup_quota\(\)/g) || []).length, 2)
})

test('static SQL contract: migration backfill preserves complete pairs and rejects malformed memberships', () => {
  assert.match(migration, /having pg_catalog\.count\(cm\.user_id\) not between 1 and 2/)
  assert.match(migration, /not pg_catalog\.bool_or\(cm\.user_id = c\.created_by\)/)
  assert.match(migration, /pg_catalog\.bool_or\(cm\.role <> 'member'\)/)
  assert.match(migration, /backfill only complete pairs/)
  assert.match(migration, /having pg_catalog\.count\(\*\) = 2/)
  assert.match(migration, /cannot migrate duplicate private conversations for the same pair of users/)
})

test('static SQL contract: lookup returns only minimal profile data and private tables have no direct grants', () => {
  assert.match(migration, /revoke all privileges on table public\.private_conversation_pairs, public\.private_conversation_invitations, public\.private_username_lookup_limits from public, anon, authenticated/)
  assert.match(migration, /'username', v_target\.username, 'display_name', v_target\.display_name/)
  assert.doesNotMatch(migration, /'email',/)
  assert.match(migration, /where i\.recipient_id = \(select auth\.uid\(\)\) and i\.status = 'pending'/)
})

test('static SQL contract: conversation RPC output fields explicitly match the declared frontend contract', () => {
  assert.match(migration, /returns table \( id uuid, kind text, title text, partner_username text, partner_display_name text, created_at timestamptz, updated_at timestamptz \)/)
  assert.match(migration, /coalesce\(partner\.display_name, partner\.username\) as title/)
  assert.match(migration, /partner\.username as partner_username/)
  assert.match(migration, /partner\.display_name as partner_display_name/)
  assert.match(migration, /c\.created_at as created_at, c\.updated_at as updated_at/)
})

test('static SQL contract: every definer function has fixed owner, empty search_path, and explicit least-privilege execution grants', () => {
  const definers = migration.match(/security definer set search_path = ''/g) || []
  const owners = migration.match(/alter function public\.[a-z_]+\([^)]*\) owner to postgres/g) || []
  assert.equal(definers.length, 9)
  assert.equal(owners.length, definers.length)
  assert.match(migration, /revoke all on function public\.guard_private_conversation_member\(\) from public, anon, authenticated/)
  assert.match(migration, /revoke all on function public\.consume_private_username_lookup_quota\(\) from public, anon, authenticated/)
  assert.match(migration, /grant execute on function public\.can_access_private_conversation\(uuid\) to authenticated/)
  assert.match(migration, /grant execute on function public\.lookup_private_user\(text\) to authenticated/)
  assert.match(migration, /grant execute on function public\.start_private_conversation\(text\) to authenticated/)
  assert.match(migration, /grant execute on function public\.respond_to_private_invitation\(uuid, boolean\) to authenticated/)
})

test('static SQL contract: initial migration compatibility and API RPC names remain unchanged', () => {
  for (const declaration of [
    'id uuid primary key references auth.users',
    'username text not null unique',
    'display_name text',
    'kind text not null',
    'created_by uuid not null references auth.users',
    'conversation_id uuid not null references public.conversations',
    'user_id uuid not null references auth.users',
    'role text not null default',
  ]) {
    assert.ok(initialMigration.includes(declaration), `Initial schema is missing: ${declaration}`)
  }
  const conversationsRoute = readFileSync(join(__dirname, '..', 'src', 'routes', 'conversations.js'), 'utf8')
  const realtimeMessaging = readFileSync(join(__dirname, '..', 'src', 'realtime', 'messaging.js'), 'utf8')
  for (const rpc of [
    'lookup_private_user',
    'start_private_conversation',
    'list_incoming_private_invitations',
    'respond_to_private_invitation',
    'list_my_private_conversations',
    'can_access_private_conversation',
  ]) {
    assert.ok(
      new RegExp(`rpc\\('${rpc}'`).test(conversationsRoute)
        || new RegExp(`rpc\\('${rpc}'`).test(realtimeMessaging),
      `Backend does not call the ${rpc} RPC`,
    )
  }
})
