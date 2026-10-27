const express = require('express')
const { requireAuth } = require('../middleware/requireAuth')
const { isUuid } = require('../realtime/messaging')

const router = express.Router()
const USERNAME_PATTERN = /^[a-z0-9_]{3,32}$/i
const MAX_GROUP_MEMBERS = 100

router.use(requireAuth)

router.get('/users/lookup', async (req, res, next) => {
  const username = req.query.username
  if (typeof username !== 'string' || !USERNAME_PATTERN.test(username)) {
    res.status(400).json({ error: 'Enter a username with 3 to 32 letters, numbers, or underscores.' })
    return
  }
  try {
    const { data, error } = await req.supabase.rpc('lookup_group_member', {
      p_username: username,
    })
    if (error) {
      respondWithRpcError(error, next)
      return
    }
    if (data?.status === 'rate_limited') {
      res.status(429).json({ error: 'Username search limit reached. Try again in 15 minutes.' })
      return
    }
    if (!data?.found) {
      res.status(404).json({ error: 'No eligible user with that username was found.' })
      return
    }
    res.json(data)
  } catch (error) {
    next(error)
  }
})

function respondWithRpcError(error, next, notFound = false) {
  const statusByCode = { '22023': 400, '23505': 409, '42501': notFound ? 404 : 403 }
  const status = statusByCode[error.code]
  if (!status) {
    next(error)
    return
  }
  const responseError = new Error(error.message || 'The group request could not be completed.')
  responseError.status = status
  next(responseError)
}

function validateMemberIds(memberIds, { allowEmpty = false } = {}) {
  return Array.isArray(memberIds) &&
    (allowEmpty || memberIds.length > 0) &&
    memberIds.length <= MAX_GROUP_MEMBERS - 1 &&
    memberIds.every(isUuid) &&
    new Set(memberIds).size === memberIds.length
}

function normalizeAvatarUrl(value) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 2048) return undefined
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined
  } catch {
    return undefined
  }
}

async function notifyGroupMembers(req, conversationId, removedUserId = null) {
  const io = req.app.get('io')
  if (!io) return
  try {
    const { data: members, error } = await req.supabase.rpc('list_group_conversation_members', {
      p_conversation_id: conversationId,
    })
    if (error) throw error
    for (const member of members || []) {
      io.to(`user:${member.user_id}`).emit('notification:changed', {
        type: 'group',
        conversationId,
      })
    }
  } catch (error) {
    console.error(`[groups] Membership changed but realtime refresh failed: ${error.message}`)
  }
  if (!removedUserId) return

  io.to(`user:${removedUserId}`).emit('conversation:removed', { conversationId })
  try {
    const sockets = await io.in(`conversation:${conversationId}`).fetchSockets()
    for (const socket of sockets) {
      if (socket.data.user?.id !== removedUserId) continue
      socket.data.joinedConversationIds?.delete(conversationId)
      socket.data.conversationJoinRequests?.set(
        conversationId,
        (socket.data.conversationJoinRequests.get(conversationId) || 0) + 1,
      )
      await socket.leave(`conversation:${conversationId}`)
    }
  } catch (error) {
    console.error(`[groups] Could not evict removed member from the live group room: ${error.message}`)
  }
}

router.get('/', async (req, res, next) => {
  try {
    const { data, error } = await req.supabase.rpc('list_my_group_conversations')
    if (error) throw error
    res.json({ conversations: data || [] })
  } catch (error) {
    next(error)
  }
})

router.post('/', async (req, res, next) => {
  const { name, description, memberIds } = req.body || {}
  const avatarUrl = normalizeAvatarUrl(req.body?.avatarUrl)
  if (typeof name !== 'string' || [...name.trim()].length < 1 || [...name.trim()].length > 100 ||
    (description !== undefined && description !== null &&
      (typeof description !== 'string' || [...description].length > 500)) ||
    avatarUrl === undefined || !validateMemberIds(memberIds) ||
    memberIds.includes(req.user.id)) {
    res.status(400).json({ error: 'Group details or member selection are invalid.' })
    return
  }
  try {
    const { data, error } = await req.supabase.rpc('create_group_conversation', {
      p_name: name,
      p_description: description || null,
      p_avatar_url: avatarUrl,
      p_member_ids: memberIds,
    })
    if (error) {
      respondWithRpcError(error, next)
      return
    }
    await notifyGroupMembers(req, data)
    res.status(201).json({ conversationId: data })
  } catch (error) {
    next(error)
  }
})

router.get('/:conversationId/members', async (req, res, next) => {
  const { conversationId } = req.params
  if (!isUuid(conversationId)) {
    res.status(400).json({ error: 'Conversation ID must be a valid UUID.' })
    return
  }
  try {
    const { data, error } = await req.supabase.rpc('list_group_conversation_members', {
      p_conversation_id: conversationId,
    })
    if (error) {
      respondWithRpcError(error, next, true)
      return
    }
    res.json({ members: data || [] })
  } catch (error) {
    next(error)
  }
})

router.patch('/:conversationId', async (req, res, next) => {
  const { conversationId } = req.params
  const { name, description } = req.body || {}
  const avatarUrl = normalizeAvatarUrl(req.body?.avatarUrl)
  if (!isUuid(conversationId) || typeof name !== 'string' ||
    [...name.trim()].length < 1 || [...name.trim()].length > 100 ||
    (description !== undefined && description !== null &&
      (typeof description !== 'string' || [...description].length > 500)) ||
    avatarUrl === undefined) {
    res.status(400).json({ error: 'Group details are invalid.' })
    return
  }
  try {
    const { error } = await req.supabase.rpc('update_group_conversation', {
      p_conversation_id: conversationId,
      p_name: name,
      p_description: description || null,
      p_avatar_url: avatarUrl,
    })
    if (error) {
      respondWithRpcError(error, next)
      return
    }
    await notifyGroupMembers(req, conversationId)
    res.json({ updated: true })
  } catch (error) {
    next(error)
  }
})

router.post('/:conversationId/members', async (req, res, next) => {
  const { conversationId } = req.params
  const memberIds = req.body?.memberIds
  if (!isUuid(conversationId) || !validateMemberIds(memberIds) ||
    memberIds.includes(req.user.id)) {
    res.status(400).json({ error: 'Group member selection is invalid.' })
    return
  }
  try {
    const { data, error } = await req.supabase.rpc('add_group_conversation_members', {
      p_conversation_id: conversationId,
      p_member_ids: memberIds,
    })
    if (error) {
      respondWithRpcError(error, next)
      return
    }
    await notifyGroupMembers(req, conversationId)
    res.status(201).json({ addedCount: data })
  } catch (error) {
    next(error)
  }
})

router.delete('/:conversationId/members/:memberId', async (req, res, next) => {
  const { conversationId, memberId } = req.params
  if (!isUuid(conversationId) || !isUuid(memberId)) {
    res.status(400).json({ error: 'Group or member ID is invalid.' })
    return
  }
  try {
    const { error } = await req.supabase.rpc('remove_group_conversation_member', {
      p_conversation_id: conversationId,
      p_member_id: memberId,
    })
    if (error) {
      respondWithRpcError(error, next)
      return
    }
    await notifyGroupMembers(req, conversationId, memberId)
    res.json({ removed: true })
  } catch (error) {
    next(error)
  }
})

router.post('/:conversationId/members/:memberId/promote', async (req, res, next) => {
  const { conversationId, memberId } = req.params
  if (!isUuid(conversationId) || !isUuid(memberId)) {
    res.status(400).json({ error: 'Group or member ID is invalid.' })
    return
  }
  try {
    const { error } = await req.supabase.rpc('promote_group_conversation_member', {
      p_conversation_id: conversationId,
      p_member_id: memberId,
    })
    if (error) {
      respondWithRpcError(error, next)
      return
    }
    await notifyGroupMembers(req, conversationId)
    res.json({ promoted: true })
  } catch (error) {
    next(error)
  }
})

router.post('/:conversationId/leave', async (req, res, next) => {
  const { conversationId } = req.params
  if (!isUuid(conversationId)) {
    res.status(400).json({ error: 'Conversation ID must be a valid UUID.' })
    return
  }
  try {
    const { data, error } = await req.supabase.rpc('leave_group_conversation', {
      p_conversation_id: conversationId,
    })
    if (error) {
      respondWithRpcError(error, next)
      return
    }
    const io = req.app.get('io')
    for (const memberId of data?.member_ids || []) {
      if (!isUuid(memberId)) continue
      io?.to(`user:${memberId}`).emit('notification:changed', {
        type: 'group',
        conversationId,
      })
    }
    try {
      const sockets = await io?.in(`conversation:${conversationId}`).fetchSockets() || []
      for (const socket of sockets) {
        if (socket.data.user?.id !== req.user.id) continue
        socket.data.joinedConversationIds?.delete(conversationId)
        await socket.leave(`conversation:${conversationId}`)
      }
    } catch (socketError) {
      console.error(`[groups] A departing member could not be removed from a live socket room: ${socketError.message}`)
    }
    io?.to(`user:${req.user.id}`).emit('conversation:removed', { conversationId })
    res.json({ status: data?.status })
  } catch (error) {
    next(error)
  }
})

router.patch('/:conversationId/mute', async (req, res, next) => {
  const { conversationId } = req.params
  const { muted } = req.body || {}
  if (!isUuid(conversationId) || typeof muted !== 'boolean') {
    res.status(400).json({ error: 'Group notification setting is invalid.' })
    return
  }
  try {
    const { error } = await req.supabase.rpc('set_group_conversation_muted', {
      p_conversation_id: conversationId,
      p_muted: muted,
    })
    if (error) {
      respondWithRpcError(error, next, true)
      return
    }
    res.json({ muted })
  } catch (error) {
    next(error)
  }
})

module.exports = { router, USERNAME_PATTERN, validateMemberIds }
