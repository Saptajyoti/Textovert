const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { randomBytes } = require('node:crypto')

process.env.NODE_ENV = 'production'
process.env.CLIENT_URL = 'https://trusted.example'

const { attachSockets } = require('../src/sockets')

function openWebSocketHandshake(port, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /socket.io/?EIO=4&transport=websocket HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
        'Sec-WebSocket-Version: 13',
        `Origin: ${origin}`,
        '',
        '',
      ].join('\r\n'))
    })

    let response = ''
    socket.setTimeout(3000, () => {
      socket.destroy()
      reject(new Error('WebSocket handshake timed out.'))
    })
    socket.on('data', (chunk) => {
      response += chunk.toString()
      const status = response.match(/^HTTP\/1\.1 (\d{3})/)
      if (!status) return
      socket.destroy()
      resolve(Number(status[1]))
    })
    socket.on('error', reject)
  })
}

test('WebSocket handshake allows the configured origin and rejects an untrusted origin', async (t) => {
  const server = http.createServer()
  const io = attachSockets(server)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()

  t.after(() => new Promise((resolve) => io.close(resolve)))

  assert.equal(await openWebSocketHandshake(port, 'https://trusted.example'), 101)
  assert.notEqual(await openWebSocketHandshake(port, 'https://untrusted.example'), 101)
})
