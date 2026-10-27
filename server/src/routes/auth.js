const express = require('express')
const { requireAuth } = require('../middleware/requireAuth')

const router = express.Router()

router.get('/me', requireAuth, (req, res) => {
  res.json({
    user: {
      id: req.user.id,
      email: req.user.email,
    },
  })
})

module.exports = router
