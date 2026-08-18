#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createLighthouseServer } from './server.js';

async function main() {
  const server = createLighthouseServer();

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Lighthouse MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting Lighthouse MCP server:', err);
  process.exit(1);
});
