#!/usr/bin/env node
import http from 'http';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createLighthouseServer } from './server.js';

// Streamable-HTTP entrypoint for remote hosting (e.g. inside a Cloudflare
// Container). Exposes the MCP endpoint at POST /mcp using a stateless
// transport: a fresh Server + transport per request, JSON responses enabled.
// This keeps the deployment simple and horizontally scalable — no session
// state is held between requests.

const PORT = parseInt(process.env.PORT || '8080', 10);
const HOST = process.env.HOST || '0.0.0.0';
const MCP_PATH = process.env.MCP_PATH || '/mcp';

// Optional shared secret for standalone/docker use. On Cloudflare, auth is
// enforced at the Worker edge instead (the container is not publicly
// reachable). When MCP_AUTH_TOKEN is set here, /mcp requires
// `Authorization: Bearer <token>`.
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN || '';

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function isAuthorized(req: http.IncomingMessage): boolean {
  if (!AUTH_TOKEN) return true;
  const header = req.headers['authorization'] || '';
  const prefix = 'Bearer ';
  const token = header.startsWith(prefix) ? header.slice(prefix.length) : '';
  return token.length > 0 && tokensMatch(token, AUTH_TOKEN);
}

// Cap request body size to avoid unbounded buffering (JSON-RPC payloads are small).
const MAX_BODY_BYTES = 1_000_000;

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse) {
  // Stateless mode only makes sense for POST (client->server JSON-RPC).
  // GET (server-initiated SSE) and DELETE (session teardown) aren't supported
  // without sessions, so reject them clearly.
  if (!isAuthorized(req)) {
    res.setHeader('WWW-Authenticate', 'Bearer realm="lighthouse-mcp"');
    sendJson(res, 401, {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    });
    return;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, {
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method Not Allowed. Use POST for stateless MCP.' },
      id: null,
    });
    return;
  }

  let parsedBody: unknown;
  try {
    const raw = await readBody(req);
    parsedBody = raw ? JSON.parse(raw) : undefined;
  } catch (err: any) {
    sendJson(res, 400, {
      jsonrpc: '2.0',
      error: { code: -32700, message: `Parse error: ${err?.message || err}` },
      id: null,
    });
    return;
  }

  // Fresh, isolated Server + transport per request (stateless).
  const server = createLighthouseServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req as any, res, parsedBody);
  } catch (err: any) {
    console.error('[MCP] request handling error:', err);
    if (!res.headersSent) {
      sendJson(res, 500, {
        jsonrpc: '2.0',
        error: { code: -32603, message: `Internal server error: ${err?.message || err}` },
        id: null,
      });
    }
  }
}

const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  const reqId = randomUUID();

  if (url.pathname === '/health' || url.pathname === '/healthz') {
    sendJson(res, 200, { status: 'ok', service: 'lighthouse-mcp' });
    return;
  }

  if (url.pathname === '/') {
    sendJson(res, 200, {
      service: 'lighthouse-mcp',
      transport: 'streamable-http',
      endpoint: MCP_PATH,
    });
    return;
  }

  if (url.pathname === MCP_PATH) {
    handleMcp(req, res).catch((err) => {
      console.error(`[MCP:${reqId}] unhandled error:`, err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: '2.0',
          error: { code: -32603, message: 'Internal server error' },
          id: null,
        });
      }
    });
    return;
  }

  sendJson(res, 404, {
    jsonrpc: '2.0',
    error: { code: -32601, message: `Not found: ${url.pathname}` },
    id: null,
  });
});

httpServer.listen(PORT, HOST, () => {
  console.error(`Lighthouse MCP server (streamable-http) listening on http://${HOST}:${PORT}${MCP_PATH}`);
});

const shutdown = () => {
  httpServer.close(() => process.exit(0));
  // Force-exit if connections linger.
  setTimeout(() => process.exit(0), 5000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
