/// <reference types="@cloudflare/workers-types" />
import { Container, getRandom } from '@cloudflare/containers';

// Number of container instances to spread audit load across. Keep this <=
// `max_instances` in wrangler.jsonc. Lighthouse audits are CPU/memory heavy and
// effectively single-flight per instance, so more instances = more concurrency.
const INSTANCE_COUNT = 3;

interface Env {
  LIGHTHOUSE_CONTAINER: DurableObjectNamespace<LighthouseContainer>;
}

/**
 * Durable-Object-backed Container that runs the Node + Chromium + Lighthouse
 * image. The container serves the MCP endpoint over Streamable HTTP on
 * `defaultPort`; this Worker just forwards requests to it.
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Stateless MCP server, so any instance can serve any request. Spread load
    // across INSTANCE_COUNT warm instances.
    const container = await getRandom(env.LIGHTHOUSE_CONTAINER, INSTANCE_COUNT);
    return container.fetch(request);
  },
};
