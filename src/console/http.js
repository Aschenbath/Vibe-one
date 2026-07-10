import { ConsoleError } from './errors.js';

export function readJson(req, { maxBytes = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    let rejected = false;

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        if (!rejected) {
          rejected = true;
          reject(new ConsoleError('BODY_TOO_LARGE', 'Request body is too large.', 413));
        }
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      if (rejected) return;
      if (!body.trim()) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new ConsoleError('JSON_INVALID', 'Request body must be valid JSON.', 400));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, body) {
  const content = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
  });
  res.end(content);
}

export function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  const content = String(text);
  res.writeHead(status, {
    'content-type': type,
    'content-length': Buffer.byteLength(content),
    'cache-control': 'no-store',
  });
  res.end(content);
}

export function sendBuffer(res, status, data, type) {
  res.writeHead(status, {
    'content-type': type,
    'content-length': data.length,
    'cache-control': 'private, max-age=60',
  });
  res.end(data);
}

export function sendError(res, error) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (error instanceof ConsoleError) {
    sendJson(res, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'The local console could not complete this request.' } });
}
