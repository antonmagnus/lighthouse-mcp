import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  CallToolRequest,
} from '@modelcontextprotocol/sdk/types.js';
import lighthouse from 'lighthouse';
import * as chromeLauncher from 'chrome-launcher';
import os from 'os';
import fs from 'fs';
import path from 'path';
import dns from 'dns/promises';
import net from 'net';

// Workaround for modelcontextprotocol/typescript-sdk#1380
// In some Zod runtimes, the method literal is stored under `_def.values[0]`
// instead of `_def.value` / `.value`, causing "Schema method literal must be a string"
// during Server initialization. This patches setRequestHandler to handle both cases.
const originalSetRequestHandler = Server.prototype.setRequestHandler;
Server.prototype.setRequestHandler = function patchedSetRequestHandler(
  requestSchema: any,
  handler: any,
) {
  try {
    return originalSetRequestHandler.call(this, requestSchema, handler);
  } catch (err: any) {
    if (err?.message !== 'Schema method literal must be a string') throw err;

    // Attempt to fix the schema by copying values[0] to value
    try {
      const shape = requestSchema?.shape ?? requestSchema?._def?.shape?.();
      const methodSchema = shape?.method;
      const def = methodSchema?._def;
      const maybeValue = Array.isArray(def?.values) ? def.values[0] : undefined;
      if (typeof maybeValue === 'string') {
        if (def && def.value === undefined) def.value = maybeValue;
        if (methodSchema && methodSchema.value === undefined)
          methodSchema.value = maybeValue;
      }
    } catch {
      // If patching fails, rethrow the original error
    }

    return originalSetRequestHandler.call(this, requestSchema, handler);
  }
};

// ---------------------------------------------------------------------------
// SSRF protection — validate URLs before passing to Lighthouse
// Allows localhost/loopback (needed for local dev servers) but blocks
// cloud metadata endpoints, RFC 1918 private ranges, and link-local IPs.
// This matters even more when hosted remotely (e.g. on Cloudflare), where an
// attacker could otherwise coax the auditor into probing internal services.
// ---------------------------------------------------------------------------

const BLOCKED_IP_RANGES = [
  // RFC 1918 private networks
  { prefix: '10.', mask: null },
  { prefix: '172.', mask: (ip: string) => { const b = parseInt(ip.split('.')[1], 10); return b >= 16 && b <= 31; } },
  { prefix: '192.168.', mask: null },
  // Link-local (includes AWS metadata 169.254.169.254)
  { prefix: '169.254.', mask: null },
];

const BLOCKED_HOSTNAMES = [
  'metadata.google.internal',
  'metadata.goog',
];

function isBlockedIP(ip: string): boolean {
  for (const range of BLOCKED_IP_RANGES) {
    if (ip.startsWith(range.prefix)) {
      if (range.mask === null || range.mask(ip)) return true;
    }
  }
  return false;
}

function isLoopback(ip: string): boolean {
  if (ip === '::1') return true;
  if (ip.startsWith('127.')) return true;
  return false;
}

// When true (default off), loopback/localhost targets are rejected too. Useful
// for remote deployments where auditing "localhost" would target the server
// itself rather than anything meaningful. Set LIGHTHOUSE_BLOCK_LOOPBACK=1.
const BLOCK_LOOPBACK = process.env.LIGHTHOUSE_BLOCK_LOOPBACK === '1';

export async function validateUrl(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpError(ErrorCode.InvalidParams, `Invalid URL: ${url}`);
  }

  // Only allow http and https schemes
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Unsupported URL scheme "${parsed.protocol}" — only http: and https: are allowed`,
    );
  }

  const hostname = parsed.hostname;

  // Block known cloud metadata hostnames
  if (BLOCKED_HOSTNAMES.includes(hostname.toLowerCase())) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `URL hostname "${hostname}" is blocked (cloud metadata endpoint)`,
    );
  }

  // If the hostname is an IP literal, validate it directly
  if (net.isIP(hostname)) {
    if (isLoopback(hostname)) {
      if (BLOCK_LOOPBACK) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Loopback address (${hostname}) is not allowed in this deployment`,
        );
      }
      return; // allow localhost
    }
    if (isBlockedIP(hostname)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `URL resolves to a blocked internal IP address (${hostname})`,
      );
    }
    return;
  }

  // Resolve the hostname and check every returned address
  let addresses: string[];
  try {
    const results = await dns.resolve4(hostname);
    addresses = results;
  } catch {
    // If DNS resolution fails, let Lighthouse handle the error naturally
    return;
  }

  for (const ip of addresses) {
    if (isLoopback(ip)) {
      if (BLOCK_LOOPBACK) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `URL hostname "${hostname}" resolves to loopback (${ip}), which is not allowed in this deployment`,
        );
      }
      continue; // allow localhost
    }
    if (isBlockedIP(ip)) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `URL hostname "${hostname}" resolves to blocked internal IP address (${ip})`,
      );
    }
  }
}

// Define types for Lighthouse
interface LighthouseResult {
  lhr: {
    finalDisplayedUrl: string;
    fetchTime: string;
    lighthouseVersion: string;
    userAgent: string;
    categories: Record<string, any>;
    audits: Record<string, any>;
  };
}

export interface RunAuditArgs {
  url: string;
  categories?: string[];
  device?: 'mobile' | 'desktop';
  throttling?: boolean;
}

const isValidAuditArgs = (args: any): args is RunAuditArgs => {
  return (
    typeof args === 'object' &&
    args !== null &&
    typeof args.url === 'string' &&
    (args.categories === undefined ||
      (Array.isArray(args.categories) &&
        args.categories.every((cat: any) => typeof cat === 'string'))) &&
    (args.device === undefined ||
      args.device === 'mobile' ||
      args.device === 'desktop') &&
    (args.throttling === undefined || typeof args.throttling === 'boolean')
  );
};

// Chrome flags used when launching the browser. In a container (or any headless
// server) we need --no-sandbox plus flags that avoid the tiny default /dev/shm
// and the missing GPU. Extra flags can be appended via LIGHTHOUSE_CHROME_FLAGS.
function resolveChromeFlags(): string[] {
  const flags = [
    '--headless',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
  ];
  const extra = process.env.LIGHTHOUSE_CHROME_FLAGS;
  if (extra) {
    for (const f of extra.split(/\s+/)) {
      if (f) flags.push(f);
    }
  }
  return flags;
}

async function runAuditInternal(args: RunAuditArgs) {
  // SSRF protection: validate the URL before launching Chrome
  await validateUrl(args.url);

  // Ensure temp directory exists and is writable (fixes #19 - Windows EPERM)
  // On Windows, os.tmpdir() reads TEMP -> TMP -> USERPROFILE, so we verify
  // the resolved path is usable before launching Chrome.
  const tmpDir = os.tmpdir();
  try {
    fs.accessSync(tmpDir, fs.constants.W_OK);
  } catch {
    // If the default temp dir isn't writable, create a fallback in the user's home
    const fallbackTmp = path.join(os.homedir(), '.lighthouse-tmp');
    if (!fs.existsSync(fallbackTmp)) {
      fs.mkdirSync(fallbackTmp, { recursive: true });
    }
    process.env.TEMP = fallbackTmp;
    process.env.TMP = fallbackTmp;
    process.env.TMPDIR = fallbackTmp;
  }

  const launchOptions: chromeLauncher.LaunchOptions = {
    chromeFlags: resolveChromeFlags(),
    // Explicitly pass process.env so MCP-configured env vars (TEMP, TMP, TMPDIR)
    // propagate to the Chrome child process on all platforms.
    envVars: process.env as Record<string, string>,
  };
  // Allow pinning the Chrome/Chromium binary (containers set CHROME_PATH).
  if (process.env.CHROME_PATH) {
    launchOptions.chromePath = process.env.CHROME_PATH;
  }

  const chrome = await chromeLauncher.launch(launchOptions);

  try {
    const options: any = {
      logLevel: 'error' as const,
      output: 'json',
      onlyCategories: args.categories,
      port: chrome.port,
      formFactor: args.device || 'mobile',
      screenEmulation: {
        mobile: args.device !== 'desktop',
        width: args.device === 'desktop' ? 1350 : 360,
        height: args.device === 'desktop' ? 940 : 640,
        deviceScaleFactor: 1,
        disabled: false,
      },
      throttling: args.throttling !== false ? {
        rttMs: 150,
        throughputKbps: 1638.4,
        cpuSlowdownMultiplier: 4,
      } : {
        rttMs: 0,
        throughputKbps: 10 * 1024,
        cpuSlowdownMultiplier: 1,
      },
    };

    const runnerResult = await lighthouse(args.url, options) as LighthouseResult;

    if (!runnerResult) {
      throw new McpError(
        ErrorCode.InternalError,
        'Failed to run Lighthouse audit'
      );
    }

    const { lhr } = runnerResult;

    // Format the results
    const formattedResults = {
      url: lhr.finalDisplayedUrl,
      fetchTime: lhr.fetchTime,
      version: lhr.lighthouseVersion,
      userAgent: lhr.userAgent,
      scores: {} as Record<string, any>,
      metrics: {} as Record<string, any>,
    };

    // Add category scores
    const scores: Record<string, any> = {};
    for (const [key, category] of Object.entries(lhr.categories as Record<string, any>)) {
      scores[key] = {
        title: category.title,
        score: category.score,
        description: category.description,
      };
    }
    formattedResults.scores = scores;

    // Add key metrics
    const metrics: Record<string, any> = {};
    if (lhr.audits) {
      const keyMetrics = [
        'first-contentful-paint',
        'largest-contentful-paint',
        'total-blocking-time',
        'cumulative-layout-shift',
        'speed-index',
        'interactive',
      ];

      for (const metric of keyMetrics) {
        const audit = (lhr.audits as Record<string, any>)[metric];
        if (audit) {
          metrics[metric] = {
            title: audit.title,
            value: audit.numericValue,
            displayValue: audit.displayValue,
            score: audit.score,
          };
        }
      }
    }
    formattedResults.metrics = metrics;

    return formattedResults;
  } finally {
    await chrome.kill();
  }
}

async function handleRunAudit(args: any) {
  if (!isValidAuditArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid audit arguments');
  }

  try {
    const formattedResults = await runAuditInternal(args);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(formattedResults, null, 2),
        },
      ],
    };
  } catch (error: any) {
    if (error instanceof McpError) throw error;
    console.error('Lighthouse error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error running Lighthouse audit: ${error.message || error}`,
        },
      ],
      isError: true,
    };
  }
}

async function handleGetPerformanceScore(args: any) {
  if (!isValidAuditArgs(args)) {
    throw new McpError(ErrorCode.InvalidParams, 'Invalid performance score arguments');
  }

  try {
    const resultData = await runAuditInternal({
      url: args.url,
      categories: ['performance'],
      device: args.device || 'mobile',
      throttling: true,
    });

    const performanceData = {
      url: resultData.url,
      performanceScore: resultData.scores.performance?.score,
      metrics: resultData.metrics,
    };

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(performanceData, null, 2),
        },
      ],
    };
  } catch (error: any) {
    if (error instanceof McpError) throw error;
    console.error('Performance score error:', error);
    return {
      content: [
        {
          type: 'text',
          text: `Error getting performance score: ${error.message || error}`,
        },
      ],
      isError: true,
    };
  }
}

const TOOLS = [
  {
    name: 'run_audit',
    description: 'Run a Lighthouse audit on a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to audit' },
        categories: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['performance', 'accessibility', 'best-practices', 'seo', 'pwa'],
          },
          description: 'Categories to audit (defaults to all)',
        },
        device: {
          type: 'string',
          enum: ['mobile', 'desktop'],
          description: 'Device to emulate (defaults to mobile)',
        },
        throttling: {
          type: 'boolean',
          description: 'Whether to apply network throttling (defaults to true)',
        },
      },
      required: ['url'],
    },
  },
  {
    name: 'get_performance_score',
    description: 'Get just the performance score for a URL',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to audit' },
        device: {
          type: 'string',
          enum: ['mobile', 'desktop'],
          description: 'Device to emulate (defaults to mobile)',
        },
      },
      required: ['url'],
    },
  },
];

/**
 * Build a fully-configured Lighthouse MCP Server. Transport-agnostic: connect
 * it to a StdioServerTransport (local) or a StreamableHTTPServerTransport
 * (remote / container) via the caller.
 */
export function createLighthouseServer(): Server {
  const server = new Server(
    {
      name: 'lighthouse-mcp',
      version: '0.1.15',
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
    switch (request.params.name) {
      case 'run_audit':
        return handleRunAudit(request.params.arguments);
      case 'get_performance_score':
        return handleGetPerformanceScore(request.params.arguments);
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`);
    }
  });

  server.onerror = (error: Error) => console.error('[MCP Error]', error);

  return server;
}
