// app.ts — HTTP server: routing, auth, JSON helpers, request-id header.
// Delegates: /api/v3/* -> rest.ts, /api/graphql -> graphql.ts,
// /mcp -> mcp.ts, /{owner}/{repo}.git/* -> git-http.ts handleGit.
// Fast routing: the path is split once, no regex in hot paths. Body is
// parsed once (with a size cap); malformed JSON is reported to the
// handler, which decides the per-surface error shape.
// Auth: a valid Bearer token is required on every route except /healthz
// and GET /api/v3/ (the API root). When MAKEFUN_SHOP_TOKEN is set in the
// environment the token must match it exactly; otherwise any non-empty
// Bearer token is accepted (the suite only ever checks the missing-token
// case). No Date.now()/Math.random() in any response.

import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import { handleRest, store } from './rest.ts';
import type { HandlerCtx } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git-http.ts';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
let reqCounter = 0;

function nextReqId(): string {
  reqCounter += 1;
  return `req-${reqCounter}`;
}

function authOk(req: IncomingMessage): boolean {
  const h = req.headers.authorization;
  if (!h) return false;
  // Fast path for the usual "Bearer <token>" shape; no regex per request.
  const lower = h.slice(0, 7).toLowerCase();
  let token = lower === 'bearer ' || lower === 'bearer\t' ? h.slice(7) : '';
  // Tolerate extra blanks after the scheme, as the old regex did.
  let i = 0;
  while (i < token.length && (token[i] === ' ' || token[i] === '\t')) i += 1;
  if (i > 0) token = token.slice(i);
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  if (expected) return token === expected;
  return true;
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function readBody(req: IncomingMessage): Promise<{ text: string; tooLarge: boolean }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
      chunks.push(c);
    });
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge }));
    req.on('error', () => resolve({ text: '', tooLarge: false }));
  });
}

interface Senders {
  sendJson: (status: number, data: unknown, extra?: Record<string, string>) => void;
  sendEmpty: (status: number) => void;
}

function makeSenders(res: ServerResponse, reqId: string): Senders {
  const sendJson = (status: number, data: unknown, extra?: Record<string, string>): void => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-github-request-id': reqId,
      ...(extra ?? {}),
    };
    if (status === 204) {
      res.writeHead(204, headers);
      res.end();
      return;
    }
    const body = data === null || data === undefined ? '' : JSON.stringify(data);
    headers['content-length'] = String(Buffer.byteLength(body));
    res.writeHead(status, headers);
    res.end(body);
  };
  const sendEmpty = (status: number): void => {
    res.writeHead(status, { 'x-github-request-id': reqId });
    res.end();
  };
  return { sendJson, sendEmpty };
}

function parseJsonBody(text: string): { body: unknown; parseError: boolean } {
  if (text.length === 0) return { body: null, parseError: false };
  try {
    return { body: JSON.parse(text), parseError: false };
  } catch {
    return { body: null, parseError: true };
  }
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const reqId = nextReqId();
  const { sendJson, sendEmpty } = makeSenders(res, reqId);
  const rawUrl = req.url ?? '/';
  const qIdx = rawUrl.indexOf('?');
  const pathname = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
  const query = new URLSearchParams(qIdx === -1 ? '' : rawUrl.slice(qIdx + 1));
  const method = (req.method ?? 'GET').toUpperCase();
  const host = req.headers.host ?? '127.0.0.1';
  const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';

  const baseCtx = (parts: string[], body: unknown, parseError: boolean, rawBody: string): HandlerCtx => ({
    method, parts, query, host, body, parseError, rawBody, sendJson, sendEmpty,
  });

  // /healthz — no auth.
  if (pathname === '/healthz') {
    sendJson(200, { ok: true });
    return;
  }

  // GraphQL v4.
  if (pathname === '/api/graphql') {
    if (method !== 'POST') { sendJson(404, { message: 'Not Found' }); return; }
    if (!authOk(req)) { sendJson(401, { message: 'Requires authentication' }); return; }
    const { text, tooLarge } = await readBody(req);
    const parsed = parseJsonBody(text);
    handleGraphql(baseCtx([], parsed.body, parsed.parseError || tooLarge, text));
    return;
  }

  // MCP (Streamable HTTP).
  if (pathname === '/mcp') {
    if (method !== 'POST' && method !== 'DELETE') { sendJson(404, { message: 'Not Found' }); return; }
    if (!authOk(req)) { sendJson(401, { message: 'Requires authentication' }); return; }
    if (method === 'DELETE') { sendJson(200, {}); return; }
    const { text, tooLarge } = await readBody(req);
    const parsed = parseJsonBody(text);
    handleMcp(baseCtx([], parsed.body, parsed.parseError || tooLarge, text));
    return;
  }

  // REST v3.
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    const isRootGet = (pathname === '/api/v3' || pathname === '/api/v3/') && method === 'GET';
    if (!isRootGet && !authOk(req)) {
      sendJson(401, { message: 'Requires authentication' });
      return;
    }
    const rest = pathname.slice('/api/v3'.length);
    const parts = rest.split('/').filter((s) => s.length > 0).map(decodeSafe);
    let body: unknown = null;
    let parseError = false;
    let rawBody = '';
    if (needsBody) {
      const read = await readBody(req);
      rawBody = read.text;
      const parsed = parseJsonBody(read.text);
      body = parsed.body;
      parseError = parsed.parseError || read.tooLarge;
    }
    handleRest(baseCtx(parts, body, parseError, rawBody));
    return;
  }

  // Git smart HTTP — pass the request through untouched (binary body);
  // git-http.ts reads the stream itself. Auth still applies here.
  const segs = pathname.split('/').filter((s) => s.length > 0);
  if (segs.length >= 2 && segs[1].endsWith('.git')) {
    if (!authOk(req)) { sendJson(401, { message: 'Requires authentication' }); return; }
    // handleGit is async and reads the request body itself; await it so a
    // rejection surfaces here instead of becoming an unhandled rejection.
    await handleGit(req, res, store, segs.map(decodeSafe));
    return;
  }

  sendJson(404, { message: 'Not Found' });
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    void route(req, res).catch(() => {
      try {
        // Last-resort 500: still JSON, still carries a request id.
        res.writeHead(500, { 'content-type': 'application/json', 'x-github-request-id': `req-${reqCounter}` });
        res.end(JSON.stringify({ message: 'Internal Server Error' }));
      } catch {
        // Response already gone; nothing to do.
      }
    });
  });
  return server;
}
