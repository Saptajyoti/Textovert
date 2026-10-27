const test = require('node:test')
const assert = require('node:assert/strict')
const { authenticateSocketToken } = require('../src/realtime/authenticateSocket')
const {
  MAX_MESSAGE_LENGTH,
  buildMessageInsert,
  hasPrivateConversationMembership,
  validateMessageBody,
} = require('../src/realtime/messaging')

test('rejects empty and non-string message bodies', () => {
  assert.match(validateMessageBody('   ').error, /cannot be empty/)
  assert.match(validateMessageBody(null).error, /must be a string/)
})

test('trims message bodies and validates the database character limit', () => {
  assert.deepEqual(validateMessageBody('  hello  '), { text: 'hello' })
  assert.equal(validateMessageBody('🙂'.repeat(MAX_MESSAGE_LENGTH)).text.length, MAX_MESSAGE_LENGTH * 2)
  assert.match(validateMessageBody('🙂'.repeat(MAX_MESSAGE_LENGTH + 1)).error, /cannot exceed/)
})

test('builds inserts from verified identity instead of client sender fields', () => {
  const userId = '0f8fad5b-d9cb-469f-a165-70867728950e'
  const record = buildMessageInsert('0f8fad5b-d9cb-469f-a165-70867728950f', userId, 'hello')
  assert.deepEqual(record, {
    conversation_id: '0f8fad5b-d9cb-469f-a165-70867728950f',
    sender_id: userId,
    body: 'hello',
  })
  assert.equal(Object.hasOwn(record, 'client_sender_id'), false)
})

test('checks private conversation membership for the verified user', async () => {
  let rpcCall
  const supabase = {
    async rpc(name, parameters) {
      rpcCall = { name, parameters }
      return { data: true, error: null }
    },
  }

  assert.equal(await hasPrivateConversationMembership(supabase, '0f8fad5b-d9cb-469f-a165-70867728950f'), true)
  assert.deepEqual(rpcCall, {
    name: 'can_access_private_conversation',
    parameters: { p_conversation_id: '0f8fad5b-d9cb-469f-a165-70867728950f' },
  })
})

test('fails closed when the database cannot verify private membership', async () => {
  await assert.rejects(hasPrivateConversationMembership({
    rpc: async () => ({ data: null, error: new Error('database unavailable') }),
  }, '0f8fad5b-d9cb-469f-a165-70867728950f'), /Could not verify/)
})

test('authenticates the Socket.IO token and derives its user from Supabase', async () => {
  const token = 'header.payload.signature'
  const user = { id: 'verified-user-id' }
  let usedToken
  const createClient = (accessToken) => {
    usedToken = accessToken
    return { auth: { getUser: async () => ({ data: { user }, error: null }) } }
  }

  const result = await authenticateSocketToken(token, createClient)
  assert.equal(usedToken, token)
  assert.equal(result.user, user)
})

test('rejects missing or expired Socket.IO access tokens', async () => {
  await assert.rejects(authenticateSocketToken('', () => {
    throw new Error('Client must not be created for invalid input')
  }), /valid Supabase access token/)
  await assert.rejects(authenticateSocketToken('header.payload.signature', () => ({
    auth: { getUser: async () => ({ data: { user: null }, error: new Error('expired') }) },
  })), /invalid or expired/)
})
