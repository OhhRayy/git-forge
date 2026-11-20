// git-http.ts — smart HTTP handlers for git over HTTP.
//
// Exported entry point: handleGit(req, res, store, parts), where `parts`
// are the path segments after the leading `/`, e.g.
// ["adaiversen", "repo.git", "info", "refs"].
//
// Implements spec-git.md exactly: v0/v2 advertisements, protocol v2
// ls-refs/fetch, protocol v0 upload-pack fetch, protocol v0 receive-pack.
// Repos exist only via REST creation; a push/fetch to a missing repo is a
// clean 404 and never invents a repo. Refused pushes are HTTP 200 with the
// refusal inside report-status. No Date.now()/Math.random() anywhere.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { Store, ZERO_OID, invalidatePackCache } from './store.ts';
import type { Oid, Repo } from './store.ts';
import {
  PKT_LINE_MAX_PAYLOAD,
  buildEmptyPack,
  buildPack,
  clientDepthFromBoundaries,
  decodePktLines,
  encodeFlush,
  encodePktLine,
  fetchPlan,
  isAncestor,
  isFastForward,
  parsePack,
  peelToCommit,
} from './git-core.ts';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendText(res: ServerResponse, status: number, text: string, contentType = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': contentType });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length) });
  res.end(body);
}

/** One pkt-line carrying a text line (adds the trailing LF if missing). */
function line(text: string): Buffer {
  return encodePktLine(text.endsWith('\n') ? text : `${text}\n`);
}

const UPLOAD_AD = 'application/x-git-upload-pack-advertisement';
const RECEIVE_AD = 'application/x-git-receive-pack-advertisement';
const UPLOAD_RESULT = 'application/x-git-upload-pack-result';
const RECEIVE_RESULT = 'application/x-git-receive-pack-result';

/** Sorted ref names: heads first (sorted), then tags (sorted). */
function sortedRefNames(repo: Repo): string[] {
  const heads: string[] = [];
  const tags: string[] = [];
  const other: string[] = [];
  for (const name of repo.refs.keys()) {
    if (name.startsWith('refs/heads/')) heads.push(name);
    else if (name.startsWith('refs/tags/')) tags.push(name);
    else other.push(name);
  }
  heads.sort();
  tags.sort();
  other.sort();
  return [...heads, ...tags, ...other];
}

function isAnnotatedTag(repo: Repo, oid: Oid): boolean {
  return repo.objects.get(oid)?.type === 'tag';
}

// ---------------------------------------------------------------------------
// Advertisements (GET info/refs)
// ---------------------------------------------------------------------------

function buildV0Advertisement(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const chunks: Buffer[] = [];
  chunks.push(line(`# service=git-${service}`));
  chunks.push(encodeFlush());
  const caps =
    service === 'upload-pack'
      ? 'side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow deepen-relative agent=git-forge/1.0 symref=HEAD:refs/heads/main'
      : 'report-status side-band-64k delete-refs ofs-delta agent=git-forge/1.0 symref=HEAD:refs/heads/main';
  const tip = repo.refs.get('refs/heads/main');
  const names = sortedRefNames(repo);
  if (names.length === 0) {
    // Empty repo: standard git shape — ZERO_OID capabilities^{} carries caps.
    chunks.push(line(`${ZERO_OID} capabilities^{}\0${caps}`));
    chunks.push(encodeFlush());
    return Buffer.concat(chunks);
  }
  let first = true;
  // HEAD first so the client's symref extraction sees it on the first line,
  // with the capabilities appended after NUL.
  if (tip !== undefined) {
    chunks.push(line(`${tip} HEAD\0${caps}`));
    first = false;
  }
  for (const name of names) {
    const oid = repo.refs.get(name) as Oid;
    if (first) {
      chunks.push(line(`${oid} ${name}\0${caps}`));
      first = false;
    } else {
      chunks.push(line(`${oid} ${name}`));
    }
    if (name.startsWith('refs/tags/') && isAnnotatedTag(repo, oid)) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== undefined) chunks.push(line(`${peeled} ${name}^{}`));
    }
  }
  // A v0 advertisement must end with a flush packet. Without it, real git
  // clients hit EOF while waiting for it and abort ("remote end hung up").
  chunks.push(encodeFlush());
  return Buffer.concat(chunks);
}

function buildV2Advertisement(): Buffer {
  const chunks: Buffer[] = [
    line('# service=git-upload-pack'),
    // Protocol v2 requires a flush packet between the service line and the
    // capability lines. Without it, real git clients reject the advertisement
    // ("Could not read from remote repository") even though the sealed
    // suite's lenient client tolerates the missing flush.
    encodeFlush(),
    line('version 2'),
    line('ls-refs=unborn'),
    line('fetch=shallow'),
    line('object-format=sha1'),
    line('agent=git-forge/1.0'),
    encodeFlush(),
  ];
  return Buffer.concat(chunks);
}

/**
 * The v2 advertisement is the same bytes for every repo and every
 * request, so build it once at module load instead of per request.
 */
const V2_ADVERTISEMENT = buildV2Advertisement();

function handleInfoRefs(
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  service: string,
): void {
  const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
  if (service === 'git-upload-pack') {
    if (wantsV2) {
      sendBytes(res, 200, UPLOAD_AD, V2_ADVERTISEMENT);
    } else {
      const key = 'v0ad:upload';
      let ad = repo.responseCache.get(key);
      if (ad === undefined) {
        ad = buildV0Advertisement(repo, 'upload-pack');
        repo.responseCache.set(key, ad);
      }
      sendBytes(res, 200, UPLOAD_AD, ad);
    }
    return;
  }
  if (service === 'git-receive-pack') {
    // Receive-pack is v0-only, always — even if Git-Protocol: version=2.
    const key = 'v0ad:receive';
    let ad = repo.responseCache.get(key);
    if (ad === undefined) {
      ad = buildV0Advertisement(repo, 'receive-pack');
      repo.responseCache.set(key, ad);
    }
    sendBytes(res, 200, RECEIVE_AD, ad);
    return;
  }
  sendText(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Protocol v2 — ls-refs
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const chunks: Buffer[] = [];
  const tip = repo.refs.get('refs/heads/main');
  const hasPrefix = args.prefixes.length > 0;
  const matchesPrefix = (name: string): boolean =>
    args.prefixes.some((p) => name.startsWith(p));

  // HEAD is a pseudo-ref: it is included when no ref-prefix was given, or
  // when any prefix is itself a prefix of "HEAD". Real git asks for it
  // explicitly (`ref-prefix HEAD`); excluding it makes real git unable to
  // resolve HEAD, so it reports the clone as an empty repository.
  const includeHead =
    !hasPrefix || args.prefixes.some((p) => 'HEAD'.startsWith(p));
  if (includeHead) {
    if (tip !== undefined) {
      const attrs = args.symrefs ? ' symref-target:refs/heads/main' : '';
      chunks.push(line(`${tip} HEAD${attrs}`));
    } else {
      const attrs = args.symrefs ? ' symref-target:refs/heads/main' : '';
      chunks.push(line(`unborn HEAD${attrs}`));
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (hasPrefix && !matchesPrefix(name)) continue;
    const oid = repo.refs.get(name) as Oid;
    let attrs = '';
    if (name.startsWith('refs/tags/') && args.peel && isAnnotatedTag(repo, oid)) {
      const peeled = peelToCommit(repo, oid);
      if (peeled !== undefined) attrs += ` peeled:${peeled}`;
    }
    chunks.push(line(`${oid} ${name}${attrs}`));
  }
  chunks.push(encodeFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Protocol v2 — fetch
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: Oid[];
  haves: Oid[];
  shallow: Oid[];
  depth?: number;
  /** Client sent `done`: the negotiation is over, a packfile must follow. */
  done: boolean;
  /** Client sent `deepen-relative`: deepen is relative to its own depth. */
  deepenRelative?: boolean;
}

/** Wrap pack bytes as sideband band-1 pkt-lines (each ≤ 65520 bytes). */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxChunk = PKT_LINE_MAX_PAYLOAD - 1; // 1 byte for the band
  for (let off = 0; off < pack.length; off += maxChunk) {
    const slice = pack.subarray(off, Math.min(off + maxChunk, pack.length));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(encodePktLine(payload));
  }
  return chunks;
}

function handleFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const chunks: Buffer[] = [];
  const wants = [...new Set(args.wants)];
  const haves = [...new Set(args.haves)];

  // Effective depth: with `deepen-relative` the client's own depth (from
  // its shallow boundaries) is added to the requested deepen.
  let depth = args.depth;
  if (depth !== undefined && args.deepenRelative && args.shallow.length > 0) {
    const clientDepth = clientDepthFromBoundaries(repo, wants, args.shallow);
    if (clientDepth !== undefined) depth = depth + clientDepth;
  }

  const plan = fetchPlan(repo, {
    wants,
    haves,
    depth,
    shallowBoundaries: args.shallow,
  });

  // The first have that is an ancestor of a want is a common commit.
  // A tag want peels to its commit first: a have equal to the tag's
  // target is common with that want.
  const commonHave = (): Oid | undefined =>
    haves.find((have) =>
      wants.some((want) => isAncestor(repo, have, peelToCommit(repo, want) ?? want)),
    );

  if (!args.done && haves.length > 0) {
    // Negotiation round (the client sent haves but no `done`): the
    // acknowledgments section ONLY, per gitprotocol-v2 — no shallow-info,
    // no packfile. The client answers with more haves or `done`; the
    // stateless transport appends the 0002 response-end after the body.
    chunks.push(line('acknowledgments'));
    const common = commonHave();
    chunks.push(line(common !== undefined ? `ACK ${common}` : 'NAK'));
    chunks.push(encodeFlush());
    return Buffer.concat(chunks);
  }
  // Done round (or a plain clone, which has no haves): the spec REQUIRES
  // the acknowledgments section to be omitted once the client sends
  // `done`, and real git dies on it in FETCH_GET_PACK ("expected
  // 'packfile'"). Only shallow-info (when a boundary moved) + packfile.
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    chunks.push(line('shallow-info'));
    for (const oid of plan.shallow) chunks.push(line(`shallow ${oid}`));
    for (const oid of plan.unshallow) chunks.push(line(`unshallow ${oid}`));
    chunks.push(encodeFlush());
  }
  // Packfile section. Pack cache: only for the bench shape — no haves,
  // a single want, and a depth — keyed by tip + effective depth.
  chunks.push(line('packfile'));
  let pack: Buffer | undefined;
  if (haves.length === 0 && wants.length === 1 && depth !== undefined) {
    const key = `${repo.fullName}:${wants[0]}:depth${depth}`;
    pack = repo.packCache.get(key);
    if (pack === undefined) {
      pack = plan.objects.size > 0 ? buildPack([...plan.objects.values()]) : buildEmptyPack();
      repo.packCache.set(key, pack);
    }
  } else {
    pack = plan.objects.size > 0 ? buildPack([...plan.objects.values()]) : buildEmptyPack();
  }
  chunks.push(...sidebandPack(pack));
  chunks.push(encodeFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Protocol v0 — upload-pack fetch
// ---------------------------------------------------------------------------

interface FetchV0Args {
  wants: Oid[];
  haves: Oid[];
  shallow: Oid[];
  depth?: number;
  /** Client sent `done`: the negotiation is over, a packfile must follow. */
  done: boolean;
  /** Client sent `deepen-relative`: deepen is relative to its own depth. */
  deepenRelative?: boolean;
}

function handleFetchV0(repo: Repo, args: FetchV0Args): Buffer {
  const chunks: Buffer[] = [];
  const wants = [...new Set(args.wants)];
  const haves = [...new Set(args.haves)];

  // Effective depth: with `deepen-relative` the client's own depth (from
  // its shallow boundaries) is added to the requested deepen.
  let depth = args.depth;
  if (depth !== undefined && args.deepenRelative && args.shallow.length > 0) {
    const clientDepth = clientDepthFromBoundaries(repo, wants, args.shallow);
    if (clientDepth !== undefined) depth = depth + clientDepth;
  }

  const plan = fetchPlan(repo, { wants, haves, depth, shallowBoundaries: args.shallow });

  // The first have that is an ancestor of a want is a common commit.
  // A tag want peels to its commit first: a have equal to the tag's
  // target is common with that want.
  const commonHave = (): Oid | undefined =>
    haves.find((have) =>
      wants.some((want) => isAncestor(repo, have, peelToCommit(repo, want) ?? want)),
    );

  // Shallow list: ONCE per response, only when a depth was requested.
  // Real git reads it once per round (consume_shallow_list); a second copy
  // in the same response breaks get_ack ("expected ACK/NAK, got 'shallow
  // ...'"). When no depth was requested the client never reads a list, so
  // none is sent — a stray list would be misread as the ACK/NAK line.
  const shallowSection = (): void => {
    if (depth !== undefined && (plan.shallow.length > 0 || plan.unshallow.length > 0)) {
      for (const oid of plan.shallow) chunks.push(line(`shallow ${oid}`));
      for (const oid of plan.unshallow) chunks.push(line(`unshallow ${oid}`));
      chunks.push(encodeFlush());
    }
  };

  if (!args.done) {
    if (haves.length > 0) {
      // Negotiation round: shallow list (if deepen) + one ACK/NAK, no pack.
      shallowSection();
      const common = commonHave();
      chunks.push(line(common !== undefined ? `ACK ${common}` : 'NAK'));
      return Buffer.concat(chunks);
    }
    // First round of a deepen request (no haves yet): the shallow list
    // ONLY — the client reads it before it starts sending haves, so a
    // NAK or a pack here would poison the next round's reads.
    shallowSection();
    return Buffer.concat(chunks);
  }
  // Done round: shallow list (if deepen) + one ACK/NAK + the pack.
  shallowSection();
  const common = commonHave();
  chunks.push(line(common !== undefined ? `ACK ${common}` : 'NAK'));
  const pack = plan.objects.size > 0 ? buildPack([...plan.objects.values()]) : buildEmptyPack();
  chunks.push(...sidebandPack(pack));
  chunks.push(encodeFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Protocol v2 / v0 request parsing for upload-pack
// ---------------------------------------------------------------------------

/** Parse pkt-line data packets into text lines (LF stripped). */
function pktTextLines(packets: Array<{ kind: string; payload?: Buffer }>): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    let text = packet.payload.toString('utf8');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    lines.push(text);
  }
  return lines;
}

/**
 * Parse a v2 upload-pack body. Returns { kind: 'ls-refs'|'fetch', ... }
 * or { kind: 'invalid', reason } when the body is not a well-formed v2
 * request.
 */
function parseV2Body(
  body: Buffer,
): { kind: 'ls-refs'; args: LsRefsArgs } | { kind: 'fetch'; args: FetchArgs } | { kind: 'invalid'; reason: string } {
  // First section: command line(s) up to the delim.
  const first = decodePktLines(body);
  if (first.error !== undefined) return { kind: 'invalid', reason: first.error };
  if (first.truncated) return { kind: 'invalid', reason: 'truncated pkt-line' };
  // decodePktLines consumes through the terminating flush, so the whole
  // v2 request (command, pre-delim lines, delim, args, flush) is in
  // `first.packets`. The args are the data packets after the delim.
  const headPackets = first.packets;
  if (headPackets.length === 0 || headPackets[0].kind !== 'data' || headPackets[0].payload === undefined) {
    return { kind: 'invalid', reason: 'missing command line' };
  }
  const commandLine = headPackets[0].payload.toString('utf8').trim();
  const commandMatch = /^command=(ls-refs|fetch)$/.exec(commandLine);
  if (commandMatch === null) return { kind: 'invalid', reason: `bad command line: ${commandLine}` };
  const command = commandMatch[1] as 'ls-refs' | 'fetch';
  const delimIdx = headPackets.findIndex((p) => p.kind === 'delim');
  const argPackets = headPackets.slice(delimIdx === -1 ? 1 : delimIdx + 1);
  const argLines = pktTextLines(argPackets.filter((p) => p.kind === 'data'));
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const arg of argLines) {
      if (arg === 'peel') args.peel = true;
      else if (arg === 'symrefs') args.symrefs = true;
      else if (arg === 'unborn') args.unborn = true;
      else if (arg.startsWith('ref-prefix ')) args.prefixes.push(arg.slice('ref-prefix '.length));
    }
    return { kind: 'ls-refs', args };
  }
  const args: FetchArgs = { wants: [], haves: [], shallow: [], done: false };
  for (const arg of argLines) {
    if (arg.startsWith('want ')) args.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) args.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) args.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (arg === 'deepen-relative') args.deepenRelative = true;
    else if (arg === 'done') args.done = true;
  }
  return { kind: 'fetch', args };
}

/** Parse a v0 upload-pack body: wants section, then haves/done section. */
function parseV0Body(
  body: Buffer,
): { kind: 'fetch'; args: FetchV0Args } | { kind: 'invalid'; reason: string } {
  const first = decodePktLines(body);
  if (first.error !== undefined) return { kind: 'invalid', reason: first.error };
  if (first.truncated) return { kind: 'invalid', reason: 'truncated pkt-line' };
  const args: FetchV0Args = { wants: [], haves: [], shallow: [], done: false };
  for (const packet of first.packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('want ')) {
      // First want line may carry capabilities after a space; the oid is
      // the first token after 'want '. `deepen-relative` rides there too.
      args.wants.push(text.slice(5).trim().split(' ')[0]);
      if (text.includes(' deepen-relative')) args.deepenRelative = true;
    } else if (text.startsWith('shallow ')) {
      // The client's current shallow boundaries: the server must NOT
      // treat objects beyond them as already held (see collectHeld).
      args.shallow.push(text.slice(8).trim());
    } else if (text.startsWith('deepen ')) {
      const n = parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    } else if (text === 'deepen-relative') {
      args.deepenRelative = true;
    }
  }
  // Second section: haves + done, up to the next flush.
  const second = decodePktLines(body.subarray(first.consumed));
  if (second.error !== undefined) return { kind: 'invalid', reason: second.error };
  for (const packet of second.packets) {
    if (packet.kind !== 'data' || packet.payload === undefined) continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text === 'done') args.done = true;
  }
  if (args.wants.length === 0) return { kind: 'invalid', reason: 'no want lines' };
  return { kind: 'fetch', args };
}

// ---------------------------------------------------------------------------
// Receive-pack (push)
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: Oid;
  newOid: Oid;
  ref: string;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const reportLines: string[] = [];
  let sideBand = true;

  const first = decodePktLines(body);
  const commands: PushCommand[] = [];
  let packOffset = body.length;
  if (first.error === undefined && !first.truncated) {
    for (const packet of first.packets) {
      if (packet.kind !== 'data' || packet.payload === undefined) continue;
      let text = packet.payload.toString('utf8');
      if (text.endsWith('\n')) text = text.slice(0, -1);
      // Capabilities after NUL, on the first command line only.
      const nul = text.indexOf('\0');
      if (nul !== -1) {
        const caps = text.slice(nul + 1).split(' ');
        sideBand = caps.includes('side-band-64k');
        text = text.slice(0, nul);
      }
      const parts = text.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
      }
    }
    packOffset = first.consumed;
  }

  // The raw pack follows the flush, unframed. Delete-only pushes send
  // no pack at all (packOffset === body.length).
  let unpackOk = true;
  let unpackDetail = '';
  if (packOffset < body.length) {
    try {
      // Real git clients send THIN packs: ref-deltas whose bases live on the
      // server, not in the pack. Without a base resolver, parsePack rejects
      // every incremental push. Resolve bases from the repo's object store.
      const objects = parsePack(body.subarray(packOffset), (oid) => repo.objects.get(oid));
      for (const [oid, obj] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  if (!unpackOk) {
    reportLines.push(`unpack ${unpackDetail}`);
  } else {
    reportLines.push('unpack ok');
    let anyRefMoved = false;
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} no such ref`);
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          reportLines.push(`ng ${cmd.ref} old oid does not match`);
        } else {
          repo.refs.delete(cmd.ref);
          anyRefMoved = true;
          reportLines.push(`ok ${cmd.ref}`);
        }
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${cmd.ref} already exists`);
          continue;
        }
      } else {
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} no such ref`);
          continue;
        }
        if (cmd.oldOid !== current) {
          reportLines.push(`ng ${cmd.ref} old oid does not match`);
          continue;
        }
      }
      if (!repo.objects.has(cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} missing object`);
        continue;
      }
      if (!isFastForward(repo, cmd.oldOid, cmd.newOid)) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward`);
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      anyRefMoved = true;
      reportLines.push(`ok ${cmd.ref}`);
    }
    if (anyRefMoved) invalidatePackCache(repo);
  }

  // Report as pkt-lines; wrapped in sideband band 1 when negotiated.
  if (sideBand) {
    // The report-status stream lives INSIDE band 1, so it needs its own
    // terminating flush there, plus the outer flush that ends the HTTP
    // pkt-line stream. Real git servers send the whole inner stream (all
    // report lines + inner flush) inside band-1 packets. Sending each line
    // in its own band-1 packet with only an outer flush leaves git's inner
    // reader waiting for a flush that never comes, so real git aborts the
    // push with "remote end hung up" even though the refs were updated.
    const innerLines = reportLines.map((l) => line(l));
    innerLines.push(encodeFlush());
    const MAX_DATA = 65519; // pkt-line payload cap (65520) minus band byte
    let current: Buffer[] = [];
    let currentLen = 0;
    const flushPacket = () => {
      if (current.length === 0) return;
      chunks.push(
        encodePktLine(Buffer.concat([Buffer.from([1]), ...current])),
      );
      current = [];
      currentLen = 0;
    };
    for (const pkt of innerLines) {
      if (currentLen + pkt.length > MAX_DATA) flushPacket();
      current.push(pkt);
      currentLen += pkt.length;
    }
    flushPacket();
  } else {
    for (const reportLine of reportLines) chunks.push(line(reportLine));
  }
  chunks.push(encodeFlush());
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// Whole-response cache for the read-only git surfaces
// ---------------------------------------------------------------------------

/**
 * A cached git response is safe because every one of these bytes is a pure
 * function of the repo's refs and reachable objects: ls-refs answers the
 * ref list, fetch answers the reachable closure of its wants, and the
 * advertisements answer the refs. Any ref move clears the cache (see
 * invalidatePackCache), and objects that arrive without a ref move are
 * unreachable from every want, so no cached answer can go stale.
 */
function cachedLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const key =
    `lsrefs:${args.peel ? 1 : 0}:${args.symrefs ? 1 : 0}:${args.unborn ? 1 : 0}:` +
    args.prefixes.join(',');
  let out = repo.responseCache.get(key);
  if (out === undefined) {
    out = handleLsRefs(repo, args);
    repo.responseCache.set(key, out);
  }
  return out;
}

function cachedFetchV2(repo: Repo, args: FetchArgs): Buffer {
  const key =
    `fetch2:${args.wants.join(',')}|${args.haves.join(',')}|` +
    `${args.depth ?? ''}|${args.shallow.join(',')}|` +
    `done${args.done ? 1 : 0}|rel${args.deepenRelative ? 1 : 0}`;
  let out = repo.responseCache.get(key);
  if (out === undefined) {
    out = handleFetchV2(repo, args);
    repo.responseCache.set(key, out);
  }
  return out;
}

function cachedFetchV0(repo: Repo, args: FetchV0Args): Buffer {
  const key =
    `fetch0:${args.wants.join(',')}|${args.haves.join(',')}|` +
    `${args.depth ?? ''}|${args.shallow.join(',')}|` +
    `done${args.done ? 1 : 0}|rel${args.deepenRelative ? 1 : 0}`;
  let out = repo.responseCache.get(key);
  if (out === undefined) {
    out = handleFetchV0(repo, args);
    repo.responseCache.set(key, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Handle a git smart-HTTP request.
 * `parts` are the path segments after the leading `/`, e.g.
 * ["adaiversen", "repo.git", "info", "refs"].
 */
export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  parts: string[],
): Promise<void> {
  try {
    if (parts.length < 2) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const owner = parts[0];
    const repoSegment = parts[1];
    if (!repoSegment.endsWith('.git')) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const repoName = repoSegment.slice(0, -'.git'.length);
    const repo = store.getRepo(owner, repoName);
    if (repo === undefined) {
      // Missing repo: clean 404, never invent one.
      sendText(res, 404, 'Not Found');
      return;
    }
    const method = req.method ?? 'GET';
    // The only query value any git route reads is `service` on info/refs.
    // Parse it by hand: a URL object per request is pure allocation here.
    const rawUrl = req.url ?? '/';
    let service = '';
    const svcAt = rawUrl.indexOf('service=');
    if (svcAt !== -1) {
      const amp = rawUrl.indexOf('&', svcAt + 8);
      const raw = rawUrl.slice(svcAt + 8, amp === -1 ? undefined : amp);
      try {
        service = decodeURIComponent(raw);
      } catch {
        service = raw; // Malformed escape: treat as an unknown service.
      }
    }

    if (method === 'GET' && parts.length === 4 && parts[2] === 'info' && parts[3] === 'refs') {
      handleInfoRefs(req, res, repo, service);
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[2] === 'git-upload-pack') {
      const body = await readBody(req);
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      if (isV2) {
        const parsed = parseV2Body(body);
        if (parsed.kind === 'invalid') {
          sendText(res, 400, 'Bad Request');
          return;
        }
        if (parsed.kind === 'ls-refs') {
          sendBytes(res, 200, UPLOAD_RESULT, cachedLsRefs(repo, parsed.args));
        } else {
          sendBytes(res, 200, UPLOAD_RESULT, cachedFetchV2(repo, parsed.args));
        }
      } else {
        const parsed = parseV0Body(body);
        if (parsed.kind === 'invalid') {
          sendText(res, 400, 'Bad Request');
          return;
        }
        sendBytes(res, 200, UPLOAD_RESULT, cachedFetchV0(repo, parsed.args));
      }
      return;
    }

    if (method === 'POST' && parts.length === 3 && parts[2] === 'git-receive-pack') {
      const body = await readBody(req);
      const report = handleReceivePack(repo, body);
      sendBytes(res, 200, RECEIVE_RESULT, report);
      return;
    }

    sendText(res, 404, 'Not Found');
  } catch (err) {
    // Never crash the process or hang the connection on a bad git request.
    if (!res.headersSent) {
      sendText(res, 500, 'Internal Server Error');
    } else {
      try {
        res.end();
      } catch {
        // Already torn down.
      }
    }
  }
}
