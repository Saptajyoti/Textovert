const express = require('express')
const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../middleware/requireAuth')
const { hasConversationAccess, isUuid } = require('../realtime/messaging')
const { notifyInvitation, notifyInvitationForConversation } = require('../lib/webPush')

const router = express.Router()
const DEFAULT_PAGE_SIZE = 50
const MAX_PAGE_SIZE = 100
const MAX_SEARCH_RESULTS = 40
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/
const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/i
const SEARCH_PATTERN = /^[\s\S]{1,120}$/

async function decorateMessages(supabase, messages, userId) {
  if (!messages.length) return []
  const messageIds = messages.map((message) => message.id)
  const replyIds = [...new Set(messages.map((message) => message.reply_to_id).filter(Boolean))]
  const [receiptResult, reactionResult, replyResult] = await Promise.all([
    supabase.from('message_receipts').select('message_id, recipient_id, status').in('message_id', messageIds),
    supabase.from('message_reactions').select('message_id, user_id, reaction').in('message_id', messageIds),
    replyIds.length
      ? supabase.from('messages')
        .select('id, sender_id, body, message_type, attachment_name, deleted_at')
        .in('id', replyIds)
      : Promise.resolve({ data: [], error: null }),
  ])
  for (const result of [receiptResult, reactionResult, replyResult]) {
    if (result.error) throw result.error
  }

  const receiptsById = new Map()
  for (const receipt of receiptResult.data || []) {
    const receipts = receiptsById.get(receipt.message_id) || []
    receipts.push(receipt)
    receiptsById.set(receipt.message_id, receipts)
  }
  const replyById = new Map((replyResult.data || []).map((reply) => [reply.id, reply]))
  const reactionsById = new Map()
  for (const reaction of reactionResult.data || []) {
    const reactions = reactionsById.get(reaction.message_id) || []
    const existing = reactions.find((entry) => entry.reaction === reaction.reaction)
    if (existing) {
      existing.count += 1
      existing.mine ||= reaction.user_id === userId
    } else {
      reactions.push({
        reaction: reaction.reaction,
        count: 1,
        mine: reaction.user_id === userId,
      })
    }
    reactionsById.set(reaction.message_id, reactions)
  }

  return messages.map((message) => ({
    ...message,
    read: (receiptsById.get(message.id) || []).some((receipt) => (
      receipt.recipient_id === userId && receipt.status === 'read'
    )) || (message.sender_id === userId &&
      (receiptsById.get(message.id) || []).some((receipt) => receipt.status === 'read')),
    read_count: (receiptsById.get(message.id) || []).filter((receipt) => receipt.status === 'read').length,
    recipient_count: (receiptsById.get(message.id) || []).length,
    reactions: reactionsById.get(message.id) || [],
    reply: message.reply_to_id ? replyById.get(message.reply_to_id) || null : null,
  }))
}

router.use(requireAuth)

const lookupRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many username searches. Try again later.' }),
})

const invitationRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many invitations. Try again later.' }),
})

function handleRpcError(error, next) {
  const statusByCode = { '22023': 400, '23505': 409, '42501': 403 }
  const status = statusByCode[error.code]
  if (!status) {
    next(error)
    return
  }
  const responseError = new Error(error.message || 'The request could not be completed.')
  responseError.status = status
  next(responseError)
}

router.get('/users/lookup', lookupRateLimit, async (req, res, next) => {
  const username = req.query.username
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    res.status(400).json({ error: 'Enter a username with 3 to 32 letters, numbers, or underscores.' })
    return
  }

  try {
    const { data, error } = await req.supabase.rpc('lookup_private_user', {
      p_username: username,
    })
    if (error) {
      handleRpcError(error, next)
      return
    }
    if (data?.status === 'rate_limited') {
      res.status(429).json({ error: 'Username search limit reached. Try again in 15 minutes.' })
      return
    }
    if (!data?.found) {
      res.status(404).json({ error: 'No user with that username was found.' })
      return
    }
    if (data.relationship === 'self') {
      res.status(400).json({ error: 'You cannot start a conversation with yourself.' })
      return
    }
    res.json(data)
  } catch (error) {
    next(error)
  }
})

router.get('/invitations', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.rpc('list_incoming_private_invitations')
    if (error) {
      handleRpcError(error, next)
      return
    }
    res.json({ invitations: data || [] })
  } catch (error) {
    next(error)
  }
})

router.post('/invitations', invitationRateLimit, async (req, res, next) => {
  const username = req.body?.username
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    res.status(400).json({ error: 'Enter a username with 3 to 32 letters, numbers, or underscores.' })
    return
  }

  try {
    const { data, error } = await req.supabase.rpc('start_private_conversation', {
      p_username: username,
    })
    if (error) {
      handleRpcError(error, next)
      return
    }
    if (data?.status === 'not_found') {
      res.status(404).json({ error: 'No user with that username was found.' })
      return
    }
    if (data?.status === 'self') {
      res.status(400).json({ error: 'You cannot start a conversation with yourself.' })
      return
    }
    if (data?.status === 'rate_limited') {
      res.status(429).json({ error: 'Username search and invitation limit reached. Try again in 15 minutes.' })
      return
    }
    if (data?.status === 'invitation_received') {
      res.status(409).json({ ...data, error: 'This user has already invited you. Accept or reject their invitation.' })
      return
    }
    if (data?.status === 'invitation_rejected') {
      res.status(409).json({ error: 'This invitation was rejected. Only the original inviter can send it again.' })
      return
    }
    if (!['invitation_sent', 'existing'].includes(data?.status)) {
      res.status(500).json({ error: 'The invitation could not be created.' })
      return
    }
    if (data.status === 'invitation_sent' && data.created && data.invitation_id) {
      notifyInvitation(data.invitation_id, 'invitation', req.app.get('io'))
        .catch(() => console.error('[notifications] Invitation delivery could not be started.'))
    }
    res.status(data.status === 'invitation_sent' && data.created ? 201 : 200).json(data)
  } catch (error) {
    next(error)
  }
})

async function respondToInvitation(req, res, next, accept) {
  const { invitationId } = req.params
  if (!isUuid(invitationId)) {
    res.status(400).json({ error: 'Invitation ID must be a valid UUID.' })
    return
  }

  try {
    const { data, error } = await req.supabase.rpc('respond_to_private_invitation', {
      p_invitation_id: invitationId,
      p_accept: accept,
    })
    if (error) {
      handleRpcError(error, next)
      return
    }
    if (data?.status === 'not_found') {
      res.status(404).json({ error: 'Invitation not found.' })
      return
    }
    if (data?.status === 'rejected' && accept) {
      res.status(409).json({ error: 'This invitation was rejected and cannot be accepted.' })
      return
    }
    if (data?.status === 'accepted' && !accept) {
      res.status(409).json({ error: 'This invitation has already been accepted.' })
      return
    }
    if (data?.status === 'accepted' && accept && data.conversation_id) {
      notifyInvitationForConversation(
        data.conversation_id,
        'invitation_accepted',
        req.user.id,
        req.app.get('io'),
      ).catch(() => console.error('[notifications] Acceptance delivery could not be started.'))
    }
    res.json(data)
  } catch (error) {
    next(error)
  }
}

router.post('/invitations/:invitationId/accept', (req, res, next) => {
  respondToInvitation(req, res, next, true)
})

router.post('/invitations/:invitationId/reject', (req, res, next) => {
  respondToInvitation(req, res, next, false)
})

router.get('/', async (req, res, next) => {
  try {
    const [privateResult, groupResult] = await Promise.all([
      req.supabase.rpc('list_my_private_conversations'),
      req.supabase.rpc('list_my_group_conversations'),
    ])
    if (privateResult.error) throw privateResult.error
    if (groupResult.error) throw groupResult.error
    const conversations = [...(privateResult.data || []), ...(groupResult.data || [])]
      .sort((left, right) => new Date(right.updated_at) - new Date(left.updated_at))
    res.json({ conversations })
  } catch (error) {
    next(error)
  }
})

router.get('/search/:conversationId', async (req, res, next) => {
  try {
    const { conversationId } = req.params
    const searchTerm = req.query.q
    if (!isUuid(conversationId)) {
      res.status(400).json({ error: 'Conversation ID must be a valid UUID.' })
      return
    }
    if (typeof searchTerm !== 'string' || !SEARCH_PATTERN.test(searchTerm.trim())) {
      res.status(400).json({ error: 'Search text must be between 1 and 120 characters.' })
      return
    }
    if (!await hasConversationAccess(req.supabase, conversationId)) {
      res.status(404).json({ error: 'Conversation not found.' })
      return
    }

    const literalTerm = searchTerm.trim().replace(/[\\%_]/g, '\\$&')
    const { data, error } = await req.supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at, message_type, attachment_name')
      .eq('conversation_id', conversationId)
      .is('deleted_at', null)
      .ilike('body', `%${literalTerm}%`)
      .order('created_at', { ascending: false })
      .limit(MAX_SEARCH_RESULTS)
    if (error) throw error
    res.json({ messages: data || [], hasMore: (data || []).length === MAX_SEARCH_RESULTS })
  } catch (error) {
    next(error)
  }
})

router.post('/media/sign', async (req, res, next) => {
  try {
    const messageId = req.body?.messageId
    if (!isUuid(messageId)) {
      res.status(400).json({ error: 'Message ID must be a valid UUID.' })
      return
    }
    const { data: message, error: messageError } = await req.supabase
      .from('messages')
      .select('id, conversation_id, attachment_path')
      .eq('id', messageId)
      .in('message_type', ['image', 'file'])
      .maybeSingle()
    if (messageError) throw messageError
    if (!message || !await hasConversationAccess(req.supabase, message.conversation_id)) {
      res.status(404).json({ error: 'Attachment not found.' })
      return
    }

    const { data, error } = await req.supabase.storage
      .from('conversation-media')
      .createSignedUrl(message.attachment_path, 300)
    if (error) throw error
    res.json({ url: data.signedUrl, expiresIn: 300 })
  } catch (error) {
    next(error)
  }
})

router.get('/:conversationId/messages/:messageId', async (req, res, next) => {
  try {
    const { conversationId, messageId } = req.params
    if (!isUuid(conversationId) || !isUuid(messageId)) {
      res.status(400).json({ error: 'Message or conversation ID is invalid.' })
      return
    }
    if (!await hasConversationAccess(req.supabase, conversationId)) {
      res.status(404).json({ error: 'Conversation not found.' })
      return
    }
    const { data, error } = await req.supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at, message_type, attachment_path, attachment_name, attachment_mime, attachment_size, reply_to_id, deleted_at')
      .eq('conversation_id', conversationId)
      .eq('id', messageId)
      .maybeSingle()
    if (error) throw error
    if (!data) {
      res.status(404).json({ error: 'Message not found.' })
      return
    }
    res.json({ message: (await decorateMessages(req.supabase, [data], req.user.id))[0] })
  } catch (error) {
    next(error)
  }
})

router.get('/:conversationId/messages', async (req, res, next) => {
  try {
    const { conversationId } = req.params
    if (!isUuid(conversationId)) {
      res.status(400).json({ error: 'Conversation ID must be a valid UUID.' })
      return
    }
    if (!await hasConversationAccess(req.supabase, conversationId)) {
      res.status(404).json({ error: 'Conversation not found.' })
      return
    }

    const limitInput = req.query.limit
    const limit = limitInput === undefined ? DEFAULT_PAGE_SIZE : Number(limitInput)
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      res.status(400).json({ error: `Page size must be between 1 and ${MAX_PAGE_SIZE}.` })
      return
    }

    const beforeCreatedAt = req.query.beforeCreatedAt
    const beforeId = req.query.beforeId
    if ((beforeCreatedAt || beforeId) &&
      (typeof beforeCreatedAt !== 'string' || !TIMESTAMP_PATTERN.test(beforeCreatedAt) ||
        Number.isNaN(Date.parse(beforeCreatedAt)) || !isUuid(beforeId))) {
      res.status(400).json({ error: 'Message cursor is invalid.' })
      return
    }

    let query = req.supabase
      .from('messages')
      .select('id, conversation_id, sender_id, body, created_at, message_type, attachment_path, attachment_name, attachment_mime, attachment_size, reply_to_id, deleted_at')
      .eq('conversation_id', conversationId)

    if (beforeCreatedAt && beforeId) {
      query = query.or(`created_at.lt.${beforeCreatedAt},and(created_at.eq.${beforeCreatedAt},id.lt.${beforeId})`)
    }

    const { data, error } = await query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1)

    if (error) throw error
    const hasMore = data.length > limit
    const page = data.slice(0, limit)
    const oldest = page.at(-1)
    res.json({
      messages: await decorateMessages(req.supabase, page.reverse(), req.user.id),
      hasMore,
      nextCursor: hasMore && oldest
        ? { beforeCreatedAt: oldest.created_at, beforeId: oldest.id }
        : null,
    })
  } catch (error) {
    next(error)
  }
})

module.exports = router
