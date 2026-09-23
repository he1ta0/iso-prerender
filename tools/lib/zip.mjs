// Minimal, dependency-free ZIP writer (deflate via node:zlib, store fallback).
// Only what the backup/snapshot tool needs: no zip64, no encryption, no streaming.
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

export function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** DOS date/time pair for a JS Date */
function dosTime(d) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() / 2) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

/** Files already compressed (png/mp4/jpg/zip) are stored, everything else deflated. */
const STORE_EXT = /\.(png|jpe?g|gif|webp|mp4|zip|gz|woff2?|7z|wav)$/i;

export class ZipWriter {
  constructor() { this.parts = []; this.central = []; this.offset = 0; this.entries = 0; }
  /** @param name path inside the archive (forward slashes) */
  add(name, data, mtime = new Date()) {
    if (typeof data === 'string') data = Buffer.from(data, 'utf8');
    else if (!Buffer.isBuffer(data)) data = Buffer.from(data);
    const crc = crc32(data);
    let method = 8;
    let body = zlib.deflateRawSync(data, { level: 9 });
    if (STORE_EXT.test(name) || body.length >= data.length) { method = 0; body = data; }
    const { time, date } = dosTime(mtime);
    const nameBuf = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    this.parts.push(local, nameBuf, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(this.offset, 42);
    this.central.push(cd, nameBuf);
    this.offset += local.length + nameBuf.length + body.length;
    this.entries++;
    return { stored: data.length, packed: body.length, method };
  }
  finish() {
    const cdOffset = this.offset;
    const cd = Buffer.concat(this.central);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(this.entries, 8);
    eocd.writeUInt16LE(this.entries, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);
    return Buffer.concat([...this.parts, cd, eocd]);
  }
}
