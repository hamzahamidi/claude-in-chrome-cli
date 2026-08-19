#!/usr/bin/env node
// Stdio MCP server exposing Chrome's open tabs, read from the profile on disk.
//
// The Claude in Chrome bridge can only see tabs inside its own tab group, and
// attaching a debugger needs the user to turn on remote debugging. Neither is
// required to answer "what is open": Chrome and Chromium write live session
// data below each profile, and readable files parse without a port or a group.
// Encrypted session storage is reported explicitly rather than decrypted.
//
// The reading itself lives in lib/session-tabs.js, which `cic tabs` also uses.
// This file is the MCP surface over it: the tool schema, and the stdio loop.
//
// No third-party dependencies. Read only: this never drives a page. Requires
// Node 22 or later.

'use strict';

const readline = require('readline');

const sessionTabs = require('./lib/session-tabs.js');

const { collect, render } = sessionTabs;

const SERVER_NAME = 'chrome-tabs';
const SERVER_VERSION = '0.7.0';
const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'list_open_tabs',
    description:
      'List the tabs recoverable from readable Chrome and Chromium session data, ' +
      'across every window and recognized profile on this machine. Needs no ' +
      'remote debugging port, no extension and no tab group, so it sees tabs the ' +
      "Claude in Chrome bridge cannot, and it is not limited to one profile. Use " +
      'it for any read-only question about what is open. It cannot drive a page, ' +
      'and it does not track which tab or window currently has focus, only which ' +
      'page each tab is on: for a tab whose history was pruned (not just navigated ' +
      'back and forth), the reported page can be stale. URLs are redacted by ' +
      'default to origin and path for known-safe schemes only, with credentials, ' +
      'query strings and fragments always stripped; an unrecognized or wrapper ' +
      "scheme (blob:, filesystem:, view-source:) shows only its scheme, since its " +
      'path can itself be another URL with credentials embedded. Pass full_urls ' +
      'to get the raw URL instead. This is a best-effort reader of an undocumented ' +
      'Chromium format. A file in an unconfirmed version, an encrypted profile, or ' +
      'an initial snapshot that never reached its completion marker is reported ' +
      'rather than treated as empty; a completed snapshot cut off during later ' +
      'incremental updates returns its recovered tabs with an incomplete warning.',
    inputSchema: {
      type: 'object',
      properties: {
        profile: {
          type: 'string',
          description: "Limit to one Chrome profile directory, e.g. 'Default'.",
        },
        include_urls: {
          type: 'boolean',
          default: true,
          description: 'Include a per-tab title and URL line. False returns only counts and hosts.',
        },
        full_urls: {
          type: 'boolean',
          default: false,
          description:
            'Return the raw URL instead of the redacted origin and path. Off by ' +
            'default because a raw URL can carry credentials, a query string or a ' +
            'session token.',
        },
      },
    },
  },
];

function handle(request) {
  const method = request.method;
  if (method === 'initialize') {
    return {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    };
  }
  if (method === 'tools/list') {
    return { tools: TOOLS };
  }
  if (method === 'tools/call') {
    const params = request.params || {};
    if (params.name !== 'list_open_tabs') {
      throw new Error(`unknown tool: ${params.name}`);
    }
    const args = params.arguments || {};
    const text = render(collect(args.profile), {
      includeUrls: args.include_urls !== false,
      fullUrls: args.full_urls === true,
    });
    return { content: [{ type: 'text', text }] };
  }
  throw new Error(`unknown method: ${method}`);
}

function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (raw) => {
    const line = raw.trim();
    if (!line) return;
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return;
    }
    if (!('id' in request)) return; // a notification, nothing to answer
    let response;
    try {
      response = { jsonrpc: '2.0', id: request.id, result: handle(request) };
    } catch (exc) {
      response = { jsonrpc: '2.0', id: request.id, error: { code: -32603, message: exc.message } };
    }
    process.stdout.write(JSON.stringify(response) + '\n');
  });
}

if (require.main === module) {
  main();
}
module.exports = {
  ...sessionTabs,
  handle,
  SERVER_VERSION,
};
