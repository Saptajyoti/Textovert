const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_MESSAGE_LENGTH = 10000

function validateMessageBody(body) {
  if (typeof body !== 'string') return { error: 'Message text must be a string.' }
  const text = body.trim()
  if (!text) return { error: 'Message cannot be empty.' }
  if ([...text].length > MAX_MESSAGE_LENGTH) {
    return { error: `Messages cannot exceed ${MAX_MESSAGE_LENGTH} characters.` }
  }
  return { text }
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function buildMessageInsert(conversationId, senderId, body) {
  return { conversation_id: conversationId, sender_id: senderId, body }
}

async function hasConversationMembership(supabase, conversationId, userId) {
  const { data, error } = await supabase
    .from('conversation_members')
    .select('conversation_id')
    .eq('conversation_id', conversationId)
    .eq('user_id', userId)
    .maybeSingle()

  if (error) throw new Error('Could not verify conversation membership.')
  return Boolean(data)
}

async function hasPrivateConversationMembership(supabase, conversationId) {
  const { data, error } = await supabase.rpc('can_access_private_conversation', {
    p_conversation_id: conversationId,
  })
  if (error) throw new Error('Could not verify private conversation access.')
  return data === true
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  buildMessageInsert,
  hasConversationMembership,
  hasPrivateConversationMembership,
  isUuid,
  validateMessageBody,
}
