const test = require('node:test')
const assert = require('node:assert/strict')
const { MAX_ATTACHMENT_SIZE, validateAttachmentPayload } = require('../src/realtime/messaging')
const { validateUpload } = require('../src/routes/media')

const conversationId = '0f8fad5b-d9cb-469f-a165-70867728950f'
const userId = '0f8fad5b-d9cb-469f-a165-70867728950e'

test('validates attachment payload paths against the verified sender and conversation', () => {
  const attachment = {
    type: 'image',
    path: `${conversationId}/${userId}/0f8fad5b-d9cb-469f-a165-70867728950d`,
    name: 'photo.png',
    mimeType: 'image/png',
    size: 12,
  }
  assert.deepEqual(
    validateAttachmentPayload(attachment, conversationId, userId).attachment,
    {
      message_type: 'image',
      attachment_path: attachment.path,
      attachment_name: attachment.name,
      attachment_mime: attachment.mimeType,
      attachment_size: attachment.size,
    },
  )
  assert.match(
    validateAttachmentPayload({ ...attachment, path: `0f8fad5b-d9cb-469f-a165-70867728950c/${userId}/0f8fad5b-d9cb-469f-a165-70867728950d` }, conversationId, userId).error,
    /invalid or unsupported/,
  )
  assert.match(
    validateAttachmentPayload({ ...attachment, path: `${conversationId}/${userId}/0f8fad5b-d9cb-469f-a165-70867728950d` }, conversationId, '0f8fad5b-d9cb-469f-a165-70867728950c').error,
    /invalid or unsupported/,
  )
  assert.match(
    validateAttachmentPayload({ ...attachment, size: MAX_ATTACHMENT_SIZE + 1 }, conversationId, userId).error,
    /invalid or unsupported/,
  )
})

test('validates upload signatures and rejects MIME or extension spoofing', () => {
  assert.deepEqual(
    validateUpload(Buffer.from('Hello, Textovert!\n'), 'notes.txt', 'text/plain'),
    { name: 'notes.txt', mimeType: 'text/plain', size: 18 },
  )
  assert.match(validateUpload(Buffer.from('not a PDF'), 'report.pdf', 'application/pdf').error, /contents do not match/)
  assert.match(validateUpload(Buffer.from('%PDF-1.7'), 'report.exe', 'application/pdf').error, /contents do not match/)
  assert.match(validateUpload(Buffer.from([0xff, 0xd8, 0xff]), 'photo.jpg', 'image/png').error, /contents do not match/)
  assert.match(validateUpload(Buffer.alloc(MAX_ATTACHMENT_SIZE + 1), 'large.txt', 'text/plain').error, /smaller than 10 MB/)
})
