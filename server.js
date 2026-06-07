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
app.get('/', (_, res) => res.json({ ok: true, service: 'intrvw-backend', version: 'screen-vision-v2' }))

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

// Deepgram diarization — splits system audio into separate speakers (interviewers)
async function deepgramDiarize(audioBase64) {
  const key = process.env.DEEPGRAM_API_KEY
  if (!key) throw new Error('Deepgram not configured')
  const audio = Buffer.from(audioBase64, 'base64')
  const url = 'https://api.deepgram.com/v1/listen?model=nova-2&diarize=true&punctuate=true&utterances=true&language=en'
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Token ${key}`, 'Content-Type': 'audio/webm' },
    body: audio
  })
  if (!res.ok) throw new Error('Deepgram error ' + res.status)
  const data = await res.json()
  const utterances = data.results?.utterances || []
  // Each utterance: { speaker: 0|1|2, transcript, start }
  return utterances
    .filter(u => u.transcript && u.transcript.trim())
    .map(u => ({ speaker: u.speaker, text: u.transcript.trim(), start: u.start }))
}

// Groq Whisper with timestamps — used for the candidate's mic
async function transcribeMic(audioBase64) {
  const tmpPath = path.join(os.tmpdir(), `intrvw-mic-${Date.now()}.webm`)
  fs.writeFileSync(tmpPath, Buffer.from(audioBase64, 'base64'))
  try {
    const result = await getGroq().audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: 'whisper-large-v3',
      language: 'en',
      response_format: 'verbose_json'
    })
    const segments = result.segments || []
    return segments
      .filter(s => s.text && s.text.trim())
      .map(s => ({ text: s.text.trim(), start: s.start }))
  } finally {
    try { fs.unlinkSync(tmpPath) } catch {}
  }
}

// ── Audio: diarize + transcribe + answer ─────────────────────────────────────────
app.post('/api/audio', checkAuth, async (req, res) => {
  // micAudio = candidate (You); systemAudio = interviewer(s). `audio` kept for compat.
  const { micAudio, systemAudio, audio, role, resume } = req.body
  const sysSource = systemAudio || audio
  if (!sysSource && !micAudio) return res.json({ skip: true })

  try {
    // Run diarization (interviewers) and mic transcription (you) in parallel
    let [sysUtterances, micSegments] = await Promise.all([
      sysSource ? deepgramDiarize(sysSource).catch(e => { console.error('[deepgram]', e.message); return [] }) : Promise.resolve([]),
      micAudio  ? transcribeMic(micAudio).catch(e => { console.error('[mic]', e.message); return [] })       : Promise.resolve([])
    ])

    // Fallback: if diarization gave nothing (no Deepgram key, silence, or 1 speaker),
    // transcribe the system audio with Whisper so the interviewer's question isn't lost.
    let sysFellBack = false
    if (sysSource && sysUtterances.length === 0) {
      const segs = await transcribeMic(sysSource).catch(e => { console.error('[sys-fallback]', e.message); return [] })
      sysUtterances = segs.map(s => ({ speaker: 0, text: s.text, start: s.start }))
      sysFellBack = true
    }

    // Map Deepgram speaker numbers → "Interviewer N" (stable per request)
    const speakerMap = {}
    let nextInterviewer = 1
    function interviewerLabel(spk) {
      if (!(spk in speakerMap)) speakerMap[spk] = `Interviewer ${nextInterviewer++}`
      return speakerMap[spk]
    }

    // Build a unified, time-ordered, labeled transcript
    const lines = []
    for (const u of sysUtterances) lines.push({ start: u.start, label: sysFellBack ? 'Interviewer' : interviewerLabel(u.speaker), text: u.text })
    for (const s of micSegments)   lines.push({ start: s.start, label: 'You', text: s.text })
    lines.sort((a, b) => a.start - b.start)

    console.log('[audio] sys utterances:', sysUtterances.length, 'mic segs:', micSegments.length, 'fallback:', sysFellBack)

    // Merge consecutive lines from the same speaker for readability
    const merged = []
    for (const ln of lines) {
      const last = merged[merged.length - 1]
      if (last && last.label === ln.label) last.text += ' ' + ln.text
      else merged.push({ label: ln.label, text: ln.text })
    }

    const transcript = merged.map(m => `${m.label}: ${m.text}`).join('\n')
    if (!transcript || transcript.replace(/(You|Interviewer \d+):/g, '').trim().length < 6) {
      return res.json({ skip: true })
    }

    // Answer the interviewer's question(s) using the labeled transcript
    let systemMsg = `You are helping an Indian candidate in a live job interview. Below is a snippet of the conversation with speaker labels — "You" is the candidate, "Interviewer" / "Interviewer 1/2/3" are the people interviewing.

Find the most recent question or topic the candidate needs to respond to and write the answer the candidate should say. The question is usually from an Interviewer, but if labels are unclear, just answer the most recent question in the snippet.

Respond EXACTLY like this:
QUESTION: <the question being answered>
ANSWER: <the answer — see length rules below>

LENGTH RULES:
- For intro/self-introduction questions ("tell me about yourself", "introduce yourself", "walk me through your background"): write a FULL 2-minute spoken introduction — roughly 280-320 words covering who you are, education (college, degree, year), key skills, 2-3 specific projects from the resume, and what you're looking for. Natural and warm, like a real Indian candidate talking.
- For all other questions: 3-5 sentences.

Use the EXACT details from the resume — real college, project names, skills. Never be vague.
NEVER write stage directions, emotions, or parenthetical actions like "(laughs)", "(smiling)", or "(pauses)". Output only the words the candidate should actually say.
Only respond with the single word SKIP if the snippet has no question or topic at all — just pure noise or silence.`
    if (role) systemMsg += `\nRole being interviewed for: ${role}`
    if (resume) systemMsg += `\nCandidate's resume (use these exact details):\n${resume}`

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
    const question = qMatch?.[1]?.trim() || 'Interview question'
    const answer = aMatch?.[1]?.trim() || reply

    // Return the labeled transcript too so the UI can show who said what
    return res.json({ question, answer, transcript })
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
    // SINGLE vision call — the model sees the questions AND their options, so it can
    // pick the correct choice. No second blind step, no role-play.
    let prompt = `You are an expert exam and test solver. The image is a screenshot of a candidate's screen showing one or more questions — multiple-choice, multi-select, coding problems, aptitude, or written questions.

Solve EVERY question visible on the screen. For each one:
- Start with "Q<n>:" and a short restatement of the question.
- If it is multiple choice or multi-select, pick the correct option(s) EXACTLY as written on screen (copy the option text). If several are correct, list all of them. State the answer first, then one short line of reasoning.
- If it is a coding problem, give clean, correct, working code in a code block.
- Otherwise give a direct, correct, concise answer.

STRICT RULES:
- Be accurate. Only choose from the options actually shown on screen.
- Do NOT role-play. Do NOT add stage directions, emotions, or filler like "(laughs)", "(smiling)", "I'm happy to oblige".
- Do NOT give interview-style self-introductions or talk about a resume.
- Just solve the questions clearly and correctly.
If there are genuinely no questions on the screen, reply with exactly: NO_QUESTIONS`

    const response = await getGroq().chat.completions.create({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${screenshot}` } },
          { type: 'text', text: prompt }
        ]
      }],
      max_tokens: 1400,
      temperature: 0.2
    })

    const answer = response.choices[0]?.message?.content?.trim() || ''
    if (!answer || answer === 'NO_QUESTIONS') return res.json({ noQuestions: true })

    // Use the full solved text as follow-up context too
    return res.json({ answer, extractedQuestions: answer })
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
  const mode = owner ? 'sandbox' : 'production'
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
      order_meta: { return_url: `https://${req.get('host')}/pay-done?order_id=${orderId}` }
    })
    if (!data.payment_session_id) {
      console.error('[cashfree create]', JSON.stringify(data))
      return res.json({ error: 'Could not create order.' })
    }
    // Point the app at our own checkout page, which loads the Cashfree SDK correctly
    const base = `https://${req.get('host')}`
    const paymentUrl = `${base}/pay?session=${encodeURIComponent(data.payment_session_id)}&mode=${mode}`
    return res.json({ orderId, paymentUrl })
  } catch (err) {
    console.error('[cashfree create]', err.message)
    return res.json({ error: err.message })
  }
})

// Hosted checkout page — loads the Cashfree JS SDK and starts checkout properly.
app.get('/pay', (req, res) => {
  const session = req.query.session || ''
  const mode = req.query.mode === 'production' ? 'production' : 'sandbox'
  res.setHeader('Content-Type', 'text/html')
  res.end(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Redirecting to payment…</title>
<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
<style>body{font-family:sans-serif;background:#16140f;color:#f0a500;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}</style>
</head><body>
<h2>Opening secure payment…</h2>
<script>
  (function(){
    try {
      var cashfree = Cashfree({ mode: "${mode}" });
      cashfree.checkout({ paymentSessionId: ${JSON.stringify(session)}, redirectTarget: "_self" });
    } catch (e) {
      document.body.innerHTML = '<h2>Could not open payment. Please return to the app and try again.</h2>';
    }
  })();
</script>
</body></html>`)
})

// Simple post-payment landing page
app.get('/pay-done', (_, res) => {
  res.setHeader('Content-Type', 'text/html')
  res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Payment complete</title>
<style>body{font-family:sans-serif;background:#16140f;color:#f0a500;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center}</style>
</head><body><div><h2>Payment received!</h2><p style="color:#bbb">Return to Intrvw and click "I have paid — verify now".</p></div></body></html>`)
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
