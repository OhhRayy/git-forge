// git-core.ts — SHA-1, object encode/decode, packfile parse/generate,
// delta apply, reachability, shallow boundaries, fast-forward checks.
//
// Node 22 stdlib only (node:crypto, node:zlib). No Date.now()/Math.random().
// Pack parsing note: Node's zlib.inflateSync ignores trailing bytes but
// reports no consumed length, so the consumed length of each entry's zlib
// stream is found by binary search over the prefix length (smallest prefix
// that inflates to exactly the declared size). Verified empirically.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';
import { hashObject, sha1Hex, ZERO_OID } from './store.ts';
import type { GitObject, GitObjectType, Oid, Repo } from './store.ts';

export { hashObject, sha1Hex, ZERO_OID };
export type { GitObject, GitObjectType, Oid, Repo };

// ---------------------------------------------------------------------------
// pkt-line framing (PKT_LINE_MAX = 65520, payload max 65516)
// ---------------------------------------------------------------------------

export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = 65516;

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  /** Payload for data packets (without the 4-byte length header). */
  payload?: Buffer;
}

/** Encode one pkt-line (payload + 4-byte lowercase hex length). */
export function encodePktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pktline-too-long');
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function encodeFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function encodeDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export interface DecodedPktLines {
  packets: PktPacket[];
  /** Bytes consumed from the input buffer. */
  consumed: number;
  /** Set when the stream ends mid-packet (truncated input). */
  truncated: boolean;
  /** Set when a length header is malformed. */
  error?: string;
}

/**
 * Decode pkt-lines from the start of `buf`. Stops at the first flush,
 * delim, response-end, malformed header, or truncation, and reports how
 * many bytes were consumed — the caller owns any trailing bytes (e.g. the
 * raw unframed pack after a receive-pack flush).
 */
export function decodePktLines(buf: Buffer, maxPackets = 100000): DecodedPktLines {
  const packets: PktPacket[] = [];
  let off = 0;
  while (off < buf.length && packets.length < maxPackets) {
    if (off + 4 > buf.length) return { packets, consumed: off, truncated: true };
    const head = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) {
      return { packets, consumed: off, truncated: false, error: `invalid pkt-line length ${head}` };
    }
    const len = parseInt(head, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      return { packets, consumed: off + 4, truncated: false };
    }
    if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len === 3) {
      return { packets, consumed: off, truncated: false, error: 'invalid pkt-line length 0003' };
    }
    if (len > PKT_LINE_MAX) {
      return { packets, consumed: off, truncated: false, error: `pkt-line length ${len} exceeds 65520` };
    }
    if (off + len > buf.length) {
      return { packets, consumed: off, truncated: true };
    }
    packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return { packets, consumed: off, truncated: false };
}

/** Decode ALL pkt-lines in a buffer (no trailing data expected). */
export function decodeAllPktLines(buf: Buffer): PktPacket[] {
  const out: PktPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    const { packets, consumed, error, truncated } = decodePktLines(buf.subarray(off));
    if (error !== undefined) throw new Error(error);
    if (truncated) throw new Error('truncated pkt-line');
    out.push(...packets);
    if (consumed === 0) break;
    off += consumed;
    // decodePktLines stops after a flush; continue past it for full streams.
    if (packets.length > 0 && packets[packets.length - 1].kind === 'flush') {
      // A flush ends one section; keep decoding the rest of the buffer.
      continue;
    }
    if (packets.length === 0) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pack varints
// ---------------------------------------------------------------------------

/** Encode a pack object header varint: type in bits 4-6, size in low bits. */
export function encodeObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

export interface SizeVarint {
  typeCode: number;
  size: number;
  next: number;
}

/** Decode a pack object header varint at `off`. */
export function decodeObjectHeader(buf: Buffer, off: number): SizeVarint {
  let b = buf[off++];
  const typeCode = (b >> 4) & 0x07;
  let size = b & 0x0f;
  let shift = 4;
  while (b & 0x80) {
    b = buf[off++];
    size |= (b & 0x7f) << shift;
    shift += 7;
  }
  return { typeCode, size, next: off };
}

/** Encode a git OFS_DELTA base-offset varint. */
export function encodeOfsOffset(offset: number): Buffer {
  const bytes: number[] = [offset & 0x7f];
  offset >>>= 7;
  while (offset > 0) {
    offset -= 1;
    bytes.unshift(0x80 | (offset & 0x7f));
    offset >>>= 7;
  }
  return Buffer.from(bytes);
}

/** Decode a git OFS_DELTA base-offset varint at `off`. Returns {offset, next}. */
export function decodeOfsOffset(buf: Buffer, off: number): { offset: number; next: number } {
  let b = buf[off++];
  let offset = b & 0x7f;
  while (b & 0x80) {
    b = buf[off++];
    offset = ((offset + 1) << 7) | (b & 0x7f);
  }
  return { offset, next: off };
}

/** Decode a git delta size varint (7 bits per byte, MSB continuation). */
export function decodeDeltaVarint(buf: Buffer, off: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let b: number;
  do {
    b = buf[off++];
    value |= (b & 0x7f) << shift;
    shift += 7;
  } while (b & 0x80);
  return { value, next: off };
}

// ---------------------------------------------------------------------------
// Delta apply
// ---------------------------------------------------------------------------

/**
 * Apply a git delta to `base`, returning the reconstructed object.
 * Throws on size mismatch, bad opcode, or out-of-bounds copy.
 */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const baseSize = decodeDeltaVarint(delta, off);
  off = baseSize.next;
  if (baseSize.value !== base.length) {
    throw new Error(`delta-base-size: delta expects base ${baseSize.value}, got ${base.length}`);
  }
  const resultSize = decodeDeltaVarint(delta, off);
  off = resultSize.next;
  const out = Buffer.alloc(resultSize.value);
  let outPos = 0;
  while (off < delta.length) {
    const op = delta[off++];
    if (op & 0x80) {
      // Copy from base: offset/size encoded in the bits that are set.
      let cpOff = 0;
      let cpSize = 0;
      if (op & 0x01) cpOff = delta[off++];
      if (op & 0x02) cpOff |= delta[off++] << 8;
      if (op & 0x04) cpOff |= delta[off++] << 16;
      if (op & 0x08) cpOff |= delta[off++] << 24;
      if (op & 0x10) cpSize = delta[off++];
      if (op & 0x20) cpSize |= delta[off++] << 8;
      if (op & 0x40) cpSize |= delta[off++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      if (cpOff + cpSize > base.length) throw new Error('delta copy out of bounds');
      if (outPos + cpSize > out.length) throw new Error('delta output overrun');
      base.copy(out, outPos, cpOff, cpOff + cpSize);
      outPos += cpSize;
    } else if (op !== 0) {
      // Insert literal bytes.
      if (outPos + op > out.length) throw new Error('delta output overrun');
      delta.copy(out, outPos, off, off + op);
      off += op;
      outPos += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (outPos !== out.length) {
    throw new Error(`delta-size: produced ${outPos} bytes, expected ${out.length}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Commit / tree / tag parsing
// ---------------------------------------------------------------------------

export interface ParsedCommit {
  tree: Oid;
  parents: Oid[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: Oid[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: Oid;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, space);
    if (space === -1 || nul === -1) throw new Error('malformed tree entry');
    const mode = data.toString('ascii', off, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

export interface ParsedTag {
  object: Oid;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank === -1 ? text : text.slice(0, blank);
  const message = blank === -1 ? '' : text.slice(blank + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------------------
// Pack generation (full objects only, no deltas; version 2; SHA-1 trailer)
// ---------------------------------------------------------------------------

export const PACK_TYPE_CODES: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

export const PACK_CODE_TYPES: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

/** Build a pack from entries in the caller's order. */
export function buildPack(entries: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const entry of entries) {
    const code = PACK_TYPE_CODES[entry.type];
    parts.push(encodeObjectHeader(code, entry.data.length));
    parts.push(deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Build a pack from an oid -> object map (map iteration order). */
export function buildPackFromMap(objects: Map<Oid, GitObject>): Buffer {
  const entries: Array<{ type: GitObjectType; data: Buffer }> = [];
  for (const obj of objects.values()) entries.push({ type: obj.type, data: obj.data });
  return buildPack(entries);
}

/** A valid empty pack (header + count 0 + trailer). */
export function buildEmptyPack(): Buffer {
  return buildPack([]);
}

// ---------------------------------------------------------------------------
// Pack parsing
// ---------------------------------------------------------------------------

interface RawPackEntry {
  offset: number;
  typeCode: number;
  size: number;
  /** For OBJ_OFS_DELTA: absolute offset of the base entry in this pack. */
  baseOffset?: number;
  /** For OBJ_REF_DELTA: oid of the base object. */
  baseOid?: Oid;
  /** Inflated bytes: raw object data, or delta instructions for deltas. */
  inflated: Buffer;
}

/**
 * Inflate `buf` starting at `off`, where the zlib stream's declared
 * inflated size is `expectedSize` and the stream must end by `limit`
 * (exclusive). Returns {data, next} with `next` the offset just past the
 * zlib stream. Uses a binary search on the prefix length because
 * inflateSync reports no consumed length. The whole-remainder fast path
 * is valid ONLY for the last entry (inflateSync ignores trailing bytes,
 * so it cannot locate the end of a non-final entry).
 */
function inflateEntry(
  buf: Buffer,
  off: number,
  limit: number,
  expectedSize: number,
  isLast: boolean,
): { data: Buffer; next: number } {
  const remainder = buf.subarray(off, limit);
  if (isLast) {
    const data = inflateSync(remainder);
    if (data.length !== expectedSize) throw new Error('pack-size: inflated size does not match declared size');
    return { data, next: limit };
  }
  let lo = 1;
  let hi = remainder.length;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      const data = inflateSync(remainder.subarray(0, mid));
      if (data.length === expectedSize) {
        found = mid;
        hi = mid - 1;
      } else if (data.length < expectedSize) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    } catch {
      lo = mid + 1;
    }
  }
  if (found === -1) throw new Error('pack-size: zlib stream did not inflate to the declared size');
  return { data: inflateSync(remainder.subarray(0, found)), next: off + found };
}

/**
 * Parse a PACK v2/v3 packfile into oid -> object. Deltas (OFS/REF) are
 * resolved; REF_DELTA bases may come from `resolveBase` (thin packs).
 * Throws on any malformed input. Never mutates the input buffer.
 */
export function parsePack(
  buf: Buffer,
  resolveBase?: (oid: Oid) => GitObject | undefined,
): Map<Oid, GitObject> {
  if (buf.length < 32) throw new Error(`pack is ${buf.length} bytes, too short`);
  if (buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  // Trailer check: last 20 bytes must be SHA-1 of the preceding bytes.
  const trailer = buf.subarray(buf.length - 20).toString('hex');
  const expected = sha1Hex(buf.subarray(0, buf.length - 20));
  if (trailer !== expected) {
    throw new Error(`pack trailer ${trailer} does not match its bytes ${expected}`);
  }
  const bodyEnd = buf.length - 20;

  // First pass: read every entry's header + inflated bytes.
  const rawEntries: RawPackEntry[] = [];
  let off = 12;
  for (let i = 0; i < count; i++) {
    if (off >= bodyEnd) throw new Error('pack truncated: entry header past end');
    const entryOffset = off;
    const { typeCode, size, next } = decodeObjectHeader(buf, off);
    off = next;
    let baseOffset: number | undefined;
    let baseOid: Oid | undefined;
    if (typeCode === 6) {
      const decoded = decodeOfsOffset(buf, off);
      off = decoded.next;
      baseOffset = entryOffset - decoded.offset;
      if (baseOffset < 0) throw new Error(`ofs-delta at ${entryOffset} names an invalid base offset`);
    } else if (typeCode === 7) {
      if (off + 20 > bodyEnd) throw new Error('pack truncated: ref-delta base oid past end');
      baseOid = buf.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!(typeCode in PACK_CODE_TYPES)) {
      throw new Error(`unknown pack object type ${typeCode}`);
    }
    const { data, next: nextOff } = inflateEntry(buf, off, bodyEnd, size, i === count - 1);
    if (data.length !== size) throw new Error('pack-size: inflated size does not match declared size');
    off = nextOff;
    rawEntries.push({ offset: entryOffset, typeCode, size, baseOffset, baseOid, inflated: data });
  }
  if (rawEntries.length !== count) throw new Error('pack count mismatch');

  // Second pass: resolve entries to objects. Deltas resolve iteratively so
  // chains and out-of-order REF_DELTA bases work; cycles / missing bases
  // are errors.
  const byOffset = new Map<number, RawPackEntry>();
  for (const entry of rawEntries) byOffset.set(entry.offset, entry);
  const resolved = new Map<Oid, GitObject>();
  const resolvedByEntry = new Map<RawPackEntry, GitObject>();
  const pending = new Set<RawPackEntry>(rawEntries);
  let progress = true;
  while (pending.size > 0 && progress) {
    progress = false;
    for (const entry of [...pending]) {
      if (entry.typeCode >= 1 && entry.typeCode <= 4) {
        const type = PACK_CODE_TYPES[entry.typeCode];
        const obj: GitObject = { type, data: entry.inflated };
        const oid = hashObject(type, entry.inflated);
        resolved.set(oid, obj);
        resolvedByEntry.set(entry, obj);
        pending.delete(entry);
        progress = true;
        continue;
      }
      // Delta entry: find the base object.
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (baseEntry === undefined) {
          throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        }
        base = resolvedByEntry.get(baseEntry);
      } else if (entry.baseOid !== undefined) {
        base = resolved.get(entry.baseOid);
        if (base === undefined && resolveBase !== undefined) base = resolveBase(entry.baseOid);
      }
      if (base === undefined) continue; // maybe resolvable in a later round
      const data = applyDelta(base.data, entry.inflated);
      // The delta's target type is the base's type.
      const obj: GitObject = { type: base.type, data };
      const oid = hashObject(base.type, data);
      resolved.set(oid, obj);
      resolvedByEntry.set(entry, obj);
      pending.delete(entry);
      progress = true;
    }
  }
  if (pending.size > 0) {
    // Distinguish a cycle from a missing base.
    const first = [...pending][0];
    if (first.typeCode === 7 && first.baseOid !== undefined && !resolved.has(first.baseOid)) {
      throw new Error(`ref-delta base ${first.baseOid} is neither in the pack nor supplied by the client`);
    }
    throw new Error(`delta cycle at pack offset ${first.offset}`);
  }
  if (resolved.size !== count) throw new Error('pack object count mismatch after resolution');
  return resolved;
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * Full reachable closure (commits, trees, blobs, tags) from `tips`.
 * Tag objects are included and peeled; gitlinks (mode 160000) are skipped.
 */
export function collectReachable(repo: Repo, tips: Oid[]): Set<Oid> {
  const seen = new Set<Oid>();
  const stack: Oid[] = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.tree !== '') stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object !== '') stack.push(tag.object);
    }
  }
  return seen;
}

/** All objects reachable from `tips`, as an oid -> object map. */
export function collectReachableObjects(repo: Repo, tips: Oid[]): Map<Oid, GitObject> {
  const ids = collectReachable(repo, tips);
  const out = new Map<Oid, GitObject>();
  for (const oid of ids) {
    const obj = repo.objects.get(oid);
    if (obj !== undefined) out.set(oid, obj);
  }
  return out;
}

/**
 * Objects the client already holds, from its `have` oids — EXCEPT that
 * traversal stops at a shallow boundary: a shallow commit's own tree and
 * blobs are held, but its parents are NOT (that is the whole point of a
 * shallow clone, and the deepen case depends on it: want = have = tip
 * with shallow = [tip] must still deliver the parent).
 */
function collectHeld(repo: Repo, haves: Oid[], shallowBoundaries: Set<Oid>): Set<Oid> {
  const seen = new Set<Oid>();
  const stack: Oid[] = [...haves];
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.tree !== '') stack.push(commit.tree);
      if (!shallowBoundaries.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (tag.object !== '') stack.push(tag.object);
    }
  }
  return seen;
}

export interface FetchPlan {
  /** Objects to send (already minus the have-closure). */
  objects: Map<Oid, GitObject>;
  /** New shallow boundary commits (depth cut). */
  shallow: Oid[];
  /** Previously-shallow commits that are now fully included. */
  unshallow: Oid[];
}

/**
 * Compute a fetch: objects reachable from `wants` (limited to `depth`
 * commit generations when given), minus everything reachable from
 * `haves`. `shallowBoundaries` are the client's current shallow oids,
 * used to compute `unshallow`.
 *
 * Depth semantics: depth 1 delivers the tip commit + its tree/blobs only;
 * depth n delivers n generations. The boundary is the set of delivered
 * commits that still have a parent outside the delivered commit set.
 */
export function fetchPlan(
  repo: Repo,
  opts: { wants: Oid[]; haves?: Oid[]; depth?: number; shallowBoundaries?: Oid[] },
): FetchPlan {
  const haves = opts.haves ?? [];
  const depth = opts.depth;
  const shallowSet = new Set(opts.shallowBoundaries ?? []);
  const haveClosure = haves.length > 0 ? collectHeld(repo, haves, shallowSet) : new Set<Oid>();

  // Walk wants by commit generation. Tags peel to their target at the
  // same generation; trees/blobs wanted directly are included as-is.
  const includedCommits = new Set<Oid>();
  const included = new Set<Oid>();
  const queue: Array<{ oid: Oid; gen: number }> = opts.wants.map((oid) => ({ oid, gen: 0 }));
  const queuedCommits = new Set<Oid>();
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: Oid; gen: number };
    if (included.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      if (depth !== undefined && gen >= depth) continue;
      included.add(oid);
      includedCommits.add(oid);
      const commit = parseCommit(obj.data);
      if (commit.tree !== '') {
        for (const treeOid of collectReachable(repo, [commit.tree])) included.add(treeOid);
      }
      for (const parent of commit.parents) {
        if (queuedCommits.has(parent)) continue;
        queuedCommits.add(parent);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    } else if (obj.type === 'tag') {
      included.add(oid);
      const tag = parseTag(obj.data);
      if (tag.object !== '' && !included.has(tag.object)) {
        queue.push({ oid: tag.object, gen });
      }
    } else {
      // Tree or blob wanted directly.
      included.add(oid);
      if (obj.type === 'tree') {
        for (const sub of collectReachable(repo, [oid])) included.add(sub);
      }
    }
  }

  // Delivered objects: included minus what the client already holds.
  const objects = new Map<Oid, GitObject>();
  for (const oid of included) {
    if (haveClosure.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj !== undefined) objects.set(oid, obj);
  }

  let shallow: Oid[] = [];
  let unshallow: Oid[] = [];
  if (depth !== undefined) {
    for (const oid of includedCommits) {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      if (commit.parents.length > 0 && commit.parents.some((p) => !includedCommits.has(p))) {
        shallow.push(oid);
      }
    }
    const oldShallow = opts.shallowBoundaries ?? [];
    for (const oid of oldShallow) {
      if (!includedCommits.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const commit = parseCommit(obj.data);
      const parentsCovered = commit.parents.every(
        (p) => includedCommits.has(p) || haveClosure.has(p),
      );
      if (parentsCovered) unshallow.push(oid);
    }
  }
  return { objects, shallow, unshallow };
}

// ---------------------------------------------------------------------------
// Ancestry / fast-forward
// ---------------------------------------------------------------------------

/** True when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(repo: Repo, ancestor: Oid, descendant: Oid): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<Oid>();
  const stack: Oid[] = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as Oid;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/**
 * Fast-forward check for a ref update. Creation (old ZERO) and deletion
 * (new ZERO) are always allowed; otherwise the new tip must contain the
 * old tip as an ancestor.
 */
export function isFastForward(repo: Repo, oldOid: Oid, newOid: Oid): boolean {
  if (oldOid === ZERO_OID || newOid === ZERO_OID) return true;
  if (oldOid === newOid) return true;
  return isAncestor(repo, oldOid, newOid);
}

/** Peel a tag object (recursively) to the underlying commit oid, if any. */
export function peelToCommit(repo: Repo, oid: Oid): Oid | undefined {
  let current = oid;
  const seen = new Set<Oid>();
  for (;;) {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const obj = repo.objects.get(current);
    if (obj === undefined) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return undefined;
  }
}
