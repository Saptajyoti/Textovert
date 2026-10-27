const express = require('express')
const helmet = require('helmet')
const rateLimit = require('express-rate-limit')
const cors = require('cors')
const { corsOptions } = require('./config/cors')
const authRoutes = require('./routes/auth')
const conversationRoutes = require('./routes/conversations')
const healthRoutes = require('./routes/health')
const { errorHandler, notFound } = require('./middleware/errorHandler')

const app = express()

app.disable('x-powered-by')
app.set('trust proxy', 1)
app.use(helmet())
app.use(cors(corsOptions()))
app.use(express.json({ limit: '100kb' }))
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 100,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
}))
app.use('/api', healthRoutes)
app.use('/api/auth', authRoutes)
app.use('/api/conversations', conversationRoutes)
app.use(notFound)
app.use(errorHandler)

module.exports = app
