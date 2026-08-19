// Whole images, one per format the file output accepts.
//
// These are deliberately complete files rather than a magic header with filler
// after it. A header plus filler is precisely what a cut-off transfer produces,
// so using one as the "valid image" fixture asserted the opposite of the
// guarantee `--output` is for: the suite passed while a truncated PNG was being
// written over an existing file. Each of these ends where its format says it
// should, and each has a `cut` helper for making one that does not.
'use strict';

/**
 * A real 1x1 PNG: signature, IHDR, IDAT, IEND, 70 bytes. Chunk lengths are
 * consistent, so the completeness walk has something honest to walk.
 */
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64');

/**
 * A JPEG that starts at SOI, carries one APP0 segment and stops at EOI. Small,
 * but structurally terminated, which is the property under test.
 */
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8]),                                  // SOI
  Buffer.from([0xff, 0xe0, 0x00, 0x10]),                      // APP0, length 16
  Buffer.from('JFIF\0', 'latin1'),
  Buffer.from([0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]),
  Buffer.from([0xff, 0xd9]),                                  // EOI
]);

/** GIF89a header, a scrap of body, and the trailer byte that ends a GIF. */
const GIF = Buffer.concat([
  Buffer.from('GIF89a', 'latin1'),
  Buffer.from([0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]),
  Buffer.from([0x3b]),                                        // trailer
]);

/** A RIFF container whose declared size matches what is actually there. */
const WEBP = (() => {
  const payload = Buffer.concat([
    Buffer.from('WEBP', 'latin1'),
    Buffer.from('VP8 ', 'latin1'),
    Buffer.alloc(16, 0x11),
  ]);
  const header = Buffer.alloc(8);
  Buffer.from('RIFF', 'latin1').copy(header, 0);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
})();

/**
 * The same image with its tail removed and then encoded properly, which is what
 * an interrupted transfer actually looks like: valid base64, a length that
 * divides by four, an intact signature, and no end.
 */
const cut = (buffer, bytes = 12) => buffer.subarray(0, buffer.length - bytes);

module.exports = { PNG_1x1, JPEG, GIF, WEBP, cut };
