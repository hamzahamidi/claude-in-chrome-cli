// Writing an image out of a tool result to a file.
//
// Until now a non-text content part printed as `[image]` and the bytes were
// unreachable from the shell, which made a screenshot the one thing the CLI
// could ask for and not deliver. This owns the part nobody wants to get wrong:
// deciding whether what came back is really an image, and never damaging an
// existing file on the way to finding out it was not.
//
// It looks for `type: 'image'` and knows nothing about which tool produced it,
// so `cic call` keeps owning no schema and this works for any tool that returns
// an image rather than for screenshots specifically.
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Magic bytes per format. A declared mimeType is a claim by the sender; these
 * are the bytes themselves, so a disagreement between the two means something
 * is wrong and the write is refused rather than guessed at.
 */
const FORMATS = [
  { mime: 'image/png', extension: '.png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/jpeg', extension: '.jpg', magic: [0xff, 0xd8, 0xff] },
  { mime: 'image/gif', extension: '.gif', magic: [0x47, 0x49, 0x46, 0x38] },
  // RIFF....WEBP: the four size bytes in between are not fixed, so this one is
  // checked in two pieces.
  { mime: 'image/webp', extension: '.webp', magic: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];

/** Raised for anything that should stop the write before a file is touched. */
class ImageOutputError extends Error {}

const imageParts = (result) => (result && result.content ? result.content : [])
  .filter((part) => part && part.type === 'image');

const startsWith = (buffer, bytes, offset = 0) => bytes.every((byte, i) => buffer[offset + i] === byte);

function formatOf(buffer) {
  return FORMATS.find((format) => startsWith(buffer, format.magic)
    && (!format.at8 || startsWith(buffer, format.at8, 8))) || null;
}

/**
 * Turns one image part into bytes, or explains why it will not.
 *
 * Base64 decoding in Node is lenient: it skips characters it does not
 * recognize and accepts a truncated tail, so a partial or corrupted transfer
 * decodes happily into short bytes rather than failing. That is exactly the
 * case worth catching here, so the encoding is checked before it is decoded.
 */
function decodeImagePart(part) {
  if (typeof part.data !== 'string' || part.data === '') {
    throw new ImageOutputError('the image part carries no data');
  }
  const encoded = part.data.replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new ImageOutputError('the image data is not valid base64, so it is incomplete or corrupted');
  }
  const buffer = Buffer.from(encoded, 'base64');
  if (buffer.length === 0) {
    throw new ImageOutputError('the image data decoded to nothing');
  }

  const format = formatOf(buffer);
  if (!format) {
    throw new ImageOutputError(
      'the data does not begin with PNG, JPEG, GIF or WebP magic bytes, so it is not an image this can verify');
  }
  // A sender that labels its own bytes wrongly is reporting something broken
  // upstream; writing the file anyway would hide it behind a plausible name.
  if (typeof part.mimeType === 'string' && part.mimeType !== '') {
    const declared = part.mimeType.toLowerCase().split(';')[0].trim();
    const known = FORMATS.some((f) => f.mime === declared);
    if (known && declared !== format.mime) {
      throw new ImageOutputError(
        `the part says ${declared} but the bytes are ${format.mime}`);
    }
  }
  return { buffer, format };
}

/**
 * Writes bytes to `destination` without ever leaving it partly written.
 *
 * The temporary file is created in the destination's own directory so the
 * rename stays inside one filesystem, where it is atomic: a reader sees either
 * the old file or the whole new one. Writing in place would leave a truncated
 * image behind if anything failed halfway, and a truncated PNG is worse than
 * no PNG because it looks like a result.
 */
async function writeAtomically(destination, buffer) {
  const directory = path.dirname(path.resolve(destination));
  const temporary = path.join(directory, `.cic-${process.pid}-${Date.now()}.part`);
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx');
    await handle.writeFile(buffer);
    // Flushed before the rename, so a crash cannot publish a name that points
    // at bytes the kernel had not written yet.
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporary, destination);
  } catch (failure) {
    if (handle) { try { await handle.close(); } catch { /* already gone */ } }
    try { await fs.promises.unlink(temporary); } catch { /* never created */ }
    throw new ImageOutputError(`could not write ${destination}: ${failure.message}`);
  }
}

/**
 * Writes the one image in `result` to `destination`.
 *
 * Refuses on zero images and on more than one, rather than picking. A caller
 * that asked for a file and got none, or got the second of two without being
 * told, would have no way to notice from the exit code alone.
 */
async function writeImageResult(result, destination) {
  const parts = imageParts(result);
  if (parts.length === 0) {
    throw new ImageOutputError('the result carries no image, so there is nothing to write');
  }
  if (parts.length > 1) {
    throw new ImageOutputError(
      `the result carries ${parts.length} images and only one destination was given`);
  }
  const { buffer, format } = decodeImagePart(parts[0]);
  await writeAtomically(destination, buffer);
  return { bytes: buffer.length, mime: format.mime, extension: format.extension };
}

module.exports = { writeImageResult, decodeImagePart, imageParts, ImageOutputError, FORMATS };
