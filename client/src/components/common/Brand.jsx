import { MessageCircle } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function Brand({ compact = false }) {
  return (
    <Link className={`brand${compact ? ' brand-compact' : ''}`} to="/" aria-label="Textovert home">
      <span className="brand-mark"><MessageCircle size={19} strokeWidth={2.1} /></span>
      {!compact && <span>textovert</span>}
    </Link>
  )
}
