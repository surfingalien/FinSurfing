'use strict'

const nodemailer = require('nodemailer')

let _mailer = null
function getMailer() {
  if (_mailer) return _mailer
  const hasSmtp = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
  if (!process.env.RESEND_API_KEY && hasSmtp) {
    _mailer = nodemailer.createTransport({
      host:   process.env.SMTP_HOST,
      port:   parseInt(process.env.SMTP_PORT || '587'),
      secure: process.env.SMTP_SECURE === 'true',
      auth:   { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  }
  return _mailer
}

async function sendEmail({ to, subject, html }) {
  if (process.env.RESEND_API_KEY) {
    const from = process.env.RESEND_FROM || 'FinSurf <noreply@finsurf.app>'
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ from, to, subject, html }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.message || `Resend error ${res.status}`)
    }
    return true
  }
  const mailer = getMailer()
  if (mailer) {
    const from = process.env.SMTP_FROM || `FinSurf <${process.env.SMTP_USER}>`
    await mailer.sendMail({ from, to, subject, html })
    return true
  }
  console.log(`[EMAIL] To: ${to} | Subject: ${subject}`)
  return false
}

module.exports = { sendEmail }
