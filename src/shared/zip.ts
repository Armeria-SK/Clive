import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';

export interface ZipLimits { maxEntries: number; maxTotal: number; maxEntry: number; maxRatio: number; ratioFloor: number; maxNameLength: number }
export const ZIP_LIMITS: ZipLimits = { maxEntries: 5_000, maxTotal: 64 * 1024 * 1024, maxEntry: 32 * 1024 * 1024, maxRatio: 200, ratioFloor: 1024 * 1024, maxNameLength: 1024 };

export type ZipFailure = 'not_zip' | 'encrypted' | 'unsupported' | 'damaged' | 'bad_name' | 'too_many' | 'too_large' | 'ratio' | 'crc';
export interface ZipEntry { name: string; method: 0 | 8; crc: number; compressedSize: number; size: number; offset: number }
export interface ZipArchive {
  readonly entries: ReadonlyMap<string, ZipEntry>;
  read(name: string): { ok: true; data: Buffer } | { ok: false; reason: ZipFailure | 'missing' };
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const LOCAL_SIZE = 30;
const CENTRAL_SIZE = 46;
const EOCD_SIZE = 22;
const EOCD_SEARCH = EOCD_SIZE + 0xffff;
const U16 = 0xffff;
const U32 = 0xffffffff;
const ENCRYPTED_FLAGS = 0x0001 | 0x0040 | 0x2000;
const UTF8_FLAG = 0x0800;
const DOS_DATE_1980_01_01 = 0x0021;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const LONE_SURROGATE = /\p{Cs}/u;
const DRIVE = /^[A-Za-z]:/;

const fail = (reason: ZipFailure): { ok: false; reason: ZipFailure } => ({ ok: false, reason });

export function zipNameProblem(name: string, maxLength: number): boolean {
  if (name.length === 0 || name.length > maxLength) return true;
  if (CONTROL.test(name) || LONE_SURROGATE.test(name)) return true;
  if (name.includes('\\') || name.startsWith('/') || DRIVE.test(name)) return true;
  const parts = name.split('/');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.some((part) => part === '' || part === '.' || part === '..');
}

function findEocd(buf: Buffer): number {
  const lowest = Math.max(0, buf.length - EOCD_SEARCH);
  for (let at = buf.length - EOCD_SIZE; at >= lowest; at--) {
    if (buf.readUInt32LE(at) === EOCD_SIG && at + EOCD_SIZE + buf.readUInt16LE(at + 20) <= buf.length) return at;
  }
  return -1;
}

export function openZip(bytes: Uint8Array, limits: Partial<ZipLimits> = {}): { ok: true; zip: ZipArchive } | { ok: false; reason: ZipFailure } {
  const lim: ZipLimits = { ...ZIP_LIMITS, ...limits };
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 4) return fail('not_zip');
  const head = buf.readUInt32LE(0);
  if (head !== LOCAL_SIG && head !== EOCD_SIG) return fail('not_zip');
  const eocd = findEocd(buf);
  if (eocd < 0) return fail('damaged');
  if (eocd >= 20 && buf.readUInt32LE(eocd - 20) === ZIP64_LOCATOR_SIG) return fail('unsupported');
  const disk = buf.readUInt16LE(eocd + 4);
  const centralDisk = buf.readUInt16LE(eocd + 6);
  const onDisk = buf.readUInt16LE(eocd + 8);
  const count = buf.readUInt16LE(eocd + 10);
  const centralSize = buf.readUInt32LE(eocd + 12);
  const centralOffset = buf.readUInt32LE(eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || onDisk !== count || count === U16 || centralSize === U32 || centralOffset === U32) return fail('unsupported');
  const centralEnd = centralOffset + centralSize;
  if (centralEnd > eocd) return fail('damaged');
  if (count > lim.maxEntries) return fail('too_many');
  if (count * CENTRAL_SIZE > centralSize) return fail('damaged');

  const entries = new Map<string, ZipEntry>();
  const seen = new Set<string>();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let at = centralOffset;
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_SIZE > centralEnd || buf.readUInt32LE(at) !== CENTRAL_SIG) return fail('damaged');
    const flags = buf.readUInt16LE(at + 8);
    const method = buf.readUInt16LE(at + 10);
    const crc = buf.readUInt32LE(at + 16);
    const compressedSize = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const next = at + CENTRAL_SIZE + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const diskStart = buf.readUInt16LE(at + 34);
    const offset = buf.readUInt32LE(at + 42);
    if (next > centralEnd) return fail('damaged');
    if ((flags & ENCRYPTED_FLAGS) !== 0) return fail('encrypted');
    if (method !== 0 && method !== 8) return fail('unsupported');
    if (diskStart !== 0 || compressedSize === U32 || size === U32 || offset === U32) return fail('unsupported');
    let name: string;
    try { name = decoder.decode(buf.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength)); } catch { return fail('bad_name'); }
    if (zipNameProblem(name, lim.maxNameLength) || seen.has(name)) return fail('bad_name');
    seen.add(name);
    if (size > lim.maxEntry) return fail('too_large');
    total += size;
    if (total > lim.maxTotal) return fail('too_large');
    if (method === 0 && compressedSize !== size) return fail('damaged');
    if (size > lim.ratioFloor && size / Math.max(compressedSize, 1) > lim.maxRatio) return fail('ratio');
    if (!name.endsWith('/')) entries.set(name, { name, method, crc, compressedSize, size, offset });
    at = next;
  }

  let budget = lim.maxTotal;
  const read: ZipArchive['read'] = (name) => {
    const entry = entries.get(name);
    if (!entry) return { ok: false, reason: 'missing' };
    if (entry.offset + LOCAL_SIZE > buf.length || buf.readUInt32LE(entry.offset) !== LOCAL_SIG) return fail('damaged');
    const start = entry.offset + LOCAL_SIZE + buf.readUInt16LE(entry.offset + 26) + buf.readUInt16LE(entry.offset + 28);
    const stop = start + entry.compressedSize;
    if (stop > buf.length) return fail('damaged');
    if (entry.size > budget) return fail('too_large');
    budget -= entry.size;
    const body = buf.subarray(start, stop);
    let data: Buffer;
    if (entry.method === 0) data = Buffer.from(body);
    else {
      try { data = inflateRawSync(body, { maxOutputLength: Math.max(entry.size, 1) }); }
      catch (error) { return fail((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE' ? 'ratio' : 'damaged'); }
    }
    if (data.length !== entry.size) return fail('damaged');
    if (crc32(data) !== entry.crc) return fail('crc');
    return { ok: true, data };
  };
  return { ok: true, zip: { entries, read } };
}

export function zipWrite(files: ReadonlyArray<{ name: string; data: Uint8Array }>): Buffer {
  if (files.length >= U16) throw new Error('zip: too many entries');
  const seen = new Set<string>();
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    if (zipNameProblem(file.name, ZIP_LIMITS.maxNameLength) || file.name.endsWith('/') || seen.has(file.name)) throw new Error(`zip: unusable name ${JSON.stringify(file.name)}`);
    seen.add(file.name);
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.data.buffer, file.data.byteOffset, file.data.byteLength);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    if (data.length >= U32 || packed.length >= U32 || offset >= U32) throw new Error('zip: archive too large');

    const local = Buffer.alloc(LOCAL_SIZE + name.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(DOS_DATE_1980_01_01, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    name.copy(local, LOCAL_SIZE);

    const central = Buffer.alloc(CENTRAL_SIZE + name.length);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(UTF8_FLAG, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(DOS_DATE_1980_01_01, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    name.copy(central, CENTRAL_SIZE);

    locals.push(local, packed);
    centrals.push(central);
    offset += local.length + packed.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (offset + centralSize >= U32) throw new Error('zip: archive too large');
  const eocd = Buffer.alloc(EOCD_SIZE);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}
