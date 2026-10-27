class SocketState {
  constructor({ typingTimeoutMs = 4000 } = {}) {
    this.typingTimeoutMs = typingTimeoutMs
    this.userSockets = new Map()
    this.userPartners = new Map()
    this.typingByConversation = new Map()
    this.typingBySocket = new Map()
  }

  connect(userId, socketId) {
    let sockets = this.userSockets.get(userId)
    if (!sockets) {
      sockets = new Set()
      this.userSockets.set(userId, sockets)
    }
    sockets.add(socketId)
    return sockets.size === 1
  }

  disconnect(userId, socketId) {
    this.stopSocketTyping(socketId)
    const sockets = this.userSockets.get(userId)
    if (!sockets) return false
    sockets.delete(socketId)
    if (sockets.size) return false
    this.userSockets.delete(userId)
    return true
  }

  isOnline(userId) {
    return Boolean(this.userSockets.get(userId)?.size)
  }

  addPartners(userId, partners) {
    let knownPartners = this.userPartners.get(userId)
    if (!knownPartners) {
      knownPartners = new Map()
      this.userPartners.set(userId, knownPartners)
    }

    const newPartners = []
    for (const partner of partners) {
      if (!knownPartners.has(partner.conversation_id)) newPartners.push(partner)
      knownPartners.set(partner.conversation_id, partner)
    }
    return newPartners
  }

  getPartners(userId) {
    return [...(this.userPartners.get(userId)?.values() || [])]
  }

  clearPartners(userId) {
    this.userPartners.delete(userId)
  }

  startTyping(conversationId, userId, socketId, emit) {
    let users = this.typingByConversation.get(conversationId)
    if (!users) {
      users = new Map()
      this.typingByConversation.set(conversationId, users)
    }
    let sockets = users.get(userId)
    if (!sockets) {
      sockets = new Map()
      users.set(userId, sockets)
    }

    const wasTyping = sockets.size > 0
    const previous = sockets.get(socketId)
    if (previous) clearTimeout(previous.timer)
    const entry = {
      emit,
      timer: setTimeout(
        () => this.stopTyping(conversationId, userId, socketId),
        this.typingTimeoutMs,
      ),
    }
    sockets.set(socketId, entry)

    let socketConversations = this.typingBySocket.get(socketId)
    if (!socketConversations) {
      socketConversations = new Set()
      this.typingBySocket.set(socketId, socketConversations)
    }
    socketConversations.add(conversationId)

    if (!wasTyping) emit({ conversationId, userId, typing: true })
  }

  stopTyping(conversationId, userId, socketId) {
    const users = this.typingByConversation.get(conversationId)
    const sockets = users?.get(userId)
    const entry = sockets?.get(socketId)
    if (!entry) return

    clearTimeout(entry.timer)
    sockets.delete(socketId)
    const socketConversations = this.typingBySocket.get(socketId)
    socketConversations?.delete(conversationId)
    if (socketConversations?.size === 0) this.typingBySocket.delete(socketId)

    if (sockets.size) return
    users.delete(userId)
    if (users.size === 0) this.typingByConversation.delete(conversationId)
    entry.emit({ conversationId, userId, typing: false })
  }

  stopSocketTyping(socketId) {
    const conversations = this.typingBySocket.get(socketId)
    if (!conversations) return
    for (const conversationId of [...conversations]) {
      const users = this.typingByConversation.get(conversationId)
      for (const userId of users?.keys() || []) {
        if (users.get(userId).has(socketId)) {
          this.stopTyping(conversationId, userId, socketId)
          break
        }
      }
    }
  }
}

module.exports = { SocketState }
