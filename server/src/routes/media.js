const express = require('express')
const rateLimit = require('express-rate-limit')
const { randomUUID } = require('node:crypto')
const { requireAuth } = require('../middleware/requireAuth')
const { createStorageAdminClient } = require('../lib/supabase')
const { MAX_ATTACHMENT_SIZE, ATTACHMENT_MIME_TYPES, hasConversationAccess, isUuid } = require('../realtime/messaging')

const router = express.Router()
const OFFICE_MIMES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
}
const EXTENSIONS = new Map([
  ['image/jpeg', new Set(['jpg', 'jpeg'])],
  ['image/png', new Set(['png'])],
  ['image/webp', new Set(['webp'])],
  ['application/pdf', new Set(['pdf'])],
  ['text/plain', new Set(['txt'])],
  [OFFICE_MIMES.docx, new Set(['docx'])],
  [OFFICE_MIMES.xlsx, new Set(['xlsx'])],
])

const uploadRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => req.user.id,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: 'Too many uploads. Try again later.' }),
})

function isOfficeArchive(buffer, mimeType) {
  let endOffset = -1
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) return false
  const entryCount = buffer.readUInt16LE(endOffset + 10)
  let cursor = buffer.readUInt32LE(endOffset + 16)
  const required = mimeType === OFFICE_MIMES.docx
    ? ['[Content_Types].xml', 'word/document.xml']
    : ['[Content_Types].xml', 'xl/workbook.xml']
  const names = new Set()
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) return false
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > buffer.length) return false
    names.add(buffer.subarray(nameStart, nameEnd).toString('utf8'))
    cursor = nameEnd + extraLength + commentLength
  }
  return required.every((name) => names.has(name))
}

function contentMatches(buffer, mimeType) {
  if (mimeType === 'image/jpeg') return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
  if (mimeType === 'image/png') return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  if (mimeType === 'image/webp') {
    return buffer.length >= 12 &&
      buffer.toString('ascii', 0, 4) === 'RIFF' &&
      buffer.toString('ascii', 8, 12) === 'WEBP'
  }
  if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString('ascii') === '%PDF-'
  if (mimeType === 'text/plain') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(buffer)
      return !buffer.includes(0)
    } catch {
      return false
    }
  }
  if (mimeType === OFFICE_MIMES.docx || mimeType === OFFICE_MIMES.xlsx) {
    return buffer.length >= 4 &&
      buffer.readUInt32LE(0) === 0x04034b50 &&
      isOfficeArchive(buffer, mimeType)
  }
  return false
}

function validateUpload(buffer, name, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 1 || buffer.length > MAX_ATTACHMENT_SIZE) {
    return { error: 'Attachments must be smaller than 10 MB.' }
  }
  if (typeof name !== 'string' || name.length < 1 || [...name].length > 255 ||
    name.includes('/') || name.includes('\\') ||
    [...name].some((character) => character.charCodeAt(0) <= 31) || name.trim() !== name) {
    return { error: 'The attachment filename is invalid.' }
  }
  if (!ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return { error: 'This attachment type is not supported.' }
  }
  const extension = name.split('.').at(-1)?.toLowerCase()
  if (!EXTENSIONS.get(mimeType)?.has(extension) || !contentMatches(buffer, mimeType)) {
    return { error: 'The file contents do not match a supported file type.' }
  }
  return { name, mimeType, size: buffer.length }
}

router.post(
  '/:conversationId',
  requireAuth,
  uploadRateLimit,
  express.raw({ type: 'application/octet-stream', limit: MAX_ATTACHMENT_SIZE }),
  async (req, res, next) => {
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

      let filename
      try {
        filename = decodeURIComponent(req.get('x-file-name') || '')
      } catch {
        res.status(400).json({ error: 'The attachment filename is invalid.' })
        return
      }
      const mimeType = req.get('x-file-mime')
      const validation = validateUpload(req.body, filename, mimeType)
      if (validation.error) {
        res.status(400).json({ error: validation.error })
        return
      }

      const path = `${conversationId}/${req.user.id}/${randomUUID()}`
      const { error } = await createStorageAdminClient().storage
        .from('conversation-media')
        .upload(path, req.body, { contentType: mimeType, upsert: false })
      if (error) throw error

      res.status(201).json({
        attachment: {
          type: mimeType.startsWith('image/') ? 'image' : 'file',
          path,
          name: validation.name,
          mimeType: validation.mimeType,
          size: validation.size,
        },
      })
    } catch (error) {
      next(error)
    }
  },
)

module.exports = { router, validateUpload }
