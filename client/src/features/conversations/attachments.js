import { getAccessToken, getSocketUrl } from '../../lib/messaging.js'

export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024

const MIME_EXTENSIONS = new Map([
  ['image/jpeg', ['jpg', 'jpeg']],
  ['image/png', ['png']],
  ['image/webp', ['webp']],
  ['application/pdf', ['pdf']],
  ['text/plain', ['txt']],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', ['docx']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ['xlsx']],
])

function bytesMatch(bytes, expected, offset = 0) {
  return expected.every((value, index) => bytes[offset + index] === value)
}

async function validateFileContent(file) {
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (file.type === 'image/jpeg') return bytesMatch(bytes, [0xff, 0xd8, 0xff])
  if (file.type === 'image/png') {
    return bytesMatch(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  }
  if (file.type === 'image/webp') {
    return bytesMatch(bytes, [0x52, 0x49, 0x46, 0x46]) &&
      bytesMatch(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  }
  if (file.type === 'application/pdf') return bytesMatch(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])
  if (file.type === 'text/plain') {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      return !bytes.some((value) => value === 0)
    } catch {
      return false
    }
  }
  if (file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    file.type === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
    return isExpectedOfficeArchive(bytes, file.type)
  }
  return false
}

function isExpectedOfficeArchive(bytes, mimeType) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let endOffset = -1
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset -= 1) {
    if (view.getUint32(offset, true) === 0x06054b50) {
      endOffset = offset
      break
    }
  }
  if (endOffset < 0) return false
  const entryCount = view.getUint16(endOffset + 10, true)
  let cursor = view.getUint32(endOffset + 16, true)
  const requiredFiles = mimeType.includes('wordprocessing')
    ? ['[Content_Types].xml', 'word/document.xml']
    : ['[Content_Types].xml', 'xl/workbook.xml']
  const names = new Set()
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) return false
    const nameLength = view.getUint16(cursor + 28, true)
    const extraLength = view.getUint16(cursor + 30, true)
    const commentLength = view.getUint16(cursor + 32, true)
    const nameStart = cursor + 46
    const nameEnd = nameStart + nameLength
    if (nameEnd > bytes.length) return false
    names.add(new TextDecoder().decode(bytes.subarray(nameStart, nameEnd)))
    cursor = nameEnd + extraLength + commentLength
  }
  return requiredFiles.every((name) => names.has(name))
}

export async function validateAttachment(file) {
  if (!(file instanceof File)) throw new Error('Choose a file to attach.')
  if (file.size < 1 || file.size > MAX_ATTACHMENT_SIZE) {
    throw new Error('Attachments must be smaller than 10 MB.')
  }
  const extensions = MIME_EXTENSIONS.get(file.type)
  const extension = file.name.split('.').at(-1)?.toLowerCase()
  if (!extensions || !extensions.includes(extension) || !(await validateFileContent(file))) {
    throw new Error('This file type is unsupported or its contents do not match its format.')
  }
  return {
    type: file.type.startsWith('image/') ? 'image' : 'file',
    name: file.name,
    mimeType: file.type,
    size: file.size,
  }
}

export async function uploadAttachment(file, conversationId, onProgress, signal) {
  const metadata = await validateAttachment(file)
  if (signal.aborted) throw new DOMException('Upload cancelled.', 'AbortError')
  const accessToken = await getAccessToken()

  const uploaded = await new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    const abort = () => request.abort()
    if (signal.aborted) {
      reject(new DOMException('Upload cancelled.', 'AbortError'))
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    request.open('POST', `${getSocketUrl()}/api/conversations/media/${encodeURIComponent(conversationId)}`)
    request.setRequestHeader('Authorization', `Bearer ${accessToken}`)
    request.setRequestHeader('Content-Type', 'application/octet-stream')
    request.setRequestHeader('X-File-Name', encodeURIComponent(metadata.name))
    request.setRequestHeader('X-File-Mime', metadata.mimeType)
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(Math.round((event.loaded / event.total) * 100))
    }
    request.onload = () => {
      signal.removeEventListener('abort', abort)
      let result
      try {
        result = JSON.parse(request.responseText)
      } catch {
        reject(new Error('The upload server returned an invalid response.'))
        return
      }
      if (request.status >= 200 && request.status < 300 && result.attachment) {
        resolve(result)
      } else {
        reject(new Error(result.error || 'Upload failed. Check your connection and try again.'))
      }
    }
    request.onerror = () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('Upload failed due to a network error.'))
    }
    request.onabort = () => {
      signal.removeEventListener('abort', abort)
      reject(new DOMException('Upload cancelled.', 'AbortError'))
    }
    request.send(file)
  })

  return uploaded.attachment
}

export function formatFileSize(size) {
  if (!Number.isFinite(size) || size < 0) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(0)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
