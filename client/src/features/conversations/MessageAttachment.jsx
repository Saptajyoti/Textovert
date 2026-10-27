import { useEffect, useRef, useState } from 'react'
import { Download, FileText, Image as ImageIcon, LoaderCircle, X } from 'lucide-react'
import { formatFileSize } from './attachments.js'
import { messagingRequest } from '../../lib/messaging.js'

export default function MessageAttachment({ message }) {
  const [signedUrl, setSignedUrl] = useState('')
  const [loadError, setLoadError] = useState('')
  const [downloading, setDownloading] = useState(false)
  const [showImage, setShowImage] = useState(false)
  const imageDialogRef = useRef(null)

  useEffect(() => {
    let active = true
    messagingRequest('/conversations/media/sign', {
      method: 'POST',
      body: JSON.stringify({ messageId: message.id }),
    }).then((result) => {
      if (active) setSignedUrl(result.url)
    }).catch((error) => {
      if (active) setLoadError(error.message)
    })
    return () => { active = false }
  }, [message.id])

  useEffect(() => {
    if (!showImage) return undefined
    const dialog = imageDialogRef.current
    if (dialog && !dialog.open) dialog.showModal()
    return () => {
      if (dialog?.open) dialog.close()
    }
  }, [showImage])

  async function downloadFile() {
    if (!signedUrl || downloading) return
    setDownloading(true)
    setLoadError('')
    try {
      const { url } = await messagingRequest('/conversations/media/sign', {
        method: 'POST',
        body: JSON.stringify({ messageId: message.id }),
      })
      const response = await fetch(url)
      if (!response.ok) throw new Error('The attachment could not be downloaded.')
      const objectUrl = URL.createObjectURL(await response.blob())
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = message.attachment_name || 'attachment'
      document.body.append(link)
      link.click()
      link.remove()
      URL.revokeObjectURL(objectUrl)
    } catch (error) {
      setLoadError(error.message)
    } finally {
      setDownloading(false)
    }
  }

  if (message.message_type === 'image') {
    return (
      <>
        {signedUrl ? (
          <button className="attachment-image-button" type="button" onClick={() => setShowImage(true)} aria-label={`View image ${message.attachment_name}`}>
            <img className="attachment-image" src={signedUrl} alt={message.attachment_name} loading="lazy" />
          </button>
        ) : (
          <div className="attachment-unavailable">
            {loadError ? 'Image unavailable' : <><LoaderCircle className="loading-icon" size={15} /> Loading image…</>}
          </div>
        )}
        {showImage && (
          <dialog ref={imageDialogRef} className="image-viewer" aria-label={message.attachment_name} onCancel={(event) => {
            event.preventDefault()
            setShowImage(false)
          }} onClick={(event) => {
            if (event.target === event.currentTarget) setShowImage(false)
          }}>
            <button type="button" className="image-viewer-close" onClick={() => setShowImage(false)} aria-label="Close image viewer" autoFocus><X size={20} /></button>
            <img src={signedUrl} alt={message.attachment_name} />
            <button type="button" className="image-viewer-download" onClick={downloadFile} disabled={downloading} aria-label={`Download ${message.attachment_name}`}>
              {downloading ? <LoaderCircle className="loading-icon" size={17} /> : <Download size={17} />}
            </button>
          </dialog>
        )}
        {loadError && <p className="attachment-error" role="status">{loadError}</p>}
      </>
    )
  }

  return (
    <div className="attachment-card">
      <span className="attachment-file-icon">{message.attachment_mime === 'application/pdf' || message.attachment_mime === 'text/plain' ? <FileText size={17} /> : <ImageIcon size={17} />}</span>
      <span className="attachment-file-copy">
        <strong title={message.attachment_name}>{message.attachment_name}</strong>
        <small>{message.attachment_mime?.split('/').at(-1)?.toUpperCase()} · {formatFileSize(message.attachment_size)}</small>
      </span>
      <button type="button" className="attachment-download" onClick={downloadFile} disabled={!signedUrl || downloading} aria-label={`Download ${message.attachment_name}`}>
        {downloading ? <LoaderCircle className="loading-icon" size={16} /> : <Download size={16} />}
      </button>
      {loadError && <span className="attachment-error" role="status">{loadError}</span>}
    </div>
  )
}
