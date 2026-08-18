/// <reference types="@cloudflare/workers-types" />
import { Container, getRandom } from '@cloudflare/containers';

// Number of container instances to spread audit load across. Keep this <=
// `max_instances` in wrangler.jsonc. Lighthouse audits are CPU/memory heavy and
// effectively single-flight per instance, so more instances = more concurrency.
const INSTANCE_COUNT = 3;

interface Env {
  LIGHTHOUSE_CONTAINER: DurableObjectNamespace<LighthouseContainer>;
  // Optional shared secret. When set (as a Wrangler secret), every request to
  // the MCP endpoint must present `Authorization: Bearer <MCP_AUTH_TOKEN>`.
  // When unset, the endpoint is open.
  MCP_AUTH_TOKEN?: string;
}

/**
 * Durable-Object-backed Container that runs the Node + Chromium + Lighthouse
 * image. The container serves the MCP endpoint over Streamable HTTP on
 * `defaultPort`; this Worker authenticates and forwards requests to it.
 */
export class LighthouseContainer extends Container<Env> {
  // Must match PORT/HOST the container's HTTP server binds to (see src/http.ts).
  defaultPort = 8080;
  // A full Lighthouse audit can take tens of seconds; keep instances warm for a
  // while so back-to-back audits reuse a hot browser environment.
  sleepAfter = '10m';
  // Passed into the container process. CHROME_PATH points at the Chromium we
  // install in the Dockerfile.
  envVars = {
    PORT: '8080',
    CHROME_PATH: '/usr/bin/chromium',
    // Block auditing loopback in the remote deployment (it would target the
    // container itself, not anything the caller means).
    LIGHTHOUSE_BLOCK_LOOPBACK: '1',
  };
}

// Timing-safe-ish comparison of two secrets. Bytes are XOR-accumulated so the
// loop doesn't short-circuit on the first mismatch. Length is compared first,
// which leaks only the token length — acceptable for a bearer secret.
function tokensMatch(provided: string, expected: string): boolean {
  const enc = new TextEncoder();
  const a = enc.encode(provided);
  const b = enc.encode(expected);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Unauthorized' },
      id: null,
    }),
    {
      status: 401,
      headers: {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer realm="lighthouse-mcp"',
      },
    },
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health check is unauthenticated and answered at the edge (no need to
    // cold-start a container just to prove the Worker is up).
    if (url.pathname === '/health' || url.pathname === '/healthz') {
      return new Response(JSON.stringify({ status: 'ok', service: 'lighthouse-mcp' }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // Enforce the shared secret when configured.
    if (env.MCP_AUTH_TOKEN) {
      const header = request.headers.get('authorization') || '';
      const prefix = 'Bearer ';
      const token = header.startsWith(prefix) ? header.slice(prefix.length) : '';
      if (!token || !tokensMatch(token, env.MCP_AUTH_TOKEN)) {
        return unauthorized();
      }
    }

    // Stateless MCP server, so any instance can serve any request. Spread load
    // across INSTANCE_COUNT warm instances.
    const container = await getRandom(env.LIGHTHOUSE_CONTAINER, INSTANCE_COUNT);
    return container.fetch(request);
  },
};
