require('dotenv').config()

const express = require('express')
const cors = require('cors')
const fs = require('fs')
const os = require('os')
const path = require('path')
const https = require('https')
const Groq = require('groq-sdk')
const jwt = require('jsonwebtoken')
const { OAuth2Client } = require('google-auth-library')

const app = express()
app.use(cors())
app.use(express.json({ limit: '25mb' })) // audio/screenshots can be large

// Lazy init so a missing key doesn't crash the whole server on boot —
// only AI calls will fail, while auth/payments still work.
let _groq = null
function getGroq() {
  if (!_groq) {
    if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not configured on the server')
    _groq = new Groq({ apiKey: process.env.GROQ_API_KEY })
  }
  return _groq
}

// ── Google auth setup ────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET
const JWT_SECRET           = process.env.APP_SECRET || 'dev-secret'
// Emails that get free TEST mode (comma-separated in OWNER_EMAILS)
const OWNER_EMAILS = (process.env.OWNER_EMAILS || '')
  .split(',').map(e => e.trim().toLowerCase()).filter(Boolean)

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET)

function isOwner(email) {
  return OWNER_EMAILS.includes((email || '').toLowerCase())
}

// Verify the session token the app sends after login; attaches req.user
function requireUser(req, res, next) {
  const header = req.headers.authorization || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null
  if (!token) return res.status(401).json({ error: 'Login required' })
  try {
    req.user = jwt.verify(token, JWT_SECRET)
    next()
  } catch {
    return res.status(401).json({ error: 'Session expired — please sign in again' })
  }
}

// Optional shared secret so only your app can call this backend.
// Set APP_SECRET in the backend .env and the same value in the desktop app.
function checkAuth(req, res, next) {
  const required = process.env.APP_SECRET
  if (!required) return next() // no secret configured = open (fine for testing)
  if (req.headers['x-app-secret'] === required) return next()
  return res.status(401).json({ error: 'Unauthorized' })
}

// ── Health check ───────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({ ok: true, service: 'intrvw-backend' }))

// ── Google login ──────────────────────────────────────────────────────────────────
// The app sends the authorization code + the redirect URI it used. We exchange it
// for tokens, verify the identity, and issue our own session token (JWT).
app.post('/api/auth/google', checkAuth, async (req, res) => {
  const { code, redirectUri } = req.body
  if (!code || !redirectUri) return res.status(400).json({ error: 'Missing code' })

  try {
    const { tokens } = await googleClient.getToken({ code, redirect_uri: redirectUri })
    const ticket = await googleClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_CLIENT_ID
    })
    const payload = ticket.getPayload()
    const email = payload.email
    const name  = payload.name || ''
    const picture = payload.picture || ''

    // Sign a 30-day session token the app will send with future requests
    const sessionToken = jwt.sign(
      { email, name, owner: isOwner(email) },
      JWT_SECRET,
      { expiresIn: '30d' }
    )

    return res.json({ token: sessionToken, email, name, picture, owner: isOwner(email) })
  } catch (err) {
    console.error('[auth]', err.message)
    return res.status(401).json({ error: 'Google sign-in failed. Try again.' })
  }
})

// ── Audio: transcribe + answer ──────────────────────────────────────────────────
app.post('/api/audio', checkAuth, async (req, res) => {
  const { audio, role, resume } = req.body
  if (!audio) return res.json({ skip: true })

  let tmpPath
  try {
    tmpPath = path.join(os.tmpdir(), `intrvw-${Date.now()}.webm`)
    fs.writeFileSync(tmpPath, Buffer.from(audio, 'base64'))

    let transcription
    try {
      const result = await getGroq().audio.transcriptions.create({
        file: fs.createReadStream(tmpPath),
        model: 'whisper-large-v3',
        language: 'en',
        prompt: 'Job interview. Interviewer asking candidate questions about experience, skills, background, and career goals.',
        response_format: 'text'
      })
      transcription = typeof result === 'string' ? result : result.text || ''
    } finally {
      try { fs.unlinkSync(tmpPath) } catch {}
    }

    const transcript = transcription.trim()
    if (!transcript || transcript.length < 8) return res.json({ skip: true })

    let systemMsg = `You are helping an Indian candidate in a live job interview. Your job is simple — look at the transcript, find the question, and give a great answer.

Do NOT analyse who the question is addressed to. Do NOT skip based on names. Just answer.

If there is ANY question or topic — technical, behavioural, career goals, salary, background, motivation, or anything else — respond EXACTLY like this:
QUESTION: <the question>
ANSWER: <the answer — see length rules below>

LENGTH RULES:
- For intro/self-introduction questions ("tell me about yourself", "introduce yourself", "walk me through your background", "tell me something about you"): write a FULL 2-minute spoken introduction — roughly 280-320 words. Cover: who you are, your education (college name, degree, year), your key technical skills, 2-3 specific projects or achievements from the resume with brief details, what you are looking for. Sound natural and warm, like a real Indian student talking in an interview, not reading a script.
- For all other questions: 3-5 sentences is enough.

IMPORTANT: Always use the EXACT details from the resume — real college name, real project names, real skills. Never say vague things like "actively involved in various projects" — name the actual projects.

Only respond with the single word SKIP (nothing else) if the transcript is pure noise, pure silence, or a completely cut-off fragment with no discernible topic.`
    if (role) systemMsg += `\nRole being interviewed for: ${role}`
    if (resume) systemMsg += `\nCandidate's resume (use these exact details in answers):\n${resume}`

    const chat = await getGroq().chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: transcript }
      ],
      temperature: 0.7,
      max_tokens: 800
    })

    const reply = chat.choices[0]?.message?.content?.trim() || ''
    if (!reply || reply.toUpperCase().startsWith('SKIP')) return res.json({ skip: true })

    const qMatch = reply.match(/QUESTION:\s*(.+?)(?:\nANSWER:|$)/s)
    const aMatch = reply.match(/ANSWER:\s*(.+)/s)
    const question = qMatch?.[1]?.trim() || transcript
    const answer = aMatch?.[1]?.trim() || reply

    return res.json({ question, answer })
  } catch (err) {
    console.error('[audio]', err.message)
    return res.status(500).json({ error: err.message?.slice(0, 150) || 'Audio error' })
  }
})

// ── Screen capture: extract questions + answer ────────────────────────────────────
app.post('/api/screen', checkAuth, async (req, res) => {
  const { screenshot, role, resume } = req.body
  if (!screenshot) return res.status(400).json({ error: 'No screenshot' })

  try {
    const extractRes = await getGroq().chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot}` } },
          { type: 'text', text: 'Look at this screenshot. Extract EVERY question or problem statement you can see, numbered exactly as they appear. Output ONLY the list of questions, nothing else. If there are no questions, write: NO_QUESTIONS' }
        ]
      }],
      max_tokens: 400
    })

    const extractedQuestions = extractRes.choices[0]?.message?.content?.trim() || ''
    if (!extractedQuestions || extractedQuestions === 'NO_QUESTIONS') {
      return res.json({ noQuestions: true })
    }

    let answerPrompt = `You are helping an Indian candidate in a job interview. Answer ALL the questions below the way a confident, well-spoken Indian professional would naturally say it — warm, direct, a little humble but not underconfident. Use simple everyday English, not stiff corporate language. Sound like a real person talking, not a textbook. Number your answers to match the questions.
For any intro or background question, mention specific details from the resume — actual college, degree, skills, and projects. Never give a generic answer.`
    if (role) answerPrompt += ` The candidate is applying for: ${role}.`
    if (resume) answerPrompt += `\nCandidate's resume (use these exact details):\n${resume}`
    answerPrompt += `\n\nQuestions:\n${extractedQuestions}`

    const response = await getGroq().chat.completions.create({
      model: 'llama-3.1-8b-instant',
      messages: [{ role: 'user', content: answerPrompt }],
      max_tokens: 1200,
      temperature: 0.7
    })

    const answer = response.choices[0]?.message?.content?.trim() || 'Could not generate answers.'
    return res.json({ answer, extractedQuestions })
  } catch (err) {
    console.error('[screen]', err.message)
    return res.status(500).json({ error: err.message?.slice(0, 150) || 'Screen error' })
  }
})

// ── Text follow-up ────────────────────────────────────────────────────────────────
app.post('/api/ask', checkAuth, async (req, res) => {
  const { question, history = [], role, resume } = req.body
  try {
    let systemMsg = `You are helping an Indian candidate in a live job interview. Answer follow-up questions using the full conversation context. Sound the way a confident, well-spoken Indian professional would naturally talk — warm, direct, a little humble but not underconfident, simple everyday English, not stiff or corporate. Be concise.
For any intro or background question, always use specific details from the resume — actual college, degree, skills, projects. Never be generic.`
    if (role) systemMsg += ` Role: ${role}.`
    if (resume) systemMsg += `\nCandidate's resume (use these exact details):\n${resume}`

    const messages = [{ role: 'system', content: systemMsg }]
    const lastShot = [...history].reverse().find(i => i.screenshot)

    for (const item of history.slice(-6)) {
      if (item.screenshot && item === lastShot) {
        const qText = item.extractedQuestions
          ? `The following questions were visible on screen:\n${item.extractedQuestions}`
          : item.question
        messages.push({
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${item.screenshot}` } },
            { type: 'text', text: qText }
          ]
        })
      } else if (item.extractedQuestions) {
        messages.push({ role: 'user', content: `The following questions were visible on screen:\n${item.extractedQuestions}` })
      } else {
        messages.push({ role: 'user', content: item.question })
      }
      messages.push({ role: 'assistant', content: item.answer })
    }

    if (lastShot) {
      const ctx = lastShot.extractedQuestions
        ? `(Questions from the screen: ${lastShot.extractedQuestions})\n\n${question}`
        : question
      messages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${lastShot.screenshot}` } },
          { type: 'text', text: ctx }
        ]
      })
    } else {
      messages.push({ role: 'user', content: question })
    }

    const model = lastShot ? 'meta-llama/llama-4-scout-17b-16e-instruct' : 'llama-3.1-8b-instant'
    const chat = await getGroq().chat.completions.create({ model, messages, temperature: 0.7, max_tokens: 700 })
    const answer = chat.choices[0]?.message?.content?.trim() || 'No response.'
    return res.json({ answer })
  } catch (err) {
    console.error('[ask]', err.message)
    return res.status(500).json({ error: err.message?.slice(0, 150) || 'Ask error' })
  }
})

// ── Cashfree payment ──────────────────────────────────────────────────────────────
const PLAN_CONFIG = {
  '3hr':     { amount: 999,  creditsMinutes: 180, planType: null },
  '7hr':     { amount: 2499, creditsMinutes: 420, planType: null },
  'monthly': { amount: 1499, creditsMinutes: 0,   planType: 'monthly', days: 30 },
  'yearly':  { amount: 5999, creditsMinutes: 0,   planType: 'yearly',  days: 365 },
}

// Owners use TEST Cashfree (free, test cards). Everyone else uses PRODUCTION (real money).
function cashfreeCreds(owner) {
  if (owner) {
    return {
      host: 'sandbox.cashfree.com',
      appId: process.env.CASHFREE_TEST_APP_ID,
      secret: process.env.CASHFREE_TEST_SECRET,
      payHost: 'payments-test.cashfree.com'
    }
  }
  return {
    host: 'api.cashfree.com',
    appId: process.env.CASHFREE_PROD_APP_ID,
    secret: process.env.CASHFREE_PROD_SECRET,
    payHost: 'payments.cashfree.com'
  }
}

function cashfreeReq(creds, method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: creds.host,
      path: `/pg${endpoint}`,
      method,
      headers: {
        'Content-Type': 'application/json',
        'x-client-id': creds.appId,
        'x-client-secret': creds.secret,
        'x-api-version': '2023-08-01'
      }
    }, r => {
      let raw = ''
      r.on('data', d => raw += d)
      r.on('end', () => { try { resolve(JSON.parse(raw)) } catch { reject(new Error('Bad response')) } })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

app.post('/api/payment/create-order', checkAuth, requireUser, async (req, res) => {
  const { planId } = req.body
  const plan = PLAN_CONFIG[planId]
  if (!plan) return res.json({ error: 'Invalid plan.' })

  const owner = !!req.user.owner
  const creds = cashfreeCreds(owner)
  if (!creds.appId || !creds.secret) {
    return res.json({ error: `Payment not configured (${owner ? 'test' : 'production'}).` })
  }

  const orderId = `INTRVW-${planId.toUpperCase()}-${Date.now()}`
  try {
    const data = await cashfreeReq(creds, 'POST', '/orders', {
      order_id: orderId,
      order_amount: plan.amount,
      order_currency: 'INR',
      customer_details: {
        customer_id: `user-${Date.now()}`,
        customer_email: req.user.email || 'user@intrvw.app',
        customer_phone: '9999999999'
      },
      order_meta: { return_url: `https://intrvw.app/payment-success?order_id=${orderId}` }
    })
    if (!data.payment_session_id) {
      console.error('[cashfree create]', JSON.stringify(data))
      return res.json({ error: 'Could not create order.' })
    }
    const paymentUrl = `https://${creds.payHost}/order/#${data.payment_session_id}`
    return res.json({ orderId, paymentUrl })
  } catch (err) {
    console.error('[cashfree create]', err.message)
    return res.json({ error: err.message })
  }
})

app.post('/api/payment/verify', checkAuth, requireUser, async (req, res) => {
  const { orderId, planId } = req.body
  const creds = cashfreeCreds(!!req.user.owner)
  try {
    const data = await cashfreeReq(creds, 'GET', `/orders/${orderId}`)
    if (data.order_status !== 'PAID') return res.json({ paid: false })

    const plan = PLAN_CONFIG[planId] || {}
    return res.json({
      paid: true,
      creditsMinutes: plan.creditsMinutes || 0,
      planType: plan.planType || null,
      days: plan.days || 0
    })
  } catch (err) {
    console.error('[cashfree verify]', err.message)
    return res.json({ paid: false, error: err.message })
  }
})

const PORT = process.env.PORT || 3000
app.listen(PORT, () => console.log(`[intrvw-backend] listening on ${PORT}`))
