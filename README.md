# Lighthouse MCP Server

An MCP server that wraps around Google's Lighthouse tool to help measure various performance metrics for web pages.

## Features

- Run comprehensive Lighthouse audits on any URL
- Get performance scores and metrics
- Configure device emulation (mobile/desktop)
- Control network throttling
- Select specific audit categories

## Installation

### Option 1: From MCP Registry (Recommended)

This server is available in the [Model Context Protocol Registry](https://registry.modelcontextprotocol.io/servers/io.github.priyankark/lighthouse-mcp). Install it using your MCP client or Claude Desktop.

### Option 2: Using npx

You can run the tool directly using npx without installation:

```bash
npx lighthouse-mcp
```

### Option 3: Global Installation

Install the package globally from npm:

```bash
npm install -g lighthouse-mcp
```

Then run it:

```bash
lighthouse-mcp
```

### Option 4: Local Development

1. Clone this repository
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build the project:
   ```bash
   npm run build
   ```
4. Run the server:
   ```bash
   npm start
   ```

## MCP Configuration

### When installed via npm (global or npx)

Add the following to your MCP settings configuration file:

```json
{
  "mcpServers": {
    "lighthouse": {
      "command": "npx",
      "args": ["lighthouse-mcp"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### When using local development version

Add the following to your MCP settings configuration file:

```json
{
  "mcpServers": {
    "lighthouse": {
      "command": "node",
      "args": ["/absolute/path/to/lighthouse-mcp/build/index.js"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Replace `/absolute/path/to/lighthouse-mcp` with the actual path to this project.

## Hosting on Cloudflare (remote MCP server)

This server can be hosted as a **remote MCP server on Cloudflare**, exposing a
Streamable-HTTP `/mcp` endpoint that any MCP client can connect to over the
network.

### Why a Container (and not a bare Worker)

Lighthouse works by launching a real headless **Chrome** and driving it over the
DevTools protocol. A plain Cloudflare Worker is a V8 isolate — it cannot spawn a
Chrome process or run the heavy `lighthouse` npm package, even with
`nodejs_compat`. So the audit itself must run in a full Linux environment.

The deployment therefore uses **Cloudflare Containers**:

```
MCP client ──HTTP──▶ Worker (src/worker.ts) ──▶ Container
                     forwards /mcp             Node + Chromium + Lighthouse
                                               Streamable-HTTP MCP (src/http.ts)
```

- `src/worker.ts` — a thin Worker that forwards requests to a container
  instance (`getRandom` load-balances across `max_instances`).
- `src/http.ts` — a Node HTTP server inside the container that serves the MCP
  protocol over **Streamable HTTP** (stateless: a fresh server per request) at
  `POST /mcp`, plus a `GET /health` check.
- `Dockerfile` — installs Chromium and runs `build/http.js`.
- `wrangler.jsonc` — wires the container, its Durable Object binding, and the
  migration.

The local **stdio** transport (`src/index.ts`, used by `npx lighthouse-mcp`) is
unchanged — both transports share the audit logic in `src/server.ts`.

### Prerequisites

- A **paid Cloudflare Workers plan** (Containers are not on the free plan).
- **Docker** running locally (Wrangler builds the image before deploying).
- Wrangler authenticated: `npx wrangler login`.

### Deploy

```bash
npm install
npm run build        # optional; the Docker image also builds inside the container
npm run cf:deploy    # wrangler deploy — builds the image and deploys the Worker
```

Wrangler prints the deployed Worker URL, e.g.
`https://lighthouse-mcp.<your-subdomain>.workers.dev`. The MCP endpoint is that
URL + `/mcp`.

### Protect it with a shared secret

Set an `MCP_AUTH_TOKEN` secret and the Worker will require
`Authorization: Bearer <token>` on every `/mcp` request (the `/health` check
stays open). Auth is enforced at the Worker edge; the container itself is not
publicly reachable.

```bash
# Generate a strong token and store it as a Worker secret:
openssl rand -base64 32 | npx wrangler secret put MCP_AUTH_TOKEN
```

Setting the secret triggers a new deployment. Omit this step to leave the
endpoint open. To rotate, run the command again with a new value; to disable,
`npx wrangler secret delete MCP_AUTH_TOKEN`.

> **Note:** the first request cold-starts a container and can take a while; a
> full audit itself takes tens of seconds. `sleepAfter` (in `src/worker.ts`)
> keeps instances warm between audits.

### Connect an MCP client

Point any Streamable-HTTP-capable MCP client at the `/mcp` URL:

```json
{
  "mcpServers": {
    "lighthouse-remote": {
      "type": "streamable-http",
      "url": "https://lighthouse-mcp.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <your MCP_AUTH_TOKEN>"
      }
    }
  }
}
```

For clients that only speak stdio, bridge with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```json
{
  "mcpServers": {
    "lighthouse-remote": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://lighthouse-mcp.<your-subdomain>.workers.dev/mcp",
        "--header",
        "Authorization: Bearer <your MCP_AUTH_TOKEN>"
      ]
    }
  }
}
```

(Drop the `headers` / `--header` entries if you didn't set `MCP_AUTH_TOKEN`.)

> **Security:** set `MCP_AUTH_TOKEN` (see above) so the endpoint isn't open to
> anyone with the URL; for stronger protection put Cloudflare Access or OAuth in
> front of it. SSRF protection blocks private/metadata IP ranges by default, and
> `LIGHTHOUSE_BLOCK_LOOPBACK=1` (set in the container) additionally rejects
> loopback targets in the remote deployment.

### Run the HTTP server locally (without Cloudflare)

The same container server runs anywhere Node + Chrome are available:

```bash
npm run build
PORT=8080 node build/http.js
# then POST JSON-RPC to http://localhost:8080/mcp
```

Or build and run the container image directly:

```bash
docker build -t lighthouse-mcp .
docker run --rm -p 8080:8080 lighthouse-mcp
```

### Tuning

- **Instance size** — `instance_type` in `wrangler.jsonc` (default `standard-3`:
  2 vCPU / 8 GiB). Drop to `standard-2` to save cost, or raise for concurrency.
- **Concurrency** — keep `max_instances` (`wrangler.jsonc`) and `INSTANCE_COUNT`
  (`src/worker.ts`) in sync.
- **Chrome flags** — append via the `LIGHTHOUSE_CHROME_FLAGS` env var.

## Available Tools

### run_audit

Run a comprehensive Lighthouse audit on a URL.

**Parameters:**
- `url` (required): The URL to audit
- `categories` (optional): Array of categories to audit (defaults to all)
  - Options: "performance", "accessibility", "best-practices", "seo", "pwa"
- `device` (optional): Device to emulate (defaults to "mobile")
  - Options: "mobile", "desktop"
- `throttling` (optional): Whether to apply network throttling (defaults to true)

**Example:**
```json
{
  "url": "https://example.com",
  "categories": ["performance", "accessibility"],
  "device": "desktop",
  "throttling": false
}
```

### get_performance_score

Get just the performance score for a URL.

**Parameters:**
- `url` (required): The URL to audit
- `device` (optional): Device to emulate (defaults to "mobile")
  - Options: "mobile", "desktop"

**Example:**
```json
{
  "url": "https://example.com",
  "device": "mobile"
}
```

## Example Usage

Once the MCP server is configured, you can use it with Claude:

```
What's the performance score for example.com?
```

Claude will use the `get_performance_score` tool to analyze the website and return the results.

## Requirements

- Node.js 16+
- Chrome/Chromium browser (for Lighthouse)

## Endorsements
<a href="https://glama.ai/mcp/servers/@priyankark/lighthouse-mcp">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/@priyankark/lighthouse-mcp/badge" />
</a>
