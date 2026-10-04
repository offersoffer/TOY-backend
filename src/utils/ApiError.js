'use strict';

/** Error carrying an HTTP status so the error middleware can respond precisely. */
class ApiError extends Error {
  constructor(status, message, details = undefined, code = undefined) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
    this.code = code;
    this.expected = true;
  }

  static badRequest(message = 'Bad request', details) {
    return new ApiError(400, message, details, 'BAD_REQUEST');
  }

  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, message, undefined, 'UNAUTHORIZED');
  }

  static forbidden(message = 'You do not have permission to perform this action') {
    return new ApiError(403, message, undefined, 'FORBIDDEN');
  }

  static notFound(message = 'Resource not found') {
    return new ApiError(404, message, undefined, 'NOT_FOUND');
  }

  static conflict(message = 'Resource already exists') {
    return new ApiError(409, message, undefined, 'CONFLICT');
  }

  static unprocessable(message = 'Validation failed', details) {
    return new ApiError(422, message, details, 'VALIDATION_ERROR');
  }

  static tooMany(message = 'Too many requests') {
    return new ApiError(429, message, undefined, 'RATE_LIMITED');
  }

  /**
   * A fault of ours. The wording is §38's, verbatim: it admits the failure,
   * says it is being worked on, and names nothing - not the database, not the
   * service, not the status code that caused it.
   */
  static internal(message = 'Something went wrong on our side. We’re working to restore the service. Please try again shortly.') {
    return new ApiError(500, message, undefined, 'INTERNAL_ERROR');
  }

  /**
   * A dependency we need is not answering. Distinct from `internal` only in
   * status: 503 is what tells a client this is worth retrying, which is what
   * §37's [Retry] button acts on.
   */
  static serviceUnavailable(
    message = 'We’re having trouble connecting to OffersOffer. Please try again.',
  ) {
    return new ApiError(503, message, undefined, 'SERVICE_UNAVAILABLE');
  }

  /**
   * A safe operation that timed out. §50 splits these from critical ones: this
   * carries the retryable code, and a payment or redemption must never use it.
   */
  static timeout(message = 'This is taking longer than expected. Please try again.') {
    return new ApiError(504, message, undefined, 'TIMEOUT');
  }
}

module.exports = ApiError;
