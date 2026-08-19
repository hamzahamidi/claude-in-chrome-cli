#!/usr/bin/env node
// Tests lib/image-output.js directly.
//
// The interesting cases here are the destructive ones, and they are cheap to
// prove at this level and awkward at any other: that a result which is not
// really an image never touches the destination, and that nothing is left
// behind when it is refused. A truncated PNG on disk is worse than no PNG,
// because it looks like an answer.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  writeImageResult, decodeImagePart, imageParts, ImageOutputError,
} = require('../plugins/claude-in-chrome/lib/image-output.js');

let failures = 0;

function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) { failures++; }
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`);
}

/** Runs `fn` and returns the ImageOutputError message, or a marker. */
async function refusal(fn) {
  try {
    await fn();
    return '(no error raised)';
  } catch (failure) {
    if (!(failure instanceof ImageOutputError)) { return `(wrong type: ${failure.name})`; }
    return failure.message;
  }
}

// Whole files, one per format. Deliberately not a magic header with filler
// after it: that is what an interrupted transfer produces, so using it as the
// valid fixture would assert the opposite of the guarantee under test.
const fixtures = require('./fixtures/images.js');

const b64 = (buffer) => buffer.toString('base64');
const PNG_1x1 = b64(fixtures.PNG_1x1);
const JPEG = b64(fixtures.JPEG);
const GIF = b64(fixtures.GIF);
const WEBP = b64(fixtures.WEBP);

// RIFF, but a WAVE rather than a WEBP: the four bytes at offset 8 are the only
// thing separating them, which is exactly why they are checked.
const RIFF_WAVE = (() => {
  const payload = Buffer.concat([Buffer.from('WAVE', 'latin1'), Buffer.alloc(20, 5)]);
  const header = Buffer.alloc(8);
  Buffer.from('RIFF', 'latin1').copy(header, 0);
  header.writeUInt32LE(payload.length, 4);
  return b64(Buffer.concat([header, payload]));
})();

const image = (extra) => ({ type: 'image', ...extra });
const resultWith = (...content) => ({ content });

async function main() {
  // ---- what counts as an image ---------------------------------------------

  check('a real PNG decodes', decodeImagePart(image({ data: PNG_1x1 })).format.mime, 'image/png');
  check('JPEG magic is recognised', decodeImagePart(image({ data: JPEG })).format.mime, 'image/jpeg');
  check('GIF magic is recognised', decodeImagePart(image({ data: GIF })).format.mime, 'image/gif');
  check('WebP needs RIFF and WEBP together',
    decodeImagePart(image({ data: WEBP })).format.mime, 'image/webp');
  check('a RIFF container that is not WebP is refused',
    await refusal(() => decodeImagePart(image({ data: RIFF_WAVE }))),
    'the data does not begin with PNG, JPEG, GIF or WebP magic bytes, so it is not an image this can verify');

  check('an unlabelled part is judged on its bytes alone',
    decodeImagePart(image({ data: PNG_1x1 })).format.extension, '.png');
  check('a label that agrees is accepted',
    decodeImagePart(image({ data: PNG_1x1, mimeType: 'image/png' })).format.mime, 'image/png');
  check('a label with parameters still agrees',
    decodeImagePart(image({ data: PNG_1x1, mimeType: 'image/png; charset=binary' })).format.mime, 'image/png');
  check('a label that contradicts the bytes is refused',
    await refusal(() => decodeImagePart(image({ data: JPEG, mimeType: 'image/png' }))),
    'the part says image/png but the bytes are image/jpeg');
  // An unknown label is not evidence of anything, so the bytes win rather than
  // the write being refused for a mimeType this does not know.
  check('an unknown label defers to the bytes',
    decodeImagePart(image({ data: PNG_1x1, mimeType: 'image/avif' })).format.mime, 'image/png');

  check('a missing data field is refused',
    await refusal(() => decodeImagePart(image({ mimeType: 'image/png' }))),
    'the image part carries no data');
  check('an empty data field is refused',
    await refusal(() => decodeImagePart(image({ data: '' }))), 'the image part carries no data');
  check('data that is not base64 is refused',
    await refusal(() => decodeImagePart(image({ data: 'not base64 at all!!' }))),
    'the image data is not valid base64, so it is incomplete or corrupted');

  // Node's base64 decoder accepts a truncated tail and silently returns short
  // bytes, which is what a cut-off transfer looks like. Catching it needs the
  // encoding checked before it is decoded, not after.
  check('base64 whose length is not a multiple of four is refused',
    await refusal(() => decodeImagePart(image({ data: PNG_1x1.slice(0, 41) }))),
    'the image data is not valid base64, so it is incomplete or corrupted');
  check('and Node itself would have accepted that same string',
    Buffer.from(PNG_1x1.slice(0, 41), 'base64').length > 0, true);

  // ---- and completeness, which none of the above establishes ---------------
  //
  // Every check so far passes for a truncated image. The base64 can be valid,
  // its length can divide by four and the signature can be intact while most of
  // the file is missing, and the first version of this module accepted exactly
  // that and wrote it over the destination.
  {
    const cut40 = PNG_1x1.slice(0, 40);
    check('a 40-character prefix is still syntactically valid base64',
      cut40.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(cut40), true);
    check('and still decodes to bytes carrying the PNG signature',
      Buffer.from(cut40, 'base64').subarray(0, 8).equals(fixtures.PNG_1x1.subarray(0, 8)), true);
    check('but it is refused, because it never reaches IEND',
      await refusal(() => decodeImagePart(image({ data: cut40 }))),
      'the image/png data is incomplete: it starts correctly but does not reach the end of the format');
  }

  // The harder shape, and the realistic one: bytes lost in transfer and then
  // encoded correctly, so nothing about the encoding is suspicious.
  check('an image cut short and then encoded properly is refused',
    await refusal(() => decodeImagePart(image({ data: b64(fixtures.cut(fixtures.PNG_1x1, 12)) }))),
    'the image/png data is incomplete: it starts correctly but does not reach the end of the format');
  check('a JPEG missing its end-of-image marker is refused',
    await refusal(() => decodeImagePart(image({ data: b64(fixtures.cut(fixtures.JPEG, 2)) }))),
    'the image/jpeg data is incomplete: it starts correctly but does not reach the end of the format');
  check('a GIF missing its trailer is refused',
    await refusal(() => decodeImagePart(image({ data: b64(fixtures.cut(fixtures.GIF, 1)) }))),
    'the image/gif data is incomplete: it starts correctly but does not reach the end of the format');

  // PNG completeness follows the chunk lengths rather than looking at the tail,
  // so a final chunk claiming more data than arrived fails even though the last
  // bytes might spell something plausible.
  {
    const lying = Buffer.from(fixtures.PNG_1x1);
    lying.writeUInt32BE(9999, 8);
    check('a PNG whose chunk length overruns the buffer is refused',
      await refusal(() => decodeImagePart(image({ data: b64(lying) }))),
      'the image/png data is incomplete: it starts correctly but does not reach the end of the format');
  }

  // RIFF states its own payload size, which is the cheapest completeness check
  // of the four and the only one that can catch trailing loss exactly.
  {
    const lying = Buffer.from(fixtures.WEBP);
    lying.writeUInt32LE(lying.length + 100, 4);
    check('a WebP whose declared size exceeds what arrived is refused',
      await refusal(() => decodeImagePart(image({ data: b64(lying) }))),
      'the image/webp data is incomplete: it starts correctly but does not reach the end of the format');
  }
  {
    const lying = Buffer.from(fixtures.WEBP);
    lying.writeUInt32LE(4, 4);
    check('and so is one that declares less', await refusal(() => decodeImagePart(image({ data: b64(lying) }))),
      'the image/webp data is incomplete: it starts correctly but does not reach the end of the format');
  }

  check('valid base64 that is not an image is refused',
    await refusal(() => decodeImagePart(image({ data: Buffer.alloc(40, 3).toString('base64') }))),
    'the data does not begin with PNG, JPEG, GIF or WebP magic bytes, so it is not an image this can verify');

  check('whitespace inside the base64 is tolerated',
    decodeImagePart(image({ data: `${PNG_1x1.slice(0, 20)}\n  ${PNG_1x1.slice(20)}` })).format.mime, 'image/png');

  // ---- finding the image in a result ---------------------------------------

  check('image parts are picked out of mixed content',
    imageParts(resultWith({ type: 'text', text: 'hi' }, image({ data: PNG_1x1 }))).length, 1);
  check('a result with no content has no images', imageParts({}).length, 0);

  // ---- writing ------------------------------------------------------------

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cic-image-'));
  const leftovers = () => fs.readdirSync(dir).filter((name) => name.startsWith('.cic-'));

  {
    const destination = path.join(dir, 'shot.png');
    const written = await writeImageResult(resultWith(image({ data: PNG_1x1 })), destination);
    check('a written file reports its size', written.bytes, Buffer.from(PNG_1x1, 'base64').length);
    check('and its format', written.mime, 'image/png');
    check('the bytes on disk are the bytes that came in',
      fs.readFileSync(destination).equals(Buffer.from(PNG_1x1, 'base64')), true);
    check('no temporary file is left behind', leftovers().length, 0);
  }

  {
    const destination = path.join(dir, 'text-only.png');
    const message = await refusal(() => writeImageResult(resultWith({ type: 'text', text: 'nothing' }), destination));
    check('a result with no image is refused', message,
      'the result carries no image, so there is nothing to write');
    check('and no file is created', fs.existsSync(destination), false);
  }

  {
    const destination = path.join(dir, 'two.png');
    const message = await refusal(() => writeImageResult(
      resultWith(image({ data: PNG_1x1 }), image({ data: PNG_1x1 })), destination));
    check('two images and one destination is refused rather than guessed', message,
      'the result carries 2 images and only one destination was given');
    check('and no file is created', fs.existsSync(destination), false);
  }

  // The case this module exists for: a destination that already holds something
  // must survive a result that turns out not to be an image.
  {
    const destination = path.join(dir, 'precious.png');
    fs.writeFileSync(destination, 'a file that matters');
    // The truncation that used to get through: cleanly encoded, right header,
    // no end. This is the case the whole atomic-write path exists for.
    await refusal(() => writeImageResult(
      resultWith(image({ data: b64(fixtures.cut(fixtures.PNG_1x1, 12)) })), destination));
    check('an existing file is untouched when the image is truncated',
      fs.readFileSync(destination, 'utf8'), 'a file that matters');
    await refusal(() => writeImageResult(resultWith(image({ data: PNG_1x1.slice(0, 41) })), destination));
    check('and untouched when the base64 itself is cut off',
      fs.readFileSync(destination, 'utf8'), 'a file that matters');
    await refusal(() => writeImageResult(resultWith({ type: 'text', text: 'no' }), destination));
    check('and untouched when there is no image at all',
      fs.readFileSync(destination, 'utf8'), 'a file that matters');
    check('with no temporary files accumulating', leftovers().length, 0);
  }

  {
    const destination = path.join(dir, 'replaced.png');
    fs.writeFileSync(destination, 'old contents');
    await writeImageResult(resultWith(image({ data: PNG_1x1 })), destination);
    check('a good image does replace an existing file',
      fs.readFileSync(destination).equals(Buffer.from(PNG_1x1, 'base64')), true);
  }

  {
    const destination = path.join(dir, 'no-such-directory', 'shot.png');
    const message = await refusal(() => writeImageResult(resultWith(image({ data: PNG_1x1 })), destination));
    check('a destination whose directory does not exist is reported, not created',
      message.startsWith('could not write'), true);
    check('and nothing is left in the parent', leftovers().length, 0);
  }

  fs.rmSync(dir, { recursive: true, force: true });

  console.log(failures ? `\n${failures} failed` : '\nall passed');
  process.exit(failures ? 1 : 0);
}

main().catch((failure) => {
  console.log('FAIL  the suite itself threw:', failure && failure.stack);
  process.exit(1);
});
