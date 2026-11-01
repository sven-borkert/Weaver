/** Header-only dimensions; unknown or malformed formats are never decoded. */
export function imageDimensions(
  input: Uint8Array,
): { width: number; height: number } | null {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const dimensions = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : null;
  if (
    bytes.length >= 24 &&
    bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    bytes.toString("ascii", 12, 16) === "IHDR"
  )
    return dimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) return null;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xda || marker === 0xd9) return null;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) return null;
      const length = bytes.readUInt16BE(offset);
      if (length < 2 || offset + length > bytes.length) return null;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker)
      )
        return length >= 7
          ? dimensions(
              bytes.readUInt16BE(offset + 5),
              bytes.readUInt16BE(offset + 3),
            )
          : null;
      offset += length;
    }
  }
  if (
    bytes.length >= 30 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  ) {
    let result: { width: number; height: number } | null = null;
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const kind = bytes.toString("ascii", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      if (start + size > bytes.length) return null;
      let found: { width: number; height: number } | null = null;
      if (kind === "VP8X" && size >= 10) {
        if (bytes[start]! & 2) return null;
        found = dimensions(
          1 + bytes.readUIntLE(start + 4, 3),
          1 + bytes.readUIntLE(start + 7, 3),
        );
      } else if (
        kind === "VP8 " &&
        size >= 10 &&
        bytes
          .subarray(start + 3, start + 6)
          .equals(Buffer.from([0x9d, 0x01, 0x2a]))
      ) {
        found = dimensions(
          bytes.readUInt16LE(start + 6) & 0x3fff,
          bytes.readUInt16LE(start + 8) & 0x3fff,
        );
      } else if (kind === "VP8L" && size >= 5 && bytes[start] === 0x2f) {
        const bits = bytes.readUInt32LE(start + 1);
        found = dimensions((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
      }
      if (
        found &&
        (!result || found.width * found.height > result.width * result.height)
      )
        result = found;
      offset = start + size + (size % 2);
    }
    return result;
  }
  return null;
}
