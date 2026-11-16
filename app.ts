// app.ts — the forge's HTTP wiring: health, git smart HTTP, REST v3, GraphQL and MCP, all over
// forge.ts's one shared store. main.ts owns the lifecycle (bind, register, wait for done); this
// file is only the server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { store, VIEWER_LOGIN } from './forge.ts';
import { infoRefs, receivePack, uploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Whether the request carries the trial's bearer token. */
function authenticated(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || header === '') return false;
  if (TOKEN !== '') return header === `Bearer ${TOKEN}`;
  return header.startsWith('Bearer ');
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (status === 204 || body === undefined) {
    res.writeHead(status, headers);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The REST surface: auth, the malformed-body rule, the request-id header, then rest.ts's router. */
async function serveRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const requestId = store.nextRequestId();
  const headers = { 'x-github-request-id': requestId };
  if (!authenticated(req)) {
    sendJson(res, 401, { message: 'Bad credentials' }, headers);
    return;
  }
  const raw = await readBody(req);
  let body: Record<string, unknown> | undefined;
  if (raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      body = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      sendJson(res, 400, { message: 'Problems parsing JSON' }, headers);
      return;
    }
  }
  const segments = url.pathname
    .slice('/api/v3'.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment);
  const reply = handleRest({
    method: req.method ?? 'GET',
    segments,
    query: url.searchParams,
    body,
    origin: `http://${req.headers.host ?? 'localhost'}`,
  });
  sendJson(res, reply.status, reply.body, { ...headers, ...(reply.headers ?? {}) });
}

async function serveGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authenticated(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  let payload: unknown;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Request body is not valid JSON' }] });
    return;
  }
  const reply = handleGraphQL(payload);
  sendJson(res, reply.status, reply.body);
}

async function serveMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authenticated(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const raw = await readBody(req);
  const reply = handleMcp(raw.toString('utf8'));
  if (reply.body === undefined) {
    res.writeHead(reply.status);
    res.end();
    return;
  }
  sendJson(res, reply.status, reply.body);
}

async function serveGit(req: IncomingMessage, res: ServerResponse, url: URL, match: RegExpExecArray): Promise<void> {
  if (!authenticated(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  const owner = decodeSegment(match[1]!);
  const name = decodeSegment(match[2]!);
  const sub = match[3]!;
  const repo = owner === VIEWER_LOGIN ? store.repos.get(name) : undefined;
  const protocolV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
  if (sub === 'info/refs' && (req.method ?? 'GET') === 'GET') {
    const reply = infoRefs(repo, url.searchParams.get('service') ?? '', protocolV2);
    res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length });
    res.end(reply.body);
    return;
  }
  if (sub === 'git-upload-pack' && (req.method ?? 'GET') === 'POST') {
    const body = await readBody(req);
    const reply = uploadPack(repo, body, protocolV2);
    res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length });
    res.end(reply.body);
    return;
  }
  if (sub === 'git-receive-pack' && (req.method ?? 'GET') === 'POST') {
    const body = await readBody(req);
    const reply = receivePack(repo, body);
    res.writeHead(reply.status, { 'content-type': reply.contentType, 'content-length': reply.body.length });
    res.end(reply.body);
    return;
  }
  sendJson(res, 404, { message: 'Not Found' });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          await serveRest(req, res, url);
          return;
        }
        if (path === '/api/graphql') {
          await serveGraphQL(req, res);
          return;
        }
        if (path === '/mcp') {
          await serveMcp(req, res);
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
        if (gitMatch !== null) {
          await serveGit(req, res, url, gitMatch);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
      } catch {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
}
