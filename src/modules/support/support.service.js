'use strict';

const { queryOne, execute, rawQuery } = require('../../db/pool');
const ApiError = require('../../utils/ApiError');
const env = require('../../config/env');
const logger = require('../../utils/logger');
const mailer = require('../../utils/mailer');
const { limitOffset } = require('../../utils/pagination');
const accessControl = require('../../services/accessControl');

/**
 * The support desk.
 *
 * Two rules shape everything below.
 *
 * A ticket is private. It carries the reporter's name, email, phone and an
 * account id, plus whatever they pasted into the description while trying to
 * explain a problem - which in practice is sometimes a screenshot of their own
 * order. So every read is either the person who filed it or somebody holding
 * VIEW_SUPPORT_TICKETS, and there is no third path: no lookup by reference, no
 * "check your ticket" page that takes an id and an email.
 *
 * And a ticket must survive its author. `user_id` is nullable and set to NULL
 * when an account goes, but the contact details stay on the row, so a report
 * filed against a shop is still answerable and still counts after the reporter
 * deletes their account.
 */

/**
 * "SUP-10248".
 *
 * Derived from the auto-increment id rather than generated randomly: a
 * reference has to be unique, and a random one has to be checked for
 * collisions inside the same transaction that inserts the row. The offset
 * exists only so the first ticket does not read as "SUP-1", which invites
 * people to try SUP-2 - it is not a secret, and nothing is authorized by
 * holding one.
 */
const REFERENCE_OFFSET = 10000;
const referenceFor = (id) => `SUP-${REFERENCE_OFFSET + Number(id)}`;

const mapMessage = (row) => ({
  id: Number(row.id),
  authorRole: row.author_role,
  authorName: row.author_name ?? (row.author_role === 'support' ? 'Support' : null),
  body: row.body,
  isInternal: Boolean(row.is_internal),
  createdAt: row.created_at,
});

const mapTicket = (row) => ({
  id: Number(row.id),
  reference: row.reference,
  userId: row.user_id === null ? null : Number(row.user_id),
  name: row.name,
  email: row.email,
  phone: row.phone,
  userType: row.user_type,
  category: row.category,
  subject: row.subject,
  description: row.description,
  attachmentUrl: row.attachment_url,
  entityType: row.entity_type,
  entityId: row.entity_id === null ? null : Number(row.entity_id),
  status: row.status,
  priority: row.priority,
  assignedTo: row.assigned_to === null ? null : Number(row.assigned_to),
  assigneeName: row.assignee_name ?? null,
  resolvedAt: row.resolved_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const SELECT = `
  SELECT t.*, a.name AS assignee_name
    FROM support_tickets t
    LEFT JOIN users a ON a.id = t.assigned_to`;

/**
 * Files a ticket.
 *
 * `user` is whoever is signed in, or undefined - the endpoint is deliberately
 * open, because someone who cannot log in is exactly the person who needs to
 * reach support and cannot prove who they are while doing it.
 *
 * The contact details come from the body even for a signed-in user. The form
 * pre-fills them from the account (§"don't make users enter information you
 * already know") but lets them be edited, and a reply belongs at the address
 * they chose to give. What is *not* taken from the body is `user_id`: that is
 * read from the token, so a guest cannot file a ticket as somebody else and
 * then be shown their thread.
 */
async function create(payload, user) {
  const result = await execute(
    `INSERT INTO support_tickets
       (user_id, name, email, phone, user_type, category, subject, description,
        attachment_url, entity_type, entity_id, priority)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user?.id ?? null,
      payload.name,
      payload.email,
      payload.phone || null,
      payload.userType,
      payload.category,
      payload.subject,
      payload.description,
      payload.attachmentUrl || null,
      payload.entityType || null,
      payload.entityId || null,
      // A report of misleading or fraudulent content is the one category where
      // waiting a day has a cost to somebody other than the reporter.
      payload.category === 'report_content' ? 'high' : 'normal',
    ],
  );

  const id = Number(result.insertId);
  await execute('UPDATE support_tickets SET reference = ? WHERE id = ?', [referenceFor(id), id]);

  // The description is the customer's first message, so it goes in the thread
  // as well as on the ticket. Storing it twice is deliberate: the ticket keeps
  // the original complaint verbatim even after a long conversation, and the
  // thread reads in order without a special case for its first entry.
  await execute(
    'INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body) VALUES (?, ?, ?, ?)',
    [id, user?.id ?? null, 'customer', payload.description],
  );

  const ticket = await getRow(id);
  // Fire-and-forget: the ticket exists and the customer has their reference
  // whether or not the desk's inbox is reachable, and failing the request
  // would tell them their request was not received when it was.
  announceToDesk(ticket).catch((error) =>
    logger.error(
      {
        event: 'SUPPORT_NOTIFY_FAILED',
        error_code: 'NOTIFICATION_SEND_FAILED',
        category: 'NOTIFICATION',
        dependency: 'EMAIL',
        ticket_reference: ticket.reference,
        err_message: error.message,
      },
      'Could not announce a new support ticket',
    ),
  );

  return ticket;
}

/** Tells the support desk a ticket has arrived, if there is an inbox to tell. */
async function announceToDesk(ticket) {
  // Returning quietly here is how a ticket could be filed, acknowledged with a
  // reference, and never reach anybody - the customer is told "received", which
  // is true, while the desk hears nothing. Say so in the log at least.
  if (!env.support.inbox) {
    logger.warn(
      {
        event: 'SUPPORT_INBOX_NOT_CONFIGURED',
        dependency: 'EMAIL',
        category: 'NOTIFICATION',
        ticket_reference: ticket.reference,
      },
      'No SUPPORT_INBOX or SUPPORT_EMAIL is set - the ticket was saved but nobody was told',
    );
    return;
  }
  const lines = [
    `${ticket.reference} - ${ticket.subject}`,
    '',
    `Category: ${ticket.category}`,
    `From: ${ticket.name} <${ticket.email}>${ticket.phone ? ` / ${ticket.phone}` : ''}`,
    `User type: ${ticket.userType}${ticket.userId ? ` (account #${ticket.userId})` : ' (not signed in)'}`,
    ...(ticket.entityType ? [`Reported: ${ticket.entityType} #${ticket.entityId}`] : []),
    ...(ticket.attachmentUrl ? [`Attachment: ${env.appUrl}${ticket.attachmentUrl}`] : []),
    '',
    ticket.description,
  ];
  await mailer.send({
    to: env.support.inbox,
    subject: `[${ticket.reference}] ${ticket.subject}`,
    text: lines.join('\n'),
  });
}

async function getRow(id) {
  const rows = await rawQuery(`${SELECT} WHERE t.id = ?`, [id]);
  if (!rows.length) throw ApiError.notFound('Support request not found');
  return mapTicket(rows[0]);
}

/** True when this user may read - and reply on - this ticket as its owner. */
const owns = (ticket, user) => Boolean(user && ticket.userId && ticket.userId === user.id);

const canRead = (ticket, user) =>
  owns(ticket, user) || accessControl.hasAnyPermission(user, 'VIEW_SUPPORT_TICKETS');

/**
 * One ticket and its thread.
 *
 * Internal notes are stripped for the owner rather than merely hidden in the
 * UI - the API is the boundary, and a triage note saying "third complaint about
 * this shop, escalating" is not the customer's to read.
 */
async function getForUser(id, user) {
  const ticket = await getRow(id);
  // Not found rather than forbidden: ids are sequential, and "you may not read
  // this one" confirms it exists and that somebody filed it.
  if (!canRead(ticket, user)) throw ApiError.notFound('Support request not found');

  const isStaff = !owns(ticket, user);
  const rows = await rawQuery(
    `SELECT m.*, u.name AS author_name
       FROM support_ticket_messages m
       LEFT JOIN users u ON u.id = m.author_id
      WHERE m.ticket_id = ?${isStaff ? '' : ' AND m.is_internal = 0'}
      ORDER BY m.created_at ASC, m.id ASC`,
    [id],
  );

  return { ...ticket, messages: rows.map(mapMessage) };
}

/** The customer's own requests. Guest tickets have no owner and never appear. */
async function listMine(params, user) {
  const { limit, page, offset } = limitOffset(params);
  const [rows, countRows] = await Promise.all([
    rawQuery(
      `${SELECT} WHERE t.user_id = ? ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      [user.id],
    ),
    rawQuery('SELECT COUNT(*) AS total FROM support_tickets WHERE user_id = ?', [user.id]),
  ]);
  return {
    items: rows.map(mapTicket),
    pagination: { page, limit, total: Number(countRows[0].total) },
  };
}

/** The support queue. */
async function listAll(params) {
  const { limit, page, offset } = limitOffset(params);
  const where = [];
  const values = [];

  // The queue's default view is work outstanding, not everything ever filed;
  // `status=all` is how you ask for the archive.
  if (!params.status) {
    where.push("t.status IN ('open', 'in_progress', 'waiting_on_customer')");
  } else if (params.status !== 'all') {
    where.push('t.status = ?');
    values.push(params.status);
  }

  if (params.category) {
    where.push('t.category = ?');
    values.push(params.category);
  }

  if (params.search) {
    where.push('(t.reference = ? OR t.subject LIKE ? OR t.name LIKE ? OR t.email LIKE ?)');
    const like = `%${params.search}%`;
    values.push(params.search, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, countRows] = await Promise.all([
    rawQuery(
      // High-priority first, then oldest, so a content report does not sit
      // behind a week of "how do I save an offer".
      `${SELECT} ${whereSql}
        ORDER BY FIELD(t.priority, 'high', 'normal', 'low'), t.created_at ASC
        LIMIT ${limit} OFFSET ${offset}`,
      values,
    ),
    rawQuery(`SELECT COUNT(*) AS total FROM support_tickets t ${whereSql}`, values),
  ]);

  return {
    items: rows.map(mapTicket),
    pagination: { page, limit, total: Number(countRows[0].total) },
  };
}

/**
 * How many tickets are waiting on *us*, for the queue's nav badge.
 *
 * Narrower than the queue's default list, which also shows the ones parked on
 * `waiting_on_customer`. Those are still open work, but nobody here can move
 * them, and a badge that counts them never reaches zero - which is how a badge
 * stops being read at all.
 */
async function openCount() {
  const row = await queryOne(
    "SELECT COUNT(*) AS total FROM support_tickets WHERE status IN ('open', 'in_progress')",
  );
  return { open: Number(row.total) };
}

/**
 * Adds a message to the thread.
 *
 * Either side may write. Which side it came from is decided here from what the
 * caller is, never from the request body - otherwise a customer could post a
 * reply attributed to Support on their own ticket and screenshot it.
 */
async function addMessage(id, payload, user) {
  const ticket = await getRow(id);
  const isOwner = owns(ticket, user);
  const isStaff = accessControl.hasAnyPermission(user, 'MANAGE_SUPPORT_TICKETS');
  if (!isOwner && !isStaff) throw ApiError.notFound('Support request not found');

  // A closed ticket is finished. Re-opening it is a status change somebody
  // makes deliberately, not a side effect of typing into an old thread.
  if (ticket.status === 'closed') {
    throw ApiError.badRequest('This request is closed. Please raise a new one.');
  }

  const isInternal = isStaff && !isOwner && payload.isInternal;
  await execute(
    'INSERT INTO support_ticket_messages (ticket_id, author_id, author_role, body, is_internal) VALUES (?, ?, ?, ?, ?)',
    [id, user.id, isOwner ? 'customer' : 'support', payload.body, isInternal ? 1 : 0],
  );

  // A reply moves the ticket along on its own. Support answering puts the ball
  // in the customer's court; the customer answering takes it back - otherwise
  // every thread needs a second, manual click to stay in the right queue, and
  // the one that gets forgotten is the customer's.
  const nextStatus = isOwner
    ? ticket.status === 'waiting_on_customer' || ticket.status === 'resolved'
      ? 'in_progress'
      : ticket.status
    : isInternal
      ? ticket.status
      : 'waiting_on_customer';

  if (nextStatus !== ticket.status) {
    await execute('UPDATE support_tickets SET status = ? WHERE id = ?', [nextStatus, id]);
  } else {
    // Touch it anyway so the queue's ordering reflects the last activity.
    await execute('UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
  }

  if (!isInternal && !isOwner) {
    // Email, not an in-app notification. A guest has no account to notify, and
    // the address on the ticket is the channel the customer chose - so the same
    // path serves both rather than only the half who happened to be signed in.
    emailReply(ticket, payload.body).catch((error) =>
      logger.error(
        {
          event: 'SUPPORT_REPLY_EMAIL_FAILED',
          error_code: 'NOTIFICATION_SEND_FAILED',
          category: 'NOTIFICATION',
          dependency: 'EMAIL',
          ticket_reference: ticket.reference,
          err_message: error.message,
        },
        'Could not email a support reply',
      ),
    );
  }

  return getForUser(id, user);
}

async function emailReply(ticket, body) {
  await mailer.send({
    to: ticket.email,
    subject: `Re: [${ticket.reference}] ${ticket.subject}`,
    text: [
      `Hello ${ticket.name},`,
      '',
      body,
      '',
      '---',
      `Reference: ${ticket.reference}`,
      `You can reply to this message, or continue the conversation at ${env.appUrl}/support/requests`,
      'OffersOffer Support',
    ].join('\n'),
  });
}

/** Status, priority and assignment - the queue's own housekeeping. */
async function update(id, payload, actor) {
  const ticket = await getRow(id);
  const sets = [];
  const values = [];

  if (payload.status && payload.status !== ticket.status) {
    sets.push('status = ?');
    values.push(payload.status);
    // Stamped when it happens rather than computed from `updated_at`, which any
    // later edit would move. Cleared on re-open so "resolved on" stays true.
    sets.push('resolved_at = ?');
    values.push(payload.status === 'resolved' || payload.status === 'closed' ? new Date() : null);
  }

  if (payload.priority) {
    sets.push('priority = ?');
    values.push(payload.priority);
  }

  if (payload.assignedTo !== undefined) {
    if (payload.assignedTo !== null) {
      const assignee = await queryOne('SELECT id FROM users WHERE id = ? AND status = ?', [
        payload.assignedTo,
        'active',
      ]);
      if (!assignee) throw ApiError.badRequest('That user cannot be assigned');
    }
    sets.push('assigned_to = ?');
    values.push(payload.assignedTo);
  }

  if (sets.length) {
    values.push(id);
    await execute(`UPDATE support_tickets SET ${sets.join(', ')} WHERE id = ?`, values);
  }

  return getForUser(id, actor);
}

module.exports = {
  create,
  getForUser,
  listMine,
  listAll,
  openCount,
  addMessage,
  update,
  referenceFor,
};
