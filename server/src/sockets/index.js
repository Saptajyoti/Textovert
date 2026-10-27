const { Server } = require('socket.io')
const { allowedOrigins, allowSocketRequest } = require('../config/cors')
const { authenticateSocketToken } = require('../realtime/authenticateSocket')
const {
  buildMessageInsert,
  hasPrivateConversationMembership,
  isUuid,
  validateMessageBody,
} = require('../realtime/messaging')

function attachSockets(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
    allowRequest: allowSocketRequest,
  })

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
    console.info(`[socket] connected ${socket.id}`)

    socket.on('conversation:join', async (payload, acknowledge) => {
      const respond = (result) => {
        if (typeof acknowledge === 'function') acknowledge(result)
      }
      const conversationId = payload?.conversationId
      if (!isUuid(conversationId)) {
        respond({ ok: false, error: 'Conversation ID must be a valid UUID.' })
        return
      }

      try {
        const allowed = await hasPrivateConversationMembership(
          socket.data.supabase,
          conversationId,
        )
        if (!allowed) {
          respond({ ok: false, error: 'You are not a member of this conversation.' })
          return
        }
        await socket.join(`conversation:${conversationId}`)
        respond({ ok: true })
      } catch (error) {
        console.error(`[socket] membership check failed for ${socket.id}: ${error.message}`)
        respond({ ok: false, error: 'Could not verify access to this conversation.' })
      }
    })

    socket.on('conversation:leave', (payload) => {
      if (isUuid(payload?.conversationId)) {
        socket.leave(`conversation:${payload.conversationId}`)
      }
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

      const { text, error: validationError } = validateMessageBody(payload?.body)
      if (validationError) {
        respond({ ok: false, error: validationError })
        return
      }

      const clientId = payload?.clientId
      if (clientId !== undefined && !isUuid(clientId)) {
        respond({ ok: false, error: 'Message request ID is invalid.' })
        return
      }

      try {
        const allowed = await hasPrivateConversationMembership(
          socket.data.supabase,
          conversationId,
        )
        if (!allowed) {
          respond({ ok: false, error: 'You are not a member of this conversation.' })
          return
        }

        const { data: message, error } = await socket.data.supabase
          .from('messages')
          .insert(buildMessageInsert(conversationId, socket.data.user.id, text))
          .select('id, conversation_id, sender_id, body, created_at')
          .single()

        if (error || !message) {
          console.error(`[socket] message insert failed for ${socket.id}: ${error?.message || 'no row returned'}`)
          respond({ ok: false, error: 'Message could not be sent. Please try again.' })
          return
        }

        io.to(`conversation:${conversationId}`).emit('message:new', { message, clientId })
        respond({ ok: true, message, clientId })
      } catch (error) {
        console.error(`[socket] message send failed for ${socket.id}: ${error.message}`)
        respond({ ok: false, error: 'Message could not be sent. Please try again.' })
      }
    })

    socket.on('disconnect', (reason) => {
      console.info(`[socket] disconnected ${socket.id}: ${reason}`)
    })
  })

  return io
}

module.exports = { attachSockets }
