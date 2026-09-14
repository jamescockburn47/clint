/** Only fixed machine codes/classes may enter diagnostic logs; messages are source data. */
const CODES = new Set(['EACCES', 'EADDRINUSE', 'EAGAIN', 'EBUSY', 'ECONNABORTED',
  'ECONNREFUSED', 'ECONNRESET', 'EEXIST', 'EHOSTUNREACH', 'EINTR', 'EIO', 'EMFILE',
  'ENETUNREACH', 'ENFILE', 'ENOENT', 'ENOSPC', 'ENOTDIR', 'ENOTFOUND', 'EPERM',
  'EPIPE', 'EROFS', 'ETIMEDOUT', 'ABORT_ERR', 'ERR_CANCELED',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'slack_webapi_rate_limited_error', 'slack_webapi_platform_error',
  'slack_webapi_request_error', 'slack_webapi_http_error']);
const NAMES = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'ReferenceError',
  'URIError', 'EvalError', 'AggregateError', 'AbortError', 'TimeoutError']);

export function safeErrorCode(err) {
  if (CODES.has(err?.code)) return err.code;
  return NAMES.has(err?.name) ? err.name : 'Error';
}
