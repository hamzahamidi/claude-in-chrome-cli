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

// A real 1x1 PNG, not a signature with filler, so the happy path is a file an
// image viewer would actually open.
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
const withMagic = (bytes, size = 64) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(size, 9)]).toString('base64');
const JPEG = withMagic([0xff, 0xd8, 0xff, 0xe0]);
const GIF = withMagic([0x47, 0x49, 0x46, 0x38]);
// RIFF then WEBP at offset 8, with four size bytes in between.
const WEBP = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.from([1, 2, 3, 4]),
  Buffer.from([0x57, 0x45, 0x42, 0x50]), Buffer.alloc(40, 5),
]).toString('base64');
// RIFF, but a WAVE rather than a WEBP: the four bytes at offset 8 are the only
// thing separating them, which is exactly why they are checked.
const RIFF_WAVE = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]), Buffer.from([1, 2, 3, 4]),
  Buffer.from([0x57, 0x41, 0x56, 0x45]), Buffer.alloc(40, 5),
]).toString('base64');

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
    await refusal(() => writeImageResult(resultWith(image({ data: PNG_1x1.slice(0, 41) })), destination));
    check('an existing file is untouched when the image is truncated',
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
