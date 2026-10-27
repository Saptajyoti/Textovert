const test = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const migrationPath = join(__dirname, '..', '..', 'database', 'migrations', '202610270002_rich_messaging.sql')
const migration = readFileSync(migrationPath, 'utf8').replace(/\s+/g, ' ').trim().toLowerCase()

test('migration adds compatible reply and attachment metadata without removing existing messages', () => {
  assert.match(migration, /^-- apply once as the postgres role.*begin;/)
  assert.match(migration, /add column message_type text not null default 'text'/)
  assert.match(migration, /add column reply_to_id uuid references public\.messages \(id\) on delete set null/)
  assert.match(migration, /create index messages_reply_to_idx/)
  assert.match(migration, /create trigger messages_validate_rich_message/)
  assert.match(migration, /replies must reference a message in the same conversation/)
  assert.doesNotMatch(migration, /drop table|truncate|delete from public\.messages/)
})

test('reactions are unique and users can only manage their own reactions in authorized private chats', () => {
  assert.match(migration, /primary key \(message_id, user_id, reaction\)/)
  assert.match(migration, /reaction in \('👍', '❤️', '😂', '😮', '😢', '🙏'\)/)
  assert.match(migration, /users can add their own message reactions/)
  assert.match(migration, /users can remove their own message reactions/)
  assert.match(migration, /user_id = \(select auth\.uid\(\)\)/)
  assert.match(migration, /public\.can_access_private_conversation\(m\.conversation_id\)/)
})

test('storage bucket is private, upload content is server-validated, and object access is scoped', () => {
  assert.match(migration, /values \( 'conversation-media', 'conversation-media', false, 10485760/)
  assert.match(migration, /create policy "conversation members can read private conversation media"/)
  assert.match(migration, /create policy "users can remove their own private conversation uploads"/)
  assert.doesNotMatch(migration, /create policy .* for insert on storage\.objects/)
  assert.match(migration, /o\.metadata->>'mimetype' = new\.attachment_mime/)
  assert.match(migration, /grant insert \(conversation_id, sender_id, body, message_type, attachment_path/)
  assert.match(migration, /commit;$/)
})
