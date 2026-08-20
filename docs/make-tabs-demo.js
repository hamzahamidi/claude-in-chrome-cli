#!/usr/bin/env node
// Renders docs/cic-tabs-demo.svg and .png: the still that opens the README,
// showing `cic tabs`. Needs rsvg-convert on PATH (brew install librsvg).
//
// Build tooling for a documentation asset, run by hand and deliberately not
// tested: it ships in neither the npm tarball nor the plugin, and coverage only
// measures plugins/claude-in-chrome. Its output is checked by looking at it.
//
// The line shapes are the real ones `render()` in lib/session-tabs.js emits: the
// count header, the snapshot caveat, the `## profile` header, the `hosts:` line
// and the `  [w<id>] title :: url` rows, with URLs redacted the way `cic tabs`
// redacts them by default. The tabs themselves are stand-ins. The maintainer's
// real tabs are not publishable, and the totals are the ones the README already
// reports measuring: 29 tabs on disk, 4 of them visible to the extension's
// bridge. The last line is an elision, drawn dim and italic rather than left
// silent, because `cic tabs` prints no such summary of its own.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SVG_OUT = path.join(__dirname, 'cic-tabs-demo.svg');
const PNG_OUT = path.join(__dirname, 'cic-tabs-demo.png');
const SCALE = 2;
const W = 900;
const COLS = { bg: '#16130f', chrome: '#221d18', dim: '#8b8178', text: '#e6e1db', prompt: '#7cc379', accent: '#da7756' };
const CHAR = 8.1;
const LINE = 21;
const TOP = 58;
const LEFT = 22;

const LINES = [
  { kind: 'command', text: 'cic tabs' },
  { kind: 'output', text: '29 open tab(s) across 3 profile(s), read from disk.' },
  { kind: 'output', text: 'This is a snapshot Chrome writes periodically, so it can lag by a little.' },
  { kind: 'blank' },
  { kind: 'header', text: '## profile Default (21 tabs, 2 window(s), Sessions/Session_13411612)' },
  { kind: 'output', text: 'hosts: github.com (7), app.notion.com (5), example.com (3), localhost (2)' },
  { kind: 'tab', win: 'w1', title: 'Example Domain', url: 'https://example.com/' },
  { kind: 'tab', win: 'w1', title: 'hamzahamidi/claude-in-chrome-cli', url: 'https://github.com/hamzahamidi/claude-in-chrome-cli' },
  { kind: 'tab', win: 'w2', title: 'Specification - Model Context Protocol', url: 'https://modelcontextprotocol.io/specification' },
  { kind: 'elided', text: '26 more tabs across 3 profiles. The extension’s bridge can see 4 of them.' },
];

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const at = (chars) => LEFT + chars * CHAR;

const HEIGHT = TOP + LINES.length * LINE + 12;
const parts = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HEIGHT}" viewBox="0 0 ${W} ${HEIGHT}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13.5">`,
  `<rect width="${W}" height="${HEIGHT}" rx="10" fill="${COLS.bg}"/>`,
  `<path d="M0 10a10 10 0 0 1 10-10h${W - 20}a10 10 0 0 1 10 10v26H0z" fill="${COLS.chrome}"/>`,
  `<circle cx="20" cy="18" r="5.5" fill="#ff5f57"/>`,
  `<circle cx="39" cy="18" r="5.5" fill="#febc2e"/>`,
  `<circle cx="58" cy="18" r="5.5" fill="#28c840"/>`,
  `<text x="${W / 2}" y="23" fill="${COLS.dim}" text-anchor="middle" font-size="12">claude-in-chrome-cli</text>`,
];

LINES.forEach((line, i) => {
  const y = TOP + i * LINE;
  if (line.kind === 'command') {
    parts.push(`<text x="${LEFT}" y="${y}" fill="${COLS.prompt}">$</text>`);
    parts.push(`<text x="${at(2)}" y="${y}" fill="${COLS.text}">${escape(line.text)}</text>`);
  } else if (line.kind === 'header') {
    parts.push(`<text x="${LEFT}" y="${y}" fill="${COLS.accent}">${escape(line.text)}</text>`);
  } else if (line.kind === 'tab') {
    const label = `[${line.win}] ${line.title} `;
    parts.push(`<text x="${at(2)}" y="${y}" fill="${COLS.text}">${escape(label)}</text>`);
    parts.push(`<text x="${at(2 + label.length)}" y="${y}" fill="${COLS.dim}">:: ${escape(line.url)}</text>`);
  } else if (line.kind === 'elided') {
    parts.push(`<text x="${LEFT}" y="${y}" fill="${COLS.dim}" font-style="italic">&#8230; ${escape(line.text)}</text>`);
  } else if (line.kind === 'output') {
    parts.push(`<text x="${LEFT}" y="${y}" fill="${COLS.dim}">${escape(line.text)}</text>`);
  }
});
parts.push('</svg>');

fs.writeFileSync(SVG_OUT, parts.join('\n') + '\n');
execFileSync('rsvg-convert', ['-z', String(SCALE), '-o', PNG_OUT, SVG_OUT]);

const widest = Math.max(...LINES.map((l) => (l.kind === 'tab' ? `  [${l.win}] ${l.title} :: ${l.url}` : `  ${l.text || ''}`).length));
const kb = Math.round(fs.statSync(PNG_OUT).size / 1024);
console.log(`${path.relative(process.cwd(), PNG_OUT)}: ${kb} KB, ${W * SCALE}x${HEIGHT * SCALE}, widest line ${widest} chars (${Math.round(at(widest))}px of ${W})`);
