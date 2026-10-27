const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MAX_MESSAGE_LENGTH = 10000
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024
const ATTACHMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
])
const IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

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

function validateAttachmentPayload(attachment, conversationId, senderId) {
  if (!attachment || typeof attachment !== 'object' || Array.isArray(attachment)) {
    return { error: 'Attachment details are required.' }
  }
  const { type, path, name, mimeType, size } = attachment
  const validType = type === 'image' || type === 'file'
  const validName = typeof name === 'string' &&
    name.trim().length > 0 &&
    [...name].length <= 255 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    ![...name].some((character) => character.charCodeAt(0) <= 31)
  const validPath = typeof path === 'string' &&
    path === `${conversationId}/${senderId}/${path.split('/').at(-1)}` &&
    isUuid(path.split('/').at(-1))

  if (!validType || !validName || !validPath ||
    typeof mimeType !== 'string' || !ATTACHMENT_MIME_TYPES.has(mimeType) ||
    !Number.isInteger(size) || size < 1 || size > MAX_ATTACHMENT_SIZE ||
    (type === 'image') !== IMAGE_MIME_TYPES.has(mimeType)) {
    return { error: 'Attachment details are invalid or unsupported.' }
  }

  return {
    attachment: {
      message_type: type,
      attachment_path: path,
      attachment_name: name.trim(),
      attachment_mime: mimeType,
      attachment_size: size,
    },
  }
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

async function hasConversationAccess(supabase, conversationId) {
  const { data, error } = await supabase.rpc('can_access_conversation', {
    p_conversation_id: conversationId,
  })
  if (error) throw new Error('Could not verify conversation access.')
  return data === true
}

module.exports = {
  MAX_MESSAGE_LENGTH,
  MAX_ATTACHMENT_SIZE,
  ATTACHMENT_MIME_TYPES,
  buildMessageInsert,
  hasConversationMembership,
  hasConversationAccess,
  hasPrivateConversationMembership,
  isUuid,
  validateAttachmentPayload,
  validateMessageBody,
}
