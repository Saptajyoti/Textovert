const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const migrationPath = join(__dirname, '..', '..', 'database', 'migrations', '202610270001_realtime_presence_read_receipts.sql')
const migration = readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').trim().toLowerCase()

test('realtime migration creates receipts on new messages and backfills existing messages', () => {
  assert.match(migration, /^-- apply once as the postgres role\..*begin;/)
  assert.match(migration, /after insert on public\.messages/)
  assert.match(migration, /create function public\.create_message_receipts\(\)/)
  assert.match(migration, /insert into public\.message_receipts \(message_id, recipient_id, status\)/)
  assert.match(migration, /on conflict \(message_id, recipient_id\) do nothing/)
  assert.match(migration, /from public\.messages m join public\.conversation_members cm/)
  assert.match(migration, /status = 'delivered'/)
  assert.match(migration, /commit;$/)
})

test('read and presence RPCs are authenticated, scoped to private conversation participants', () => {
  assert.match(migration, /create function public\.list_private_conversation_partners\(\)/)
  assert.match(migration, /security definer set search_path = ''/)
  assert.match(migration, /and public\.can_access_private_conversation\(c\.id\)/)
  assert.match(migration, /grant execute on function public\.list_private_conversation_partners\(\) to authenticated/)
  assert.match(migration, /create function public\.mark_private_conversation_read\(p_conversation_id uuid\)/)
  assert.match(migration, /r\.recipient_id = v_user_id and r\.status = 'delivered'/)
  assert.match(migration, /m\.sender_id <> v_user_id/)
  assert.match(migration, /grant execute on function public\.mark_private_conversation_read\(uuid\) to authenticated/)
})

test('senders can read only their own message receipts without changing recipient write policies', () => {
  assert.match(migration, /create policy "senders can read receipts for their messages"/)
  assert.match(migration, /m\.sender_id = \(select auth\.uid\(\)\)/)
  assert.match(migration, /cm\.user_id = \(select auth\.uid\(\)\)/)
  assert.doesNotMatch(migration, /drop policy|drop table|truncate|delete from public\.messages/)
})

test('security-definer functions use a fixed owner, empty search path, and explicit grants', () => {
  const functionNames = [...migration.matchAll(/create function public\.([a-z_]+)\(/g)]
    .map((match) => match[1])
  assert.equal(functionNames.length, 3)
  for (const name of functionNames) {
    assert.match(migration, new RegExp(`alter function public\\.${name}\\([^)]*\\) owner to postgres`))
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}\\([^)]*\\) from public, anon, authenticated`))
    assert.match(migration, /security definer set search_path = ''/)
  }
})
