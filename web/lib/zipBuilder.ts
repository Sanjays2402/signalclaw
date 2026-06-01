// Minimal ZIP builder, stored entries only (no compression), Node-only.
//
// Procurement reality: the SOC2 evidence pack endpoint needs to return a
// real .zip file an auditor can open in Finder/Explorer without us shipping
// a third-party dep. ZIP "stored" format is short enough to inline; we
// stamp every entry with the same UTC timestamp so two evidence packs
// produced from identical inputs are byte-identical (helps with
// reproducibility evidence). CRC-32 is the IEEE 802.3 polynomial,
// computed with a precomputed table.
//
// Limits: file names are UTF-8 (we set the language-encoding flag bit 11),
// max entry size 4 GiB (we never write Zip64), deterministic mtime of
// 1980-01-01 by default. Intended for small text/JSON bundles, not large
// binary archives.
import { Buffer } from "node:buffer";

export type ZipEntry = {
  name: string;
  data: Buffer | string;
};

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

// DOS time/date for 1980-01-01 00:00:00. Deterministic across runs.
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // year=0 (1980), month=1, day=1

export function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, "utf8");
    const dataBuf = typeof e.data === "string" ? Buffer.from(e.data, "utf8") : e.data;
    const crc = crc32(dataBuf);
    const size = dataBuf.length;

    // Local file header: 30 bytes + name
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // signature
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 name
    local.writeUInt16LE(0, 8);           // method: stored
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);       // compressed size
    local.writeUInt32LE(size, 22);       // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);          // extra length

    localParts.push(local, nameBuf, dataBuf);

    // Central directory entry: 46 bytes + name
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);   // version made by
    central.writeUInt16LE(20, 6);   // version needed
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);   // method: stored
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);   // extra
    central.writeUInt16LE(0, 32);   // comment
    central.writeUInt16LE(0, 34);   // disk
    central.writeUInt16LE(0, 36);   // internal attrs
    central.writeUInt32LE(0, 38);   // external attrs
    central.writeUInt32LE(offset, 42);

    centralParts.push(central, nameBuf);

    offset += local.length + nameBuf.length + dataBuf.length;
  }

  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const centralSize = centralBuf.length;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);   // disk
  end.writeUInt16LE(0, 6);   // disk with central
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralStart, 16);
  end.writeUInt16LE(0, 20);  // comment

  return Buffer.concat([...localParts, centralBuf, end]);
}
