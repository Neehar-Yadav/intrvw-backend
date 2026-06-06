# Intrvw Backend

This server holds all the secret keys (Groq, Cashfree) so they never ship inside
the desktop app. The app calls this backend for transcription, answers, and payments.

## Run locally

```bash
cd backend
npm install
npm start
```

It listens on `http://localhost:3000`. The desktop app's `.env` should have
`BACKEND_URL=http://localhost:3000` for local testing.

## Environment variables (.env)

| Variable | What it is |
|----------|------------|
| `GROQ_API_KEY` | Your Groq API key |
| `CASHFREE_APP_ID` | Cashfree App ID |
| `CASHFREE_SECRET_KEY` | Cashfree Secret Key |
| `CASHFREE_ENV` | `sandbox` for testing, `production` when live |
| `APP_SECRET` | A random string. Put the SAME value in the app's `.env`. Blocks others from using your backend. |
| `PORT` | Auto-set by hosting platforms |

## Deploy free on Render

1. Push this `backend` folder to a GitHub repo.
2. Go to [render.com](https://render.com) → New → Web Service.
3. Connect the repo, pick the `backend` folder as root.
4. Build command: `npm install` · Start command: `npm start`
5. Add all the environment variables above in the Render dashboard
   (do NOT commit your real `.env` — it's gitignored).
6. Deploy. Render gives you a URL like `https://intrvw-backend.onrender.com`.
7. Put that URL in the desktop app's `.env` as `BACKEND_URL`, rebuild the app.

> Note: Render's free tier sleeps after 15 min of inactivity, so the first request
> after idle takes ~30s to wake. For production, use a paid tier or Railway/Fly.io.
