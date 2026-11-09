'use strict';
/**
 * email-intel/transport/errors.js — typed transport errors (design 12).
 *
 * Every message is a fixed string. No error carries a URL, header, id, subject, body or address.
 *   code               stable enum (logged)
 *   definitiveNotSent  a `final` request failed before anything was written (or with a definitive 4xx)
 *   uncertain          a `final` request may have reached the server
 *   status / apiCode   HTTP status and the sanitized `error.code` of the response
 *   reason             a short enum (token reasons, 'deadline', ...)
 */
class ApiError extends Error {
  constructor(message, code, extra) {
    super(message);
    this.name = 'ApiError';
    this.code = code || 'API_ERROR';
    const e = extra || {};
    this.definitiveNotSent = e.definitiveNotSent === true;
    this.uncertain = e.uncertain === true;
    this.status = Number.isFinite(e.status) ? e.status : 0;
    this.apiCode = typeof e.apiCode === 'string' ? e.apiCode : null;
    this.reason = typeof e.reason === 'string' ? e.reason : null;
  }
}
class ApiAuthBlockedError extends ApiError {
  constructor(extra) { super('Outlook sign-in required', 'OWA_AUTH_BLOCKED', extra); this.name = 'ApiAuthBlockedError'; }
}
class TokenUnavailableError extends ApiError {
  constructor(reason, extra) { super('Outlook token unavailable', 'API_TOKEN_UNAVAILABLE', Object.assign({}, extra, { reason: reason || 'no-bearer' })); this.name = 'TokenUnavailableError'; }
}
class ThrottledError extends ApiError {
  constructor(status, extra) { super('Outlook throttled the request', 'API_THROTTLED', Object.assign({}, extra, { status: status || 429 })); this.name = 'ThrottledError'; }
}
class ApiHttpError extends ApiError {
  constructor(status, apiCode, extra) { super('Outlook request failed', 'API_HTTP', Object.assign({}, extra, { status, apiCode: apiCode || 'Unknown' })); this.name = 'ApiHttpError'; }
}
class ApiTimeoutError extends ApiError {
  constructor(extra) { super('Outlook request timed out', 'API_TIMEOUT', extra); this.name = 'ApiTimeoutError'; }
}
class ApiNetworkError extends ApiError {
  constructor(extra) { super('Outlook request network error', 'API_NETWORK', extra); this.name = 'ApiNetworkError'; }
}
class ResponseTooLargeError extends ApiError {
  constructor(extra) { super('Outlook response too large', 'API_TOO_LARGE', extra); this.name = 'ResponseTooLargeError'; }
}
class RequestRefusedError extends ApiError {
  constructor(reason, extra) { super('Outlook request refused by the allow-list', 'API_REFUSED', Object.assign({}, extra, { reason: reason || 'refused' })); this.name = 'RequestRefusedError'; }
}
class AbortedError extends ApiError {
  constructor(reason, extra) { super('Outlook request aborted', 'API_ABORTED', Object.assign({}, extra, { reason: reason || 'aborted' })); this.name = 'AbortedError'; }
}

module.exports = {
  ApiError, ApiAuthBlockedError, TokenUnavailableError, ThrottledError, ApiHttpError, ApiTimeoutError, ApiNetworkError,
  ResponseTooLargeError, RequestRefusedError, AbortedError,
};
