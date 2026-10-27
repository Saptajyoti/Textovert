const test = require('node:test')
const assert = require('node:assert/strict')
const { SocketState } = require('../src/realtime/socketState')

test('presence remains online until the last authenticated socket disconnects', () => {
  const state = new SocketState()
  assert.equal(state.connect('user-a', 'socket-a'), true)
  assert.equal(state.connect('user-a', 'socket-b'), false)
  assert.equal(state.isOnline('user-a'), true)
  assert.equal(state.disconnect('user-a', 'socket-a'), false)
  assert.equal(state.isOnline('user-a'), true)
  assert.equal(state.disconnect('user-a', 'socket-b'), true)
  assert.equal(state.isOnline('user-a'), false)
})

test('authorized partner conversations are accumulated across devices', () => {
  const state = new SocketState()
  state.addPartners('user-a', [{ conversation_id: 'conversation-a', partner_id: 'user-b' }])
  state.addPartners('user-a', [{ conversation_id: 'conversation-b', partner_id: 'user-c' }])

  assert.deepEqual(
    state.getPartners('user-a').map((partner) => partner.conversation_id).sort(),
    ['conversation-a', 'conversation-b'],
  )
  state.clearPartners('user-a')
  assert.deepEqual(state.getPartners('user-a'), [])
})

test('typing indicators stop after inactivity and are shared across a user’s sockets', async () => {
  const state = new SocketState({ typingTimeoutMs: 30 })
  const events = []
  const notify = (event) => events.push(event)

  state.startTyping('conversation-a', 'user-a', 'socket-a', notify)
  state.startTyping('conversation-a', 'user-a', 'socket-b', notify)
  assert.deepEqual(events.map((event) => event.typing), [true])

  state.stopTyping('conversation-a', 'user-a', 'socket-a')
  assert.deepEqual(events.map((event) => event.typing), [true])

  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(events.map((event) => event.typing), [true, false])
  assert.equal(state.typingByConversation.size, 0)
})

test('disconnecting a typing socket clears its active indicator', () => {
  const state = new SocketState()
  const events = []
  state.connect('user-a', 'socket-a')
  state.startTyping('conversation-a', 'user-a', 'socket-a', (event) => events.push(event))

  assert.equal(state.disconnect('user-a', 'socket-a'), true)
  assert.deepEqual(events.map((event) => event.typing), [true, false])
  assert.equal(state.typingByConversation.size, 0)
})
