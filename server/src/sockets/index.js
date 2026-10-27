const { Server } = require('socket.io')
const { allowedOrigins, allowSocketRequest } = require('../config/cors')
const { authenticateSocketToken } = require('../realtime/authenticateSocket')
const { SocketState } = require('../realtime/socketState')
const { deliverPushForMessage, notifyMessageForConversation } = require('../lib/webPush')
const {
  buildMessageInsert,
  hasConversationAccess,
  isUuid,
  validateAttachmentPayload,
  validateMessageBody,
} = require('../realtime/messaging')
const ALLOWED_REACTIONS = new Set(['👍', '❤️', '😂', '😮', '😢', '🙏'])

function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
    allowRequest: allowSocketRequest,
  })
  const socketState = new SocketState()

  io.use((socket, next) => {
    authenticateSocketToken(socket.handshake.auth?.accessToken)
      .then(({ supabase, user }) => {
        socket.data.supabase = supabase
        socket.data.user = user
        next()
      })
      .catch((error) => next(new Error(error.message || 'Socket authentication failed.')))
  })

  io.on('connection', (socket) => {
    const userId = socket.data.user.id
    const userRoom = `user:${userId}`
    socket.data.joinedConversationIds = new Set()
    socket.data.conversationJoinRequests = new Map()
    socket.data.typingStartTimes = new Map()
    socket.data.partners = []
    socket.data.presenceRegistered = false
    socket.data.pageVisible = false
    socket.data.visibleConversationId = null
    console.info('[socket] authenticated connection established')

    async function registerPresence(partners) {
      if (!socket.connected) return
      const newPartners = socketState.addPartners(userId, partners)
      socket.data.partners = partners
      if (socket.data.presenceRegistered) {
        for (const partner of newPartners) {
          io.to(`user:${partner.partner_id}`).emit('presence:update', {
            conversationId: partner.conversation_id,
            userId,
            online: true,
          })
        }
        return
      }

      await socket.join(userRoom)
      if (!socket.connected) return
      const becameOnline = socketState.connect(userId, socket.id)
      socket.data.presenceRegistered = true
      const onlineRecipients = becameOnline ? socketState.getPartners(userId) : newPartners
      if (becameOnline || onlineRecipients.length) {
        for (const partner of onlineRecipients) {
          io.to(`user:${partner.partner_id}`).emit('presence:update', {
            conversationId: partner.conversation_id,
            userId,
            online: true,
          })
        }
      }
    }

    socket.data.partnersReady = (async () => {
      const { data, error } = await socket.data.supabase.rpc('list_private_conversation_partners')
      if (error) {
        console.error('[socket] could not load authorized presence recipients.')
        socket.emit('presence:error', { error: 'Presence is temporarily unavailable.' })
        return []
      }
      const partners = Array.isArray(data) ? data : []
      await registerPresence(partners)
      return partners
    })()

    socket.on('conversation:join', async (payload, acknowledge) => {
      const respond = (result) => {
        if (typeof acknowledge === 'function') acknowledge(result)
      }
      const conversationId = payload?.conversationId
      if (!isUuid(conversationId)) {
        respond({ ok: false, error: 'Conversation ID must be a valid UUID.' })
        return
      }
      const requestId = (socket.data.conversationJoinRequests.get(conversationId) || 0) + 1
      socket.data.conversationJoinRequests.set(conversationId, requestId)

      try {
        const allowed = await hasConversationAccess(
          socket.data.supabase,
          conversationId,
        )
        if (!allowed) {
          respond({ ok: false, error: 'You are not a member of this conversation.' })
          return
        }
        if (!socket.connected ||
          socket.data.conversationJoinRequests.get(conversationId) !== requestId) return
        let partners = await socket.data.partnersReady
        if (!partners.some((item) => item.conversation_id === conversationId)) {
          const { data: currentPartners, error: partnersError } = await socket.data.supabase.rpc(
            'list_private_conversation_partners',
          )
          if (partnersError) {
            console.error('[socket] could not refresh authorized presence recipients.')
            socket.emit('presence:error', { error: 'Presence is temporarily unavailable.' })
          } else {
            partners = Array.isArray(currentPartners) ? currentPartners : []
            await registerPresence(partners)
          }
        }
        if (!socket.connected ||
          socket.data.conversationJoinRequests.get(conversationId) !== requestId) return
        if (!await hasConversationAccess(socket.data.supabase, conversationId)) {
          respond({ ok: false, error: 'You are not a member of this conversation.' })
          return
        }
        const partner = partners.find((item) => item.conversation_id === conversationId)
        await socket.join(`conversation:${conversationId}`)
        socket.data.joinedConversationIds.add(conversationId)
        if (!await hasConversationAccess(socket.data.supabase, conversationId)) {
          socket.data.joinedConversationIds.delete(conversationId)
          await socket.leave(`conversation:${conversationId}`)
          respond({ ok: false, error: 'You are not a member of this conversation.' })
          return
        }
        respond({
          ok: true,
          partnerOnline: partner ? socketState.isOnline(partner.partner_id) : null,
        })
      } catch (error) {
        console.error(`[socket] membership check failed: ${error.message}`)
        respond({ ok: false, error: 'Could not verify access to this conversation.' })
      }
    })

    socket.on('conversation:leave', (payload) => {
      const conversationId = payload?.conversationId
      if (!isUuid(conversationId)) return
      socket.data.conversationJoinRequests.set(
        conversationId,
        (socket.data.conversationJoinRequests.get(conversationId) || 0) + 1,
      )
      if (!socket.data.joinedConversationIds.has(conversationId)) return
      socketState.stopTyping(conversationId, userId, socket.id)
      socket.data.typingStartTimes.delete(conversationId)
      socket.data.joinedConversationIds.delete(conversationId)
      socket.leave(`conversation:${conversationId}`)
    })

    socket.on('notification:visibility', async (payload) => {
      const visible = payload?.visible === true
      socket.data.pageVisible = visible
      if (!visible) {
        socket.data.visibleConversationId = null
        return
      }

      const conversationId = payload?.conversationId
      if (!isUuid(conversationId)) {
        socket.data.visibleConversationId = null
        return
      }
      if (socket.data.visibleConversationId === conversationId) return
      if (socket.data.joinedConversationIds.has(conversationId)) {
        socket.data.visibleConversationId = conversationId
        return
      }
      try {
        socket.data.visibleConversationId = await hasConversationAccess(
          socket.data.supabase,
          conversationId,
        ) ? conversationId : null
      } catch {
        console.error('[socket] Could not verify notification visibility.')
        socket.data.visibleConversationId = null
      }
    })

    async function handleTyping(payload, typing) {
      const conversationId = payload?.conversationId
      if (!isUuid(conversationId) ||
        !socket.data.joinedConversationIds.has(conversationId) ||
        !socket.rooms.has(`conversation:${conversationId}`)) return

      try {
        if (!await hasConversationAccess(socket.data.supabase, conversationId)) return
      } catch (error) {
        console.error(`[socket] typing membership check failed: ${error.message}`)
        return
      }
      if (!socket.connected ||
        !socket.data.joinedConversationIds.has(conversationId) ||
        !socket.rooms.has(`conversation:${conversationId}`)) return

      if (typing) {
        const lastStartedAt = socket.data.typingStartTimes.get(conversationId) || 0
        const now = Date.now()
        if (now - lastStartedAt < 750) return
        socket.data.typingStartTimes.set(conversationId, now)
        socketState.startTyping(conversationId, userId, socket.id, (event) => {
          io.to(`conversation:${conversationId}`).emit('typing:update', event)
        })
      } else {
        socket.data.typingStartTimes.delete(conversationId)
        socketState.stopTyping(conversationId, userId, socket.id)
      }
    }

    socket.on('typing:start', (payload) => handleTyping(payload, true))
    socket.on('typing:stop', (payload) => handleTyping(payload, false))

    socket.on('conversation:read', async (payload, acknowledge) => {
      const respond = (result) => {
        if (typeof acknowledge === 'function') acknowledge(result)
      }
      const conversationId = payload?.conversationId
      if (!isUuid(conversationId)) {
        respond({ ok: false, error: 'Conversation ID must be a valid UUID.' })
        return
      }

      try {
        if (!await hasConversationAccess(socket.data.supabase, conversationId)) {
          respond({ ok: false, error: 'You are not a member of this conversation.' })
          return
        }
        const { data: updatedReceipts, error } = await socket.data.supabase.rpc(
          'mark_private_conversation_read',
          { p_conversation_id: conversationId },
        )
        if (error) throw error

        const messageIds = Array.isArray(updatedReceipts)
          ? updatedReceipts.map((receipt) => receipt.message_id).filter(isUuid)
          : []
        for (let index = 0; index < messageIds.length; index += 100) {
          io.to(`conversation:${conversationId}`).emit('message:read', {
            conversationId,
            messageIds: messageIds.slice(index, index + 100),
            readerId: userId,
          })
        }
        io.to(userRoom).emit('notification:changed', { type: 'read', conversationId })
        respond({ ok: true, count: messageIds.length })
      } catch (error) {
        console.error(`[socket] could not mark messages read: ${error.message}`)
        respond({ ok: false, error: 'Messages could not be marked as read.' })
      }
    })

    async function handleReaction(payload, action, acknowledge) {
      const respond = (result) => {
        if (typeof acknowledge === 'function') acknowledge(result)
      }
      const conversationId = payload?.conversationId
      const messageId = payload?.messageId
      const reaction = payload?.reaction
      if (!isUuid(conversationId) || !isUuid(messageId) || !ALLOWED_REACTIONS.has(reaction)) {
        respond({ ok: false, error: 'Reaction details are invalid.' })
        return
      }

      try {
        if (!await hasConversationAccess(socket.data.supabase, conversationId)) {
          respond({ ok: false, error: 'You are not a member of this conversation.' })
          return
        }
        const { data: message, error: messageError } = await socket.data.supabase
          .from('messages')
          .select('id')
          .eq('id', messageId)
          .eq('conversation_id', conversationId)
          .maybeSingle()
        if (messageError) throw messageError
        if (!message) {
          respond({ ok: false, error: 'Message not found in this conversation.' })
          return
        }

        let changed = false
        if (action === 'add') {
          const { error } = await socket.data.supabase
            .from('message_reactions')
            .insert({ message_id: messageId, user_id: userId, reaction })
          if (error && error.code !== '23505') throw error
          changed = !error
        } else {
          const { data: removed, error } = await socket.data.supabase
            .from('message_reactions')
            .delete()
            .eq('message_id', messageId)
            .eq('user_id', userId)
            .eq('reaction', reaction)
            .select('message_id')
          if (error) throw error
          changed = Boolean(removed?.length)
        }

        if (changed) {
          io.to(`conversation:${conversationId}`).emit('message:reaction', {
            action,
            conversationId,
            messageId,
            userId,
            reaction,
          })
        }
        respond({ ok: true })
      } catch (error) {
        console.error(`[socket] reaction ${action} failed: ${error.message}`)
        respond({ ok: false, error: 'Reaction could not be updated.' })
      }
    }

    socket.on('reaction:add', (payload, acknowledge) => {
      handleReaction(payload, 'add', acknowledge)
    })
    socket.on('reaction:remove', (payload, acknowledge) => {
      handleReaction(payload, 'remove', acknowledge)
    })

    socket.on('message:send', async (payload, acknowledge) => {
      const respond = (result) => {
        if (typeof acknowledge === 'function') acknowledge(result)
      }
      const conversationId = payload?.conversationId
      if (!isUuid(conversationId)) {
        respond({ ok: false, error: 'Conversation ID must be a valid UUID.' })
        return
      }

      let attachmentFields = null
      let messageBody = payload?.body
      if (payload?.attachment !== undefined) {
        const result = validateAttachmentPayload(
          payload.attachment,
          conversationId,
          userId,
        )
        if (result.error) {
          respond({ ok: false, error: result.error })
          return
        }
        attachmentFields = result.attachment
        if (!messageBody) messageBody = attachmentFields.attachment_name
      }

      const { text, error: validationError } = validateMessageBody(messageBody)
      if (validationError) {
        respond({ ok: false, error: validationError })
        return
      }

      const replyToId = payload?.replyToId ?? null
      if (replyToId !== null && !isUuid(replyToId)) {
        respond({ ok: false, error: 'Reply target is invalid.' })
        return
      }

      const clientId = payload?.clientId
      if (clientId !== undefined && !isUuid(clientId)) {
        respond({ ok: false, error: 'Message request ID is invalid.' })
        return
      }

      try {
        const allowed = await hasConversationAccess(
          socket.data.supabase,
          conversationId,
        )
        if (!allowed) {
          respond({ ok: false, error: 'You are not a member of this conversation.' })
          return
        }

        if (replyToId) {
          const { data: replyTarget, error: replyError } = await socket.data.supabase
            .from('messages')
            .select('id')
            .eq('id', replyToId)
            .eq('conversation_id', conversationId)
            .maybeSingle()
          if (replyError) throw replyError
          if (!replyTarget) {
            respond({ ok: false, error: 'Replies must reference a message in this conversation.' })
            return
          }
        }

        const messageRecord = {
          ...buildMessageInsert(conversationId, userId, text),
          ...(attachmentFields || {}),
          ...(replyToId ? { reply_to_id: replyToId } : {}),
        }
        const { data: message, error } = await socket.data.supabase
          .from('messages')
          .insert(messageRecord)
          .select('id, conversation_id, sender_id, body, created_at, message_type, attachment_path, attachment_name, attachment_mime, attachment_size, reply_to_id, deleted_at')
          .single()

        if (error || !message) {
          console.error(`[socket] message insert failed for ${socket.id}: ${error?.message || 'no row returned'}`)
          respond({ ok: false, error: 'Message could not be sent. Please try again.' })
          return
        }

        if (!await hasConversationAccess(socket.data.supabase, conversationId)) {
          respond({ ok: true, message, clientId })
          return
        }
        io.to(`conversation:${conversationId}`).emit('message:new', { message, clientId })
        notifyMessageForConversation(message.id, io)
          .catch(() => console.error('[notifications] Message alert delivery could not be started.'))
        deliverPushForMessage(
          message.id,
          message.message_type === 'text' ? message.body : '',
          io,
        ).catch(() => console.error('[push] Message delivery could not be started.'))
        socketState.stopTyping(conversationId, userId, socket.id)
        socket.data.typingStartTimes.delete(conversationId)
        respond({ ok: true, message, clientId })
      } catch (error) {
        console.error(`[socket] message send failed: ${error.message}`)
        respond({ ok: false, error: 'Message could not be sent. Please try again.' })
      }
    })

    socket.on('disconnect', (reason) => {
      const offlineRecipients = socketState.getPartners(userId)
      const becameOffline = socket.data.presenceRegistered &&
        socketState.disconnect(userId, socket.id)
      if (becameOffline) {
        socketState.clearPartners(userId)
        for (const partner of offlineRecipients) {
          io.to(`user:${partner.partner_id}`).emit('presence:update', {
            conversationId: partner.conversation_id,
            userId,
            online: false,
          })
        }
      }
      console.info(`[socket] disconnected: ${reason}`)
    })
  })

  return io
}

module.exports = { attachSockets }
