'use strict';

const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');
const env = require('../config/env');
const logger = require('./logger');
const { maskEmail } = require('./mask');

/**
 * Outbound email.
 *
 * When SMTP is configured, mail is sent for real. When it is not, messages are
 * written to `mail-outbox/` as .html files and the actionable link is logged, so
 * signup and password-reset flows can still be completed locally.
 *
 * What this deliberately does not do is pretend. `send()` reports which path it
 * took, and the API passes that up so the UI can say "check your inbox" or
 * "email is not configured on this server" truthfully.
 */

/** True when a real SMTP transport is configured. */
const isConfigured = Boolean(env.mail.host);

/**
 * What the transport is actually doing - which is not the same question as
 * whether it is configured.
 *
 * `isConfigured` only asks whether SMTP_HOST is set. On 17 Sep a health probe
 * reported mail as fine for fifteen minutes while Gmail rejected every login,
 * because the password had been replaced with an account password instead of an
 * app password. The server knew - MAIL_TRANSPORT_UNAVAILABLE was in the journal
 * - but nothing surfaced it.
 *
 *   not-configured  no SMTP_HOST; mail goes to the outbox by design
 *   unverified      configured, but nothing has been proven yet
 *   ready           a login or a send has succeeded
 *   unavailable     a login or a send has failed
 *
 * Updated by the boot check and by every send, so a credential revoked while
 * the process runs turns the status over on the first failure rather than
 * waiting for a restart. Nothing re-verifies on a timer: a liveness probe must
 * not open an SMTP session, and polling Gmail to answer it would be worse than
 * the problem.
 */
let transportStatus = isConfigured ? 'unverified' : 'not-configured';

/** The transport's last known state. See `transportStatus`. */
const status = () => transportStatus;

const OUTBOX_DIR = path.resolve(__dirname, '../../mail-outbox');

let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.mail.host,
      port: env.mail.port,
      secure: env.mail.secure,
      auth: env.mail.user ? { user: env.mail.user, pass: env.mail.password } : undefined,
    });
  }
  return transporter;
}

/** Pulls the first http(s) link out of a message, for logging. */
function firstLink(text = '') {
  const match = /https?:\/\/\S+/.exec(text);
  return match ? match[0] : null;
}

function writeToOutbox(message) {
  try {
    fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeTo = String(message.to).replace(/[^a-z0-9@._-]/gi, '_');
    const file = path.join(OUTBOX_DIR, `${stamp}__${safeTo}.html`);
    fs.writeFileSync(
      file,
      `<!-- To: ${message.to}\n     Subject: ${message.subject} -->\n${message.html || `<pre>${message.text}</pre>`}`,
    );
    return file;
  } catch (error) {
    logger.error(
      { event: 'MAIL_OUTBOX_WRITE_FAILED', category: 'STORAGE', err_message: error.message },
      'Could not write to the mail outbox',
    );
    return null;
  }
}

/**
 * Sends an email.
 * @returns {Promise<{delivered: boolean, transport: 'smtp'|'outbox', error?: string}>}
 */
async function send({ to, subject, text, html }) {
  if (!isConfigured) {
    const file = writeToOutbox({ to, subject, text, html });
    const link = firstLink(text);

    // §37: subject and outbox path, recipient masked. `link` carries a
    // single-use verification or reset token, so it is kept for the developer
    // running without SMTP and never written to a shipped log line.
    logger.warn(
      {
        event: 'MAIL_NOT_SENT',
        dependency: 'EMAIL',
        category: 'NOTIFICATION',
        reason: 'SMTP_NOT_CONFIGURED',
        subject,
        recipient: maskEmail(to),
        outbox_file: file ?? null,
        ...(env.isProduction || !link ? {} : { dev_link: link }),
      },
      `SMTP is not configured - "${subject}" was saved to the outbox instead of being sent`,
    );
    return { delivered: false, transport: 'outbox' };
  }

  try {
    await getTransporter().sendMail({
      from: env.mail.from,
      to,
      subject,
      text,
      html,
      attachments: logoAttachment(),
    });
    transportStatus = 'ready';
    return { delivered: true, transport: 'smtp' };
  } catch (error) {
    // §37: the subject is logged, the recipient is masked, the body never is.
    logger.error(
      {
        event: 'MAIL_SEND_FAILED',
        error_code: 'NOTIFICATION_SEND_FAILED',
        category: 'NOTIFICATION',
        dependency: 'EMAIL',
        subject,
        recipient: maskEmail(to),
        err_message: error.message,
      },
      'Could not send email',
    );
    transportStatus = 'unavailable';
    return { delivered: false, transport: 'smtp', error: error.message };
  }
}

/**
 * Checks the SMTP connection once at boot so a bad password surfaces on
 * startup rather than the first time a customer resets their password.
 */
async function verifyTransport() {
  if (!isConfigured) {
    logger.warn(
      { event: 'MAIL_TRANSPORT_NOT_CONFIGURED', dependency: 'EMAIL', outbox_dir: OUTBOX_DIR },
      'SMTP_HOST is empty - verification and password-reset emails will be written to the outbox. See .env.example.',
    );
    transportStatus = 'not-configured';
    return false;
  }

  try {
    await getTransporter().verify();
    logger.info(
      { event: 'MAIL_TRANSPORT_READY', dependency: 'EMAIL', smtp_host: env.mail.host, smtp_port: env.mail.port },
      `SMTP ready at ${env.mail.host}:${env.mail.port}`,
    );
    transportStatus = 'ready';
    return true;
  } catch (error) {
    // §7 FATAL is for the process being unable to run; mail is degraded, not
    // dead - password resets fail, everything else keeps working. ERROR.
    logger.error(
      {
        event: 'MAIL_TRANSPORT_UNAVAILABLE',
        error_code: 'NOTIFICATION_SEND_FAILED',
        category: 'NOTIFICATION',
        dependency: 'EMAIL',
        // Host and port only. §37: never the SMTP password.
        smtp_host: env.mail.host,
        smtp_port: env.mail.port,
        err_message: error.message,
      },
      `SMTP at ${env.mail.host}:${env.mail.port} is not working; emails will fail until it is fixed`,
    );
    transportStatus = 'unavailable';
    return false;
  }
}

// ---------------------------------------------------------------------------
// Templates
//
// Email HTML is not web HTML: Gmail and Outlook strip <style> blocks, ignore
// flexbox and grid, and Outlook renders through Word. So everything below is
// table-based with inline styles, which is the only combination that survives
// every major client.
//
// The logo travels as a CID attachment rather than a hosted <img src>. A URL
// would need the API to be publicly reachable, and most clients block remote
// images by default - the mark would be a broken box on first open.

const BRAND = {
  name: 'OffersOffer',
  ink: '#1B1B1E',
  gold: '#F5A623',
  goldDark: '#D97706',
  cream: '#FDF6E3',
  paper: '#FFFFFF',
  body: '#3F3F46',
  muted: '#71717A',
  line: '#EFE6CC',
};

const LOGO_CID = 'offersoffer-logo';
const LOGO_PATH = path.resolve(__dirname, '../../assets/logo-email.png');

/** Attached to every message so <img src="cid:..."> resolves. */
const logoAttachment = () =>
  fs.existsSync(LOGO_PATH)
    ? [{ filename: 'offersoffer.png', path: LOGO_PATH, cid: LOGO_CID }]
    : [];

/** Escapes text interpolated into the HTML - names and titles are user data. */
const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The masthead: the mark, then the wordmark as live text.
 *
 * The wordmark is text rather than part of the image so it stays sharp at any
 * zoom and still reads when images are blocked - the brand name survives even
 * when the mark does not.
 */
const masthead = () => `
  <tr>
    <td align="center" style="padding:36px 24px 8px">
      <img src="cid:${LOGO_CID}" width="132" height="87" alt="${BRAND.name}"
           style="display:block;border:0;outline:none;text-decoration:none;width:132px;height:auto"/>
    </td>
  </tr>
  <tr>
    <td align="center" style="padding:0 24px 28px">
      <span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.4px;color:${BRAND.ink}">Offers</span><span style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;letter-spacing:-0.4px;color:${BRAND.gold}">Offer</span>
    </td>
  </tr>`;

/**
 * @param {string} title    headline inside the card
 * @param {string} body     inner HTML
 * @param {string} [preview] the snippet inboxes show beside the subject
 */
const layout = (title, body, preview = '') => `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.cream};-webkit-text-size-adjust:100%">
<!-- Inbox preview text, hidden in the message body itself. -->
<div style="display:none;font-size:1px;color:${BRAND.cream};line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden">${esc(preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${BRAND.cream}">
  <tr>
    <td align="center" style="padding:0 12px 40px">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
        ${masthead()}
        <tr>
          <td style="background:${BRAND.paper};border:1px solid ${BRAND.line};border-radius:14px;padding:0">
            <!-- Gold rule across the top of the card. -->
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr><td style="height:4px;background:${BRAND.gold};border-radius:14px 14px 0 0;font-size:0;line-height:0">&nbsp;</td></tr>
              <tr>
                <td style="padding:32px 36px 36px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:${BRAND.body}">
                  <h1 style="margin:0 0 18px;font-size:21px;line-height:1.3;font-weight:700;color:${BRAND.ink}">${esc(title)}</h1>
                  ${body}
                </td>
              </tr>
            </table>
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:24px 24px 0;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:12px;line-height:1.7;color:${BRAND.muted}">
            You are receiving this because you have an ${BRAND.name} account.<br/>
            This is an automated message &mdash; please do not reply.
            <div style="margin-top:10px;color:#A1A1AA">&copy; ${new Date().getFullYear()} ${BRAND.name}</div>
          </td>
        </tr>
      </table>
    </td>
  </tr>
</table>
</body>
</html>`;

/**
 * A bulletproof button: Outlook ignores padding on <a>, so the shape comes from
 * a table cell and the anchor only carries the colour and the click target.
 */
const button = (url, label) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:26px 0">
    <tr>
      <td align="center" bgcolor="${BRAND.gold}" style="border-radius:10px">
        <a href="${url}" target="_blank"
           style="display:inline-block;padding:14px 30px;font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;font-weight:700;color:#3B2600;text-decoration:none;border-radius:10px">${esc(label)}</a>
      </td>
    </tr>
  </table>`;

/** The same destination as plain text, for when the button cannot be clicked. */
const fallbackLink = (url) => `
  <p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.muted}">
    If the button does not work, copy this link into your browser:<br/>
    <a href="${url}" style="color:${BRAND.goldDark};word-break:break-all">${url}</a>
  </p>`;

/** Highlighted panel for the thing the email is actually about. */
const highlight = (heading, sub) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:20px 0">
    <tr>
      <td style="background:${BRAND.cream};border-left:4px solid ${BRAND.gold};border-radius:0 10px 10px 0;padding:16px 20px">
        <div style="font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:17px;font-weight:700;color:${BRAND.ink}">${esc(heading)}</div>
        ${sub ? `<div style="margin-top:4px;font-size:13px;color:${BRAND.muted}">${esc(sub)}</div>` : ''}
      </td>
    </tr>
  </table>`;

const note = (text) =>
  `<p style="margin:0 0 18px;font-size:13px;color:${BRAND.muted}">${esc(text)}</p>`;

const templates = {
  verifyEmail: (name, url) => ({
    subject: `Confirm your email &middot; ${BRAND.name}`.replace('&middot;', '·'),
    text: `Hi ${name},\n\nWelcome to ${BRAND.name}. Confirm your email address to activate your account:\n${url}\n\nThe link expires in 24 hours.`,
    html: layout(
      'Confirm your email address',
      `<p style="margin:0 0 14px">Hi ${esc(name)},</p>
       <p style="margin:0 0 4px">Welcome to ${BRAND.name}. Confirm your email address and your account is ready to use.</p>
       ${button(url, 'Verify my email')}
       ${note('This link expires in 24 hours. If you did not create an account, you can ignore this email.')}
       ${fallbackLink(url)}`,
      `Confirm your email to activate your ${BRAND.name} account.`,
    ),
  }),

  resetPassword: (name, url) => ({
    subject: `Reset your password · ${BRAND.name}`,
    text: `Hi ${name},\n\nReset your ${BRAND.name} password:\n${url}\n\nThe link expires in 1 hour. Ignore this email if you did not request it.`,
    html: layout(
      'Reset your password',
      `<p style="margin:0 0 14px">Hi ${esc(name)},</p>
       <p style="margin:0 0 4px">We received a request to reset the password on your ${BRAND.name} account.</p>
       ${button(url, 'Choose a new password')}
       ${note('This link expires in 1 hour. If you did not request a reset, no action is needed — your password stays as it is.')}
       ${fallbackLink(url)}`,
      'Reset your password. The link expires in 1 hour.',
    ),
  }),

  newOffer: (name, offer, reason, url) => ({
    subject: `${offer.shop_name}: ${offer.title}`,
    text: `Hi ${name},\n\n${reason}\n\n${offer.title}\n${offer.offer_text || ''}\n\nView it here: ${url}`,
    html: layout(
      'A new offer for you',
      `<p style="margin:0 0 14px">Hi ${esc(name)},</p>
       <p style="margin:0">${esc(reason)}</p>
       ${highlight(offer.offer_text || offer.title, offer.shop_name)}
       ${button(url, 'View this offer')}
       ${fallbackLink(url)}`,
      `${offer.shop_name}: ${offer.title}`,
    ),
  }),

  offerExpiring: (name, offer, url) => ({
    subject: `Ending soon: ${offer.title}`,
    text: `Hi ${name},\n\nA saved offer is about to expire: ${offer.title}\n\n${url}`,
    html: layout(
      'A saved offer is ending soon',
      `<p style="margin:0 0 14px">Hi ${esc(name)},</p>
       <p style="margin:0">One of your saved offers expires shortly — here it is before it goes.</p>
       ${highlight(offer.title, offer.shop_name)}
       ${button(url, 'View this offer')}
       ${fallbackLink(url)}`,
      `${offer.title} at ${offer.shop_name} expires soon.`,
    ),
  }),

  serviceOfferExpiring: (name, offer, url) => ({
    subject: `Ending soon: ${offer.title}`,
    text: `Hi ${name},\n\nA saved service deal is about to expire: ${offer.title}\n\n${url}`,
    html: layout(
      'A saved service deal is ending soon',
      `<p style="margin:0 0 14px">Hi ${esc(name)},</p>
       <p style="margin:0">One of your saved service deals expires shortly.</p>
       ${highlight(offer.title, offer.shop_name)}
       ${button(url, 'View this service')}
       ${fallbackLink(url)}`,
      `${offer.title} at ${offer.shop_name} expires soon.`,
    ),
  }),
};

module.exports = { send, templates, verifyTransport, isConfigured, status, OUTBOX_DIR, BRAND };
