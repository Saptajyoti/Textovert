import { motion as Motion } from 'framer-motion'
import { ArrowRight, Check, LockKeyhole, MessageCircle, Paperclip, Search, Send, Sparkles } from 'lucide-react'
import { Link } from 'react-router-dom'
import Brand from '../components/common/Brand.jsx'

const previewMessages = [
  { label: 'Maya', text: 'A little fresh air and a long catch-up?', tone: 'received' },
  { label: 'You', text: 'That sounds like just what I need.', tone: 'sent' },
]

export default function LandingPage() {
  return (
    <main className="landing">
      <nav className="site-nav">
        <Brand />
        <div className="nav-actions"><Link className="nav-signin" to="/login">Sign in</Link><Link className="button button-dark button-small" to="/register">Get started <ArrowRight size={15} /></Link></div>
      </nav>
      <section className="hero">
        <div className="hero-copy">
          <Motion.div className="eyebrow hero-eyebrow" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
            <Sparkles size={14} /> A calmer kind of connection
          </Motion.div>
          <Motion.h1 initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.55, delay: 0.08 }}>
            Good conversations<br />feel like <span>coming home.</span>
          </Motion.h1>
          <Motion.p className="hero-description" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.18 }}>
            Textovert is a thoughtful space for the people you want to keep close. Less noise, more of what matters.
          </Motion.p>
          <Motion.div className="hero-actions" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.26 }}>
            <Link className="button button-primary" to="/register">Get started <ArrowRight size={16} /></Link>
            <Link className="button button-quiet" to="/login">Sign in</Link>
          </Motion.div>
          <p className="hero-note"><LockKeyhole size={14} /> Made for meaningful, private conversations.</p>
        </div>
        <Motion.div className="preview-wrap" initial={{ opacity: 0, y: 22, rotate: 1 }} animate={{ opacity: 1, y: 0, rotate: 0 }} transition={{ duration: 0.7, delay: 0.2 }}>
          <div className="preview-glow" />
          <div className="chat-preview" aria-label="Illustrative preview of a Textovert conversation">
            <div className="preview-top">
              <div className="window-dots"><i /><i /><i /></div>
              <span className="preview-caption">A glimpse inside</span>
              <span className="preview-search"><Search size={15} /></span>
            </div>
            <div className="preview-body">
              <aside className="preview-list">
                <div className="preview-list-title">Messages <span>•</span></div>
                {['Maya Chen', 'Sunday studio', 'Noah Williams', 'Elena Park'].map((name, index) => (
                  <div className={`preview-person${index === 0 ? ' selected' : ''}`} key={name}>
                    <span className={`avatar avatar-${['lavender', 'peach', 'mint', 'blue'][index]}`}>{name.split(' ').map((part) => part[0]).join('')}</span>
                    <span className="preview-person-copy"><strong>{name}</strong><small>{['That sounds like a lovely plan.', 'Ari: sketches soon', 'Thank you for sending that', 'See you there!'][index]}</small></span>
                    {index === 0 && <i className="unread-dot" />}
                  </div>
                ))}
              </aside>
              <div className="preview-conversation">
                <div className="preview-chat-head"><span className="avatar avatar-lavender">MC</span><span><strong>Maya Chen</strong><small><i className="online-dot" /> Here now</small></span></div>
                <div className="preview-date">TODAY, 10:42 AM</div>
                <div className="preview-message-group">
                  {previewMessages.map((message) => <div className={`preview-bubble ${message.tone}`} key={message.label}><small>{message.label}</small><span>{message.text}</span><em>10:4{message.tone === 'received' ? '0' : '2'} <Check size={12} /></em></div>)}
                </div>
                <div className="preview-composer"><Paperclip size={16} /><span>Write a message...</span><i><Send size={14} /></i></div>
              </div>
            </div>
            <div className="demo-tag"><MessageCircle size={13} /> Interface preview · sample content</div>
          </div>
        </Motion.div>
      </section>
      <section className="quiet-note"><span className="quiet-line" /><p>More presence. Less pressure.</p><span className="quiet-line" /></section>
      <footer className="site-footer"><Brand /><span>Thoughtful conversations, one at a time.</span><div><Link to="/login">Sign in</Link><Link to="/register">Get started</Link><a href="mailto:hello@textovert.example">Contact</a></div><small>© 2026 Textovert</small></footer>
    </main>
  )
}
