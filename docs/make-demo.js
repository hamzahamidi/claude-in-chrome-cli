#!/usr/bin/env node
// Renders docs/cic-demo-session.webp: an animated terminal showing one `cic
// shell` session. Needs rsvg-convert and img2webp on PATH (brew install librsvg
// webp) and writes its frames to a temporary directory.
//
// Build tooling for a documentation asset, run by hand and deliberately not
// tested: it ships in neither the npm tarball nor the plugin, and coverage only
// measures plugins/claude-in-chrome. Its output is checked by looking at it.
//
// The transcript below is a real session, captured by driving `cic shell`
// through a pty so the recorded order is the interactive one. Two things are
// changed from the capture and nothing else: each reply's tab context is elided,
// because the extension appends every open tab's title and URL to every reply
// and those were the maintainer's real tabs, and the extension's browser_batch
// reminder is elided with it. Elisions are drawn, not silent.
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(__dirname, 'cic-demo-session.webp');
const SCALE = 2;
const W = 940;
const COLS = { bg: '#16130f', chrome: '#221d18', dim: '#8b8178', text: '#e6e1db', prompt: '#7cc379', accent: '#da7756' };
const CHAR = 8.1;
const LINE = 21;
const TOP = 58;
const LEFT = 22;

// A step is either a typed command or the reply it produced. `elided` lines are
// rendered dim and italic so a reader can tell output was left out on purpose.
const TRANSCRIPT = [
  { reply: ['Connected. One line is: <tool> [json-args]. Ctrl-D or .exit to leave.'] },
  { type: 'tabs_create_mcp' },
  { reply: ['Created new tab. Tab ID: 2099040992'], elided: 'tab context and extension reminder elided' },
  { type: 'navigate {"url":"https://example.com","tabId":2099040992}' },
  { reply: ['Navigated to https://example.com'], elided: 'tab context and extension reminder elided' },
  { type: 'get_page_text {"tabId":2099040992}' },
  {
    reply: [
      'Title: Example Domain',
      'URL: https://example.com/',
      'Source element: <body>',
      '---',
      'Example Domain',
      '',
      'This domain is for use in documentation examples without needing',
      'permission. Avoid use in operations.',
      '',
      'Learn more',
    ],
    elided: 'tab context elided',
  },
  { type: 'tabs_close_mcp {"tabId":2099040992}' },
  { reply: ['Closed tab 2099040992. 5 tab(s) remain.'], elided: 'tab context elided' },
  { type: '.exit' },
];

const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** One rendered line: a kind for colour plus its text. */
const PROMPT = 'cic> ';

function svg(lines, height) {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="13.5">`,
    `<rect width="${W}" height="${height}" rx="10" fill="${COLS.bg}"/>`,
    `<path d="M0 10a10 10 0 0 1 10-10h${W - 20}a10 10 0 0 1 10 10v26H0z" fill="${COLS.chrome}"/>`,
    `<circle cx="20" cy="18" r="5.5" fill="#ff5f57"/>`,
    `<circle cx="39" cy="18" r="5.5" fill="#febc2e"/>`,
    `<circle cx="58" cy="18" r="5.5" fill="#28c840"/>`,
    `<text x="${W / 2}" y="23" fill="${COLS.dim}" text-anchor="middle" font-size="12">cic shell &#8212; one connection, four calls</text>`,
  ];
  lines.forEach((line, i) => {
    const y = TOP + i * LINE;
    if (line.kind === 'command') {
      parts.push(`<text x="${LEFT}" y="${y}" fill="${COLS.prompt}">${escape(PROMPT)}</text>`);
      parts.push(`<text x="${LEFT + PROMPT.length * CHAR}" y="${y}" fill="${COLS.text}">${escape(line.text)}${line.caret ? `<tspan fill="${COLS.accent}">&#9608;</tspan>` : ''}</text>`);
    } else if (line.kind === 'elided') {
      parts.push(`<text x="${LEFT}" y="${y}" fill="${COLS.dim}" font-style="italic">&#8230; ${escape(line.text)}</text>`);
    } else if (line.text !== '') {
      parts.push(`<text x="${LEFT}" y="${y}" fill="${COLS.dim}">${escape(line.text)}</text>`);
    }
  });
  parts.push('</svg>');
  return parts.join('\n');
}

/** Every line the finished transcript will contain, to size the window once. */
function allLines() {
  const out = [];
  for (const step of TRANSCRIPT) {
    if (step.type !== undefined) { out.push(1); }
    if (step.reply) { out.push(...step.reply.map(() => 1)); }
    if (step.elided) { out.push(1); }
  }
  return out.length;
}

const HEIGHT = TOP + allLines() * LINE + 12;

// Build the frames. Typing is revealed a few characters at a time; a reply
// arrives as one frame, held long enough to read.
const frames = [];
const shown = [];
const push = (durationMs) => frames.push({ lines: shown.map((l) => ({ ...l })), durationMs });

for (const step of TRANSCRIPT) {
  if (step.type !== undefined) {
    shown.push({ kind: 'command', text: '', caret: true });
    const last = shown.length - 1;
    for (let n = 0; n <= step.type.length; n += 4) {
      shown[last].text = step.type.slice(0, Math.min(n + 4, step.type.length));
      push(55);
    }
    shown[last].caret = false;
    push(450);
  }
  if (step.reply) {
    for (const text of step.reply) { shown.push({ kind: 'output', text }); }
    if (step.elided) { shown.push({ kind: 'elided', text: step.elided }); }
    push(step.reply.length > 3 ? 1900 : 1200);
  }
}
frames[frames.length - 1].durationMs = 3000;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cic-demo-'));
try {
  const pngs = frames.map((frame, i) => {
    const stem = path.join(dir, String(i).padStart(4, '0'));
    fs.writeFileSync(`${stem}.svg`, svg(frame.lines, HEIGHT));
    execFileSync('rsvg-convert', ['-z', String(SCALE), '-o', `${stem}.png`, `${stem}.svg`]);
    return `${stem}.png`;
  });

  const args = ['-loop', '0', '-lossless'];
  frames.forEach((frame, i) => { args.push('-d', String(frame.durationMs), pngs[i]); });
  args.push('-o', OUT);
  execFileSync('img2webp', args, { stdio: ['ignore', 'ignore', 'inherit'] });

  const kb = Math.round(fs.statSync(OUT).size / 1024);
  const seconds = (frames.reduce((sum, f) => sum + f.durationMs, 0) / 1000).toFixed(1);
  console.log(`${path.relative(process.cwd(), OUT)}: ${frames.length} frames, ${seconds}s, ${kb} KB, ${W * SCALE}x${HEIGHT * SCALE}`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
