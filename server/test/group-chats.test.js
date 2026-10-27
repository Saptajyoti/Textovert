const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')
const { hasConversationAccess, isUuid } = require('../src/realtime/messaging')
const { validateMemberIds } = require('../src/routes/groups')

const migrationPath = join(__dirname, '..', '..', 'database', 'migrations', '202610270004_group_chats.sql')
const migration = readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').trim().toLowerCase()
const sockets = readFileSync(join(__dirname, '..', 'src', 'sockets', 'index.js'), 'utf8')
const conversations = readFileSync(join(__dirname, '..', 'src', 'routes', 'conversations.js'), 'utf8')
const validIds = [
  '0f8fad5b-d9cb-469f-a165-70867728950e',
  '0f8fad5b-d9cb-469f-a165-70867728950d',
]

test('group membership selections contain distinct UUIDs within the cap', () => {
  assert.equal(validateMemberIds(validIds), true)
  assert.equal(validateMemberIds([]), false)
  assert.equal(validateMemberIds([validIds[0], validIds[0]]), false)
  assert.equal(validateMemberIds(['not-a-uuid']), false)
  assert.equal(validateMemberIds(Array.from({ length: 100 }, () => validIds[0])), false)
  assert.equal(isUuid(validIds[0]), true)
})

test('group access and group creation use authenticated least-privilege database functions', () => {
  assert.match(migration, /create function public\.can_access_conversation\(p_conversation_id uuid\)/)
  assert.match(migration, /when c\.kind = 'group' then exists/)
  assert.match(migration, /cm\.user_id = \(select auth\.uid\(\)\)/)
  assert.match(migration, /create function public\.create_group_conversation\(/)
  assert.match(migration, /values \(v_conversation_id, v_user_id, 'admin'\)/)
  assert.match(migration, /alter function public\.create_group_conversation\(text, text, text, uuid\[\]\) owner to postgres/)
  assert.match(migration, /grant execute on function public\.create_group_conversation\(text, text, text, uuid\[\]\) to authenticated/)
  assert.match(migration, /create policy "groups must use the group creation workflow"/)
  assert.doesNotMatch(migration, /grant insert .*on table public\.conversation_members to authenticated/)
})

test('group admin transfer, membership removal, and user-specific muting are constrained', () => {
  assert.match(migration, /raise exception 'promote another admin before removing the last group admin\.'/)
  assert.match(migration, /order by cm\.joined_at, cm\.user_id limit 1/)
  assert.match(migration, /return pg_catalog\.jsonb_build_object\('status', 'deleted'/)
  assert.match(migration, /case when v_role = 'admin' and v_admin_count = 1 then 'admin_transferred'/)
  assert.match(migration, /create function public\.set_group_conversation_muted/)
  assert.match(migration, /where mute\.conversation_id = new\.conversation_id and mute\.user_id = cm\.user_id/)
  assert.match(migration, /public\.can_access_conversation\(new\.conversation_id\)/)
})

test('group messages, reactions, and media are scoped through the generic access check', () => {
  assert.match(migration, /create policy "conversation members can read message reactions"[\s\S]*?public\.can_access_conversation\(m\.conversation_id\)/)
  assert.match(migration, /create policy "conversation members can read private conversation media"[\s\S]*?public\.can_access_conversation/)
  assert.match(migration, /r\.status = 'delivered'[\s\S]*?public\.can_access_conversation\(m\.conversation_id\)/)
  assert.match(sockets, /hasconversationaccess\([\s\S]*?socket\.join\(`conversation:\$\{conversationid\}`\)/i)
  assert.match(conversations, /list_my_group_conversations/)
  assert.match(conversations, /hasconversationaccess\(req\.supabase, conversationid\)/i)
})

test('generic conversation access uses the authenticated group/private RPC', async () => {
  let called
  const supabase = {
    async rpc(name, args) {
      called = { name, args }
      return { data: true, error: null }
    },
  }
  assert.equal(await hasConversationAccess(supabase, validIds[0]), true)
  assert.deepEqual(called, {
    name: 'can_access_conversation',
    args: { p_conversation_id: validIds[0] },
  })

  supabase.rpc = async () => ({ data: false, error: null })
  assert.equal(await hasConversationAccess(supabase, validIds[0]), false)
  supabase.rpc = async () => ({ data: null, error: new Error('RPC failed') })
  await assert.rejects(hasConversationAccess(supabase, validIds[0]), /Could not verify conversation access/)
})
