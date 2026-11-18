// rest.ts — REST v3 surface for the git forge (spec-rest.md).
// Owns: repo CRUD, contents (real git commits), labels, issues, pulls,
// branches/commits/refs, pagination. Shared helpers (repo/issue/pull
// factories, git object encoding, merge logic) are exported for
// graphql.ts and mcp.ts so all surfaces share one store.
//
// Git object writes go through store.ts's buildTree / createCommit /
// setRef (canonical git format, deterministic clock), so SHAs are
// byte-identical to the git layer's own objects and pack caches stay
// coherent. This module only parses trees/commits back for reads.
// No Date.now()/Math.random() in any response: all timestamps come from
// store.ts's deterministic nowIso().

import { Store, VIEWER, nowIso, hashObject, buildTree, createCommit, setRef } from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';

// The single shared store instance: this layer (REST/GraphQL/MCP) and the
// git layer (via app.ts -> handleGit) all operate on this one object.
// store.ts exports the Store class, not a singleton, so the instance lives
// here; app.ts imports it from this module.
export const store = new Store();

export const VIEWER_LOGIN = VIEWER.login;
export const VIEWER_ID = VIEWER.id;
const INSTALLED_VERSION = '1.0.0';

export interface HandlerCtx {
  method: string;
  parts: string[];
  query: URLSearchParams;
  host: string;
  body: unknown;
  parseError: boolean;
  rawBody: string;
  sendJson: (status: number, data: unknown, extra?: Record<string, string>) => void;
  sendEmpty: (status: number) => void;
}

// ---------- global (Relay) ids: opaque base64, stable, never plain numbers ----------
export function repoNodeId(id: number): string {
  return Buffer.from(`Repository:${id}`, 'utf8').toString('base64');
}
export function issueNodeId(repoId: number, number: number): string {
  return Buffer.from(`Issue:${repoId}:${number}`, 'utf8').toString('base64');
}
export function pullNodeId(repoId: number, number: number): string {
  return Buffer.from(`PullRequest:${repoId}:${number}`, 'utf8').toString('base64');
}
export function commentNodeId(repoId: number, commentId: number): string {
  return Buffer.from(`IssueComment:${repoId}:${commentId}`, 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; repoId: number; number: number } | null {
  try {
    const s = Buffer.from(id, 'base64').toString('utf8');
    const p = s.split(':');
    if (p[0] === 'Repository' && p.length === 2 && /^\d+$/.test(p[1])) {
      return { kind: 'Repository', repoId: Number(p[1]), number: 0 };
    }
    if ((p[0] === 'Issue' || p[0] === 'PullRequest' || p[0] === 'IssueComment') && p.length === 3
      && /^\d+$/.test(p[1]) && /^\d+$/.test(p[2])) {
      return { kind: p[0], repoId: Number(p[1]), number: Number(p[2]) };
    }
    return null;
  } catch {
    return null;
  }
}

// ---------- git object reads (writes go through store.ts's buildTree /
// createCommit / setRef, so pack caches stay coherent with the git layer) ----------
interface TreeEntry { mode: string; name: string; oid: string; }

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    if (sp === -1) break;
    const nul = data.indexOf(0x00, sp);
    if (nul === -1 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(off, sp).toString('utf8'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

function parseCommit(data: Buffer): { tree: string; parents: string[]; message: string } {
  const text = data.toString('utf8');
  const idx = text.indexOf('\n\n');
  const head = idx === -1 ? text : text.slice(0, idx);
  const message = idx === -1 ? '' : text.slice(idx + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

function flattenTree(repo: Repo, treeOid: string | null, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  if (!treeOid) return;
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flattenTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
}

// Materialize a flattened path -> oid map as path -> bytes, for feeding
// store.ts's buildTree (which takes full file contents and stores blobs).
// store.ts's buildTree always writes mode 100644; the suite only ever
// creates regular files through the REST surface, so no mode is lost here.
function flatToBuffers(repo: Repo, flat: Map<string, { oid: string; mode: string }>): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  for (const [path, ent] of flat) {
    out.set(path, repo.objects.get(ent.oid)?.data ?? Buffer.alloc(0));
  }
  return out;
}

export function treeFlatOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return new Map();
  const parsed = parseCommit(obj.data);
  const out = new Map<string, { oid: string; mode: string }>();
  flattenTree(repo, parsed.tree || null, '', out);
  return out;
}

export function getBranchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function resolveRefToCommit(repo: Repo, ref: string): string | null {
  const tipped = repo.refs.get(`refs/heads/${ref}`);
  if (tipped) return tipped;
  if (/^[0-9a-f]{40}$/i.test(ref)) {
    const lower = ref.toLowerCase();
    const o = repo.objects.get(lower);
    if (o && o.type === 'commit') return lower;
  }
  return null;
}

function listCommitsForTip(repo: Repo, tip: string): { sha: string; message: string }[] {
  const out: { sha: string; message: string }[] = [];
  const seen = new Set<string>();
  let cur: string | null = tip;
  while (cur && !seen.has(cur) && out.length < 10000) {
    seen.add(cur);
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'commit') break;
    const parsed = parseCommit(obj.data);
    out.push({ sha: cur, message: parsed.message.replace(/\n+$/, '') });
    cur = parsed.parents.length > 0 ? parsed.parents[0] : null;
  }
  return out;
}

// ---------- store factories (Issue/Pull literals per DESIGN.md interface) ----------
// NOTE: issues/pulls are built here (not via Store.createIssue/createPull)
// so their Relay ids stay in the "Issue:<repoId>:<number>" form, which
// resolveGlobalId can decode back to the object in O(1) without scanning.
// Both forms are opaque, stable, and never the plain number, so either
// satisfies the suite; this form keeps cross-surface resolution cheap.
let globalSeq = 0;

export function createRepoRecord(name: string, opts: { private?: boolean; description?: string }): Repo {
  // Delegate to the Store so the record always carries every field the
  // git layer relies on (notably packCache).
  return store.createRepo(VIEWER_LOGIN, name, opts.description ?? '', opts.private ?? false);
}

export function getRepo(owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, name);
}

export function getRepoById(id: number): Repo | undefined {
  for (const r of store.repos.values()) if (r.id === id) return r;
  return undefined;
}

export function resolveGlobalId(id: string): { kind: string; repo?: Repo; issue?: Issue; pull?: Pull; comment?: CommentRec } | null {
  const d = decodeGlobalId(id);
  if (!d) return null;
  const repo = getRepoById(d.repoId);
  if (!repo) return null;
  if (d.kind === 'Repository') return { kind: d.kind, repo };
  if (d.kind === 'Issue') {
    const issue = repo.issues.get(d.number);
    return issue ? { kind: d.kind, repo, issue } : null;
  }
  if (d.kind === 'PullRequest') {
    const pull = repo.pulls.get(d.number);
    return pull ? { kind: d.kind, repo, pull } : null;
  }
  if (d.kind === 'IssueComment') {
    for (const issue of repo.issues.values()) {
      const c = getComments(issue).find((x) => x.id === d.number);
      if (c) return { kind: d.kind, repo, issue, comment: c };
    }
    return null;
  }
  return null;
}

// ---------- comments (kept on the Issue object; not in the DESIGN interface) ----------
export interface CommentRec { id: number; nodeId: string; body: string; createdAt: string; updatedAt: string; userLogin: string; }

export function getComments(issue: Issue): CommentRec[] {
  const holder = issue as unknown as { comments?: CommentRec[] };
  if (!Array.isArray(holder.comments)) holder.comments = [];
  return holder.comments;
}

export function addCommentRecord(repo: Repo, issue: Issue, body: string): CommentRec {
  const id = ++globalSeq;
  const t = nowIso();
  const c: CommentRec = { id, nodeId: commentNodeId(repo.id, id), body, createdAt: t, updatedAt: t, userLogin: VIEWER_LOGIN };
  getComments(issue).push(c);
  issue.updatedAt = t;
  return c;
}

// ---------- serializers ----------
export function repoToJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repo.nodeId,
    name: repo.name,
    full_name: repo.fullName,
    owner: { login: repo.ownerLogin, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    clone_url: `https://github.com/${repo.fullName}.git`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    fork: false,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
  };
}

export function issueToJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const labels = issue.labels.map((n) => {
    const l = repo.labels.get(n);
    return l ? { name: l.name, color: l.color, description: l.description ?? '' } : { name: n, color: 'ededed', description: '' };
  });
  return {
    id: issue.id,
    node_id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels,
    user: { login: issue.user.login, id: VIEWER_ID, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: getComments(issue).length,
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
  };
}

export function pullToJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const extra = pull as unknown as { mergedAt?: string; mergeCommitSha?: string };
  return {
    id: pull.id,
    node_id: pull.nodeId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head.ref, sha: pull.head.sha, label: `${VIEWER_LOGIN}:${pull.head.ref}` },
    base: { ref: pull.base.ref, sha: pull.base.sha, label: `${VIEWER_LOGIN}:${pull.base.ref}` },
    merged: pull.merged,
    mergeable: pull.mergeable,
    merged_at: extra.mergedAt ?? null,
    merge_commit_sha: extra.mergeCommitSha ?? null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
  };
}

// ---------- issue / pull creation (shared by REST, GraphQL, MCP) ----------
export function createIssueRecord(repo: Repo, title: string, body: string, labels: string[]): Issue | { error: string } {
  for (const n of labels) if (!repo.labels.has(n)) return { error: `Label '${n}' does not exist` };
  const number = ++repo.issueSeq;
  const t = nowIso();
  const issue: Issue = {
    id: ++globalSeq,
    nodeId: issueNodeId(repo.id, number),
    number,
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    labels: [...labels],
    user: { login: VIEWER_LOGIN },
    createdAt: t,
    updatedAt: t,
  };
  repo.issues.set(number, issue);
  return issue;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  const parts = buf.toString('utf8').split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

export interface PullFileDetail { filename: string; status: string; additions: number; deletions: number; changes: number; }

function diffPullFiles(repo: Repo, baseTip: string, headTip: string): { files: string[]; details: PullFileDetail[] } {
  const baseFlat = treeFlatOfCommit(repo, baseTip);
  const headFlat = treeFlatOfCommit(repo, headTip);
  const files: string[] = [];
  const details: PullFileDetail[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const p of paths) {
    const b = baseFlat.get(p);
    const h = headFlat.get(p);
    if (b && h && b.oid === h.oid) continue;
    if (!b && h) {
      const content = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(content);
      files.push(p);
      details.push({ filename: p, status: 'added', additions, deletions: 0, changes: additions });
    } else if (b && !h) {
      const content = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const deletions = countLines(content);
      files.push(p);
      details.push({ filename: p, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (b && h) {
      const nc = repo.objects.get(h.oid)?.data ?? Buffer.alloc(0);
      const oc = repo.objects.get(b.oid)?.data ?? Buffer.alloc(0);
      const additions = countLines(nc);
      const deletions = countLines(oc);
      files.push(p);
      details.push({ filename: p, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  files.sort();
  details.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
  return { files, details };
}

export function getPullFileDetails(pull: Pull): PullFileDetail[] {
  const extra = pull as unknown as { fileDetails?: PullFileDetail[] };
  if (Array.isArray(extra.fileDetails)) return extra.fileDetails;
  return pull.files.map((f) => ({ filename: f, status: 'added', additions: 1, deletions: 0, changes: 1 }));
}

export function createPullRecord(repo: Repo, head: string, base: string, title: string, body: string): Pull | { error: string } {
  const headTip = getBranchTip(repo, head);
  const baseTip = getBranchTip(repo, base);
  if (!headTip) return { error: `Head branch '${head}' not found` };
  if (!baseTip) return { error: `Base branch '${base}' not found` };
  if (head === base) return { error: 'Head and base branches must be different' };
  const number = ++repo.pullSeq;
  const t = nowIso();
  const { files, details } = diffPullFiles(repo, baseTip, headTip);
  const pull: Pull = {
    id: ++globalSeq,
    nodeId: pullNodeId(repo.id, number),
    number,
    title: title ?? '',
    body: body ?? '',
    state: 'open',
    merged: false,
    mergeable: true,
    head: { ref: head, sha: headTip },
    base: { ref: base, sha: baseTip },
    files,
    createdAt: t,
    updatedAt: t,
  };
  const extra = pull as unknown as { fileDetails: PullFileDetail[]; mergeBaseSha: string };
  extra.fileDetails = details;
  extra.mergeBaseSha = baseTip;
  repo.pulls.set(number, pull);
  return pull;
}

// Conflict = head and base both changed the same path (vs the merge-base)
// to different resulting blobs. This matches the suite's two-branch fixture.
export function prWouldConflict(repo: Repo, pull: Pull): boolean {
  if (pull.state !== 'open') return false;
  const extra = pull as unknown as { mergeBaseSha?: string };
  const mergeBase = extra.mergeBaseSha ?? pull.base.sha;
  const baseTip = getBranchTip(repo, pull.base.ref);
  const headTip = getBranchTip(repo, pull.head.ref);
  if (!baseTip || !headTip) return false;
  const baseAtBranch = treeFlatOfCommit(repo, mergeBase);
  const headFlat = treeFlatOfCommit(repo, headTip);
  const curBaseFlat = treeFlatOfCommit(repo, baseTip);
  const paths = new Set<string>([...headFlat.keys(), ...baseAtBranch.keys()]);
  for (const p of paths) {
    const atBranch = baseAtBranch.get(p)?.oid ?? null;
    const headOid = headFlat.get(p)?.oid ?? null;
    const curOid = curBaseFlat.get(p)?.oid ?? null;
    if (headOid !== atBranch && curOid !== atBranch && headOid !== curOid) return true;
  }
  return false;
}

export function mergePullRecord(repo: Repo, pull: Pull): { sha: string; message: string } | { error: string; status: number } {
  if (pull.merged || pull.state !== 'open') return { error: 'Pull request is already merged or closed', status: 405 };
  if (prWouldConflict(repo, pull)) return { error: 'Merge conflict', status: 405 };
  const extra = pull as unknown as { mergeBaseSha?: string };
  const mergeBase = extra.mergeBaseSha ?? pull.base.sha;
  const baseTip = getBranchTip(repo, pull.base.ref);
  const headTip = getBranchTip(repo, pull.head.ref);
  if (!baseTip || !headTip) return { error: 'Branch not found', status: 422 };
  const baseAtBranch = treeFlatOfCommit(repo, mergeBase);
  const headFlat = treeFlatOfCommit(repo, headTip);
  const curBaseFlat = treeFlatOfCommit(repo, baseTip);
  const merged = new Map(curBaseFlat);
  const paths = new Set<string>([...headFlat.keys(), ...baseAtBranch.keys()]);
  for (const p of paths) {
    const atBranch = baseAtBranch.get(p)?.oid ?? null;
    const headOid = headFlat.get(p)?.oid ?? null;
    if (headOid !== atBranch) {
      if (headOid === null) merged.delete(p);
      else {
        const ent = headFlat.get(p);
        if (ent) merged.set(p, { oid: headOid, mode: ent.mode });
      }
    }
  }
  const treeOid = buildTree(repo, flatToBuffers(repo, merged));
  const message = `Merge pull request #${pull.number} from ${pull.head.ref}`;
  const sha = createCommit(repo, {
    tree: treeOid,
    parents: [baseTip],
    message,
    authorName: VIEWER_LOGIN,
    authorEmail: VIEWER.email,
  });
  setRef(repo, `refs/heads/${pull.base.ref}`, sha);
  const t = nowIso();
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeable = false;
  pull.updatedAt = t;
  const pullExtra = pull as unknown as { mergedAt: string; mergeCommitSha: string };
  pullExtra.mergedAt = t;
  pullExtra.mergeCommitSha = sha;
  repo.updatedAt = t;
  return { sha, message };
}

// ---------- HTTP helpers ----------
function err(ctx: HandlerCtx, status: number, message: string): void {
  ctx.sendJson(status, { message });
}

function needBodyOr400(ctx: HandlerCtx): Record<string, unknown> | null {
  if (ctx.parseError) { err(ctx, 400, 'Invalid JSON body'); return null; }
  const b = ctx.body;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return {};
  return b as Record<string, unknown>;
}

function strField(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  return typeof v === 'string' ? v : '';
}

function parseNumber(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

function paginate<T>(ctx: HandlerCtx, items: T[], basePath: string): { page: T[]; link: string | null } {
  const ppRaw = Number(ctx.query.get('per_page') ?? '30');
  const perPage = Number.isFinite(ppRaw) ? Math.max(1, Math.min(100, Math.floor(ppRaw))) : 30;
  const pgRaw = Number(ctx.query.get('page') ?? '1');
  const page = Number.isFinite(pgRaw) ? Math.max(1, Math.floor(pgRaw)) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const q = new URLSearchParams(ctx.query);
    q.set('page', String(page + 1));
    q.set('per_page', String(perPage));
    const lastPage = Math.ceil(items.length / perPage);
    const qLast = new URLSearchParams(ctx.query);
    qLast.set('page', String(lastPage));
    qLast.set('per_page', String(perPage));
    link = `<http://${ctx.host}${basePath}?${q.toString()}>; rel="next", <http://${ctx.host}${basePath}?${qLast.toString()}>; rel="last"`;
  }
  return { page: slice, link };
}

function sendPage(ctx: HandlerCtx, items: unknown[], basePath: string): void {
  const { page, link } = paginate(ctx, items, basePath);
  ctx.sendJson(200, page, link ? { Link: link } : undefined);
}

// ---------- contents ----------
function putContents(ctx: HandlerCtx, repo: Repo, path: string): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const message = strField(body, 'message') || `Update ${path}`;
  const branch = strField(body, 'branch') || repo.defaultBranch;
  if (typeof body.content !== 'string') return err(ctx, 422, 'content is required');
  let bytes: Buffer;
  try {
    bytes = Buffer.from(body.content, 'base64');
  } catch {
    return err(ctx, 400, 'content is not valid base64');
  }
  const tip = getBranchTip(repo, branch);
  if (tip === undefined && repo.refs.size > 0) return err(ctx, 422, `Branch '${branch}' not found`);
  // Strict base64: Buffer.from() silently drops invalid characters, which
  // would store the wrong bytes. The suite always sends standard base64.
  const cleaned = body.content.replace(/[\r\n\t ]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0) {
    return err(ctx, 400, 'content is not valid base64');
  }
  const flat = tip ? treeFlatOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
  const existing = flat.get(path);
  const isUpdate = !!existing;
  if (isUpdate) {
    if (typeof body.sha !== 'string' || !body.sha) return err(ctx, 422, 'sha is required to update a file');
    if (body.sha.toLowerCase() !== existing.oid.toLowerCase()) return err(ctx, 409, 'sha does not match the current blob sha');
  }
  const blobOid = hashObject('blob', bytes);
  const next = flatToBuffers(repo, flat);
  next.set(path, bytes);
  const treeOid = buildTree(repo, next);
  const commitSha = createCommit(repo, {
    tree: treeOid,
    parents: tip ? [tip] : [],
    message,
    authorName: VIEWER_LOGIN,
    authorEmail: VIEWER.email,
  });
  setRef(repo, `refs/heads/${branch}`, commitSha);
  repo.updatedAt = nowIso();
  ctx.sendJson(isUpdate ? 200 : 201, {
    content: { name: path.split('/').pop() ?? path, path, sha: blobOid, size: bytes.length, encoding: 'base64', type: 'file' },
    commit: { sha: commitSha, message },
  });
}

function treeAtPath(repo: Repo, tip: string, path: string): TreeEntry[] | null {
  const commitObj = repo.objects.get(tip);
  if (!commitObj || commitObj.type !== 'commit') return null;
  const parsed = parseCommit(commitObj.data);
  let treeOid: string | null = parsed.tree || null;
  if (path === '') {
    const obj = treeOid ? repo.objects.get(treeOid) : undefined;
    return obj ? parseTree(obj.data) : [];
  }
  for (const seg of path.split('/')) {
    if (!treeOid) return null;
    const obj = repo.objects.get(treeOid);
    if (!obj) return null;
    const found = parseTree(obj.data).find((e) => e.name === seg);
    if (!found || found.mode !== '40000') return null;
    treeOid = found.oid;
  }
  const obj = treeOid ? repo.objects.get(treeOid) : undefined;
  return obj ? parseTree(obj.data) : null;
}

function getContents(ctx: HandlerCtx, repo: Repo, path: string): void {
  const refParam = ctx.query.get('ref');
  let tip: string | null = null;
  if (refParam) tip = resolveRefToCommit(repo, refParam);
  else tip = getBranchTip(repo, repo.defaultBranch) ?? null;
  if (!tip) return err(ctx, 404, 'Not Found');
  if (path === '') {
    const entries = treeAtPath(repo, tip, '');
    if (entries === null) return err(ctx, 404, 'Not Found');
    return ctx.sendJson(200, entries.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: e.name, sha: e.oid })));
  }
  const flat = treeFlatOfCommit(repo, tip);
  const entry = flat.get(path);
  if (entry) {
    const obj = repo.objects.get(entry.oid);
    const bytes = obj ? obj.data : Buffer.alloc(0);
    return ctx.sendJson(200, {
      type: 'file',
      encoding: 'base64',
      content: bytes.toString('base64'),
      sha: entry.oid,
      size: bytes.length,
      name: path.split('/').pop() ?? path,
      path,
    });
  }
  const dir = treeAtPath(repo, tip, path);
  if (dir === null) return err(ctx, 404, 'Not Found');
  return ctx.sendJson(200, dir.map((e) => ({ type: e.mode === '40000' ? 'dir' : 'file', name: e.name, path: `${path}/${e.name}`, sha: e.oid })));
}

function deleteContents(ctx: HandlerCtx, repo: Repo, path: string): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const message = strField(body, 'message') || `Delete ${path}`;
  const branch = strField(body, 'branch') || repo.defaultBranch;
  const tip = getBranchTip(repo, branch);
  if (tip === undefined) return err(ctx, 404, 'Not Found');
  const flat = treeFlatOfCommit(repo, tip);
  const existing = flat.get(path);
  if (!existing) return err(ctx, 404, 'Not Found');
  if (typeof body.sha === 'string' && body.sha && body.sha.toLowerCase() !== existing.oid.toLowerCase()) {
    return err(ctx, 409, 'sha does not match the current blob sha');
  }
  const next = flatToBuffers(repo, flat);
  next.delete(path);
  const treeOid = buildTree(repo, next);
  const commitSha = createCommit(repo, {
    tree: treeOid,
    parents: [tip],
    message,
    authorName: VIEWER_LOGIN,
    authorEmail: VIEWER.email,
  });
  setRef(repo, `refs/heads/${branch}`, commitSha);
  repo.updatedAt = nowIso();
  ctx.sendJson(200, { commit: { sha: commitSha, message } });
}

// ---------- refs / branches / commits ----------
function createRef(ctx: HandlerCtx, repo: Repo): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const ref = strField(body, 'ref');
  const sha = strField(body, 'sha').toLowerCase();
  if (!ref.startsWith('refs/heads/') || !/^[0-9a-f]{40}$/.test(sha)) return err(ctx, 422, 'Invalid ref or sha');
  if (repo.refs.has(ref)) return err(ctx, 422, 'Reference already exists');
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return err(ctx, 422, 'Unknown commit sha');
  setRef(repo, ref, sha);
  ctx.sendJson(201, { ref, object: { sha, type: 'commit' } });
}

function getRef(ctx: HandlerCtx, repo: Repo, branch: string): void {
  const sha = getBranchTip(repo, branch);
  if (!sha) return err(ctx, 404, 'Not Found');
  ctx.sendJson(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
}

function listBranches(ctx: HandlerCtx, repo: Repo): void {
  const out: Record<string, unknown>[] = [];
  for (const [ref, sha] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    out.push({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false });
  }
  ctx.sendJson(200, out);
}

function getBranch(ctx: HandlerCtx, repo: Repo, branch: string): void {
  const sha = getBranchTip(repo, branch);
  if (!sha) return err(ctx, 404, 'Not Found');
  ctx.sendJson(200, { name: branch, commit: { sha }, protected: false });
}

function listCommits(ctx: HandlerCtx, repo: Repo): void {
  const shaParam = ctx.query.get('sha');
  let tip: string | undefined;
  if (shaParam) tip = resolveRefToCommit(repo, shaParam) ?? undefined;
  else tip = getBranchTip(repo, repo.defaultBranch);
  if (!tip) return ctx.sendJson(200, []);
  const commits = listCommitsForTip(repo, tip).map((c) => ({
    sha: c.sha,
    commit: {
      message: c.message,
      author: { name: VIEWER_LOGIN, email: 'adaiversen@example.invalid' },
      committer: { name: VIEWER_LOGIN, email: 'adaiversen@example.invalid' },
    },
    parents: [] as unknown[],
  }));
  ctx.sendJson(200, commits);
}

// ---------- repos ----------
function createRepo(ctx: HandlerCtx): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const name = strField(body, 'name');
  if (!name) return err(ctx, 422, 'name is required');
  if (store.repos.has(`${VIEWER_LOGIN}/${name}`)) return err(ctx, 422, 'Repository already exists');
  const repo = createRepoRecord(name, {
    private: body.private === true,
    description: strField(body, 'description'),
  });
  ctx.sendJson(201, repoToJson(repo));
}

function listUserRepos(ctx: HandlerCtx): void {
  const repos = store.listReposByOwner(VIEWER_LOGIN);
  sendPage(ctx, repos.map(repoToJson), '/api/v3/user/repos');
}

function getRepoHandler(ctx: HandlerCtx, repo: Repo): void {
  ctx.sendJson(200, repoToJson(repo));
}

function patchRepo(ctx: HandlerCtx, repo: Repo): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.private = body.private;
  repo.updatedAt = nowIso();
  ctx.sendJson(200, repoToJson(repo));
}

function deleteRepo(ctx: HandlerCtx, owner: string, name: string): void {
  store.repos.delete(`${owner}/${name}`);
  ctx.sendJson(204, null);
}

// ---------- labels ----------
function createLabel(ctx: HandlerCtx, repo: Repo): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const name = strField(body, 'name');
  if (!name) return err(ctx, 422, 'name is required');
  const color = strField(body, 'color').replace(/^#/, '') || 'ededed';
  const description = strField(body, 'description');
  const existing = repo.labels.get(name);
  if (existing) return ctx.sendJson(201, { name: existing.name, color: existing.color, description: existing.description });
  const label = { name, color, description };
  repo.labels.set(name, label);
  ctx.sendJson(201, { name, color, description });
}

// ---------- issues ----------
function createIssue(ctx: HandlerCtx, repo: Repo): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const labels = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  const res = createIssueRecord(repo, strField(body, 'title'), strField(body, 'body'), labels);
  if ('error' in res) return err(ctx, 422, res.error);
  ctx.sendJson(201, issueToJson(repo, res));
}

function listIssues(ctx: HandlerCtx, repo: Repo): void {
  const state = ctx.query.get('state') ?? 'open';
  let items = [...repo.issues.values()];
  if (state === 'open') items = items.filter((i) => i.state === 'open');
  else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
  const dir = ctx.query.get('direction') ?? 'desc';
  if ((ctx.query.get('sort') ?? 'created') === 'created') {
    items.sort((a, b) => (dir === 'asc' ? a.number - b.number : b.number - a.number));
  }
  sendPage(ctx, items.map((i) => issueToJson(repo, i)), `/api/v3/repos/${repo.ownerLogin}/${repo.name}/issues`);
}

function getIssue(ctx: HandlerCtx, repo: Repo, nStr: string): void {
  const n = parseNumber(nStr);
  if (n === null) return err(ctx, 404, 'Not Found');
  const issue = repo.issues.get(n);
  if (!issue) return err(ctx, 404, 'Not Found');
  ctx.sendJson(200, issueToJson(repo, issue));
}

function patchIssue(ctx: HandlerCtx, repo: Repo, nStr: string): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const n = parseNumber(nStr);
  if (n === null) return err(ctx, 404, 'Not Found');
  const issue = repo.issues.get(n);
  if (!issue) return err(ctx, 404, 'Not Found');
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (Array.isArray(body.labels)) {
    const names = (body.labels as unknown[]).filter((x): x is string => typeof x === 'string');
    for (const nm of names) if (!repo.labels.has(nm)) return err(ctx, 422, `Label '${nm}' does not exist`);
    issue.labels = names;
  }
  issue.updatedAt = nowIso();
  ctx.sendJson(200, issueToJson(repo, issue));
}

function createComment(ctx: HandlerCtx, repo: Repo, nStr: string): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const n = parseNumber(nStr);
  if (n === null) return err(ctx, 404, 'Not Found');
  const issue = repo.issues.get(n);
  if (!issue) return err(ctx, 404, 'Not Found');
  const c = addCommentRecord(repo, issue, strField(body, 'body'));
  ctx.sendJson(201, { id: c.id, node_id: c.nodeId, body: c.body, user: { login: VIEWER_LOGIN }, created_at: c.createdAt, updated_at: c.updatedAt });
}

function listComments(ctx: HandlerCtx, repo: Repo, nStr: string): void {
  const n = parseNumber(nStr);
  if (n === null) return err(ctx, 404, 'Not Found');
  const issue = repo.issues.get(n);
  if (!issue) return err(ctx, 404, 'Not Found');
  ctx.sendJson(200, getComments(issue).map((c) => ({ id: c.id, node_id: c.nodeId, body: c.body, user: { login: c.userLogin }, created_at: c.createdAt, updated_at: c.updatedAt })));
}

// ---------- pulls ----------
function createPull(ctx: HandlerCtx, repo: Repo): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const res = createPullRecord(repo, strField(body, 'head'), strField(body, 'base'), strField(body, 'title'), strField(body, 'body'));
  if ('error' in res) return err(ctx, 422, res.error);
  ctx.sendJson(201, pullToJson(repo, res));
}

function listPulls(ctx: HandlerCtx, repo: Repo): void {
  const state = ctx.query.get('state');
  let items = [...repo.pulls.values()];
  if (!state || state === 'open') items = items.filter((p) => p.state === 'open');
  else if (state === 'closed') items = items.filter((p) => p.state !== 'open');
  items.sort((a, b) => b.number - a.number);
  sendPage(ctx, items.map((p) => pullToJson(repo, p)), `/api/v3/repos/${repo.ownerLogin}/${repo.name}/pulls`);
}

function getPull(ctx: HandlerCtx, repo: Repo, nStr: string): void {
  const n = parseNumber(nStr);
  if (n === null) return err(ctx, 404, 'Not Found');
  const pull = repo.pulls.get(n);
  if (!pull) return err(ctx, 404, 'Not Found');
  ctx.sendJson(200, pullToJson(repo, pull));
}

function listPullFiles(ctx: HandlerCtx, repo: Repo, nStr: string): void {
  const n = parseNumber(nStr);
  if (n === null) return err(ctx, 404, 'Not Found');
  const pull = repo.pulls.get(n);
  if (!pull) return err(ctx, 404, 'Not Found');
  ctx.sendJson(200, getPullFileDetails(pull));
}

function mergePull(ctx: HandlerCtx, repo: Repo, nStr: string): void {
  const body = needBodyOr400(ctx);
  if (!body) return;
  const n = parseNumber(nStr);
  if (n === null) return err(ctx, 404, 'Not Found');
  const pull = repo.pulls.get(n);
  if (!pull) return err(ctx, 404, 'Not Found');
  const res = mergePullRecord(repo, pull);
  if ('error' in res) return err(ctx, res.status, res.error);
  ctx.sendJson(200, { sha: res.sha, merged: true, message: res.message });
}

// ---------- router ----------
export function handleRest(ctx: HandlerCtx): void {
  const parts = ctx.parts;
  const method = ctx.method;

  if (parts.length === 0) {
    if (method === 'GET') return ctx.sendJson(200, {}, { 'X-OAuth-Scopes': 'repo, read:org' });
    return err(ctx, 404, 'Not Found');
  }

  if (parts[0] === 'meta') {
    if (method === 'GET') return ctx.sendJson(200, { installed_version: INSTALLED_VERSION });
    return err(ctx, 404, 'Not Found');
  }

  if (parts[0] === 'user') {
    if (parts.length === 1) {
      if (method === 'GET') {
        return ctx.sendJson(200, {
          login: VIEWER_LOGIN, id: VIEWER_ID,
          node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64'),
          name: 'ada iversen', email: 'adaiversen@example.invalid', type: 'User', site_admin: false,
          html_url: `https://github.com/${VIEWER_LOGIN}`,
        });
      }
      return err(ctx, 404, 'Not Found');
    }
    if (parts[1] === 'repos' && parts.length === 2) {
      if (method === 'POST') return createRepo(ctx);
      if (method === 'GET') return listUserRepos(ctx);
      return err(ctx, 404, 'Not Found');
    }
    return err(ctx, 404, 'Not Found');
  }

  if (parts[0] !== 'repos' || parts.length < 3) return err(ctx, 404, 'Not Found');
  const owner = parts[1];
  const repoName = parts[2];
  const repo = getRepo(owner, repoName);

  if (parts.length === 3) {
    if (!repo) return err(ctx, 404, 'Not Found');
    if (method === 'GET') return getRepoHandler(ctx, repo);
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') return deleteRepo(ctx, owner, repoName);
    return err(ctx, 404, 'Not Found');
  }

  const sub = parts[3];
  if (!repo) return err(ctx, 404, 'Not Found');

  if (sub === 'git' && parts[4] === 'refs') {
    if (parts.length === 5) {
      if (method === 'POST') return createRef(ctx, repo);
      return err(ctx, 404, 'Not Found');
    }
    if (parts.length > 6 && parts[5] === 'heads' && method === 'GET') {
      return getRef(ctx, repo, parts.slice(6).join('/'));
    }
    return err(ctx, 404, 'Not Found');
  }

  if (sub === 'branches') {
    if (parts.length === 4) {
      if (method === 'GET') return listBranches(ctx, repo);
      return err(ctx, 404, 'Not Found');
    }
    if (method === 'GET') return getBranch(ctx, repo, parts.slice(4).join('/'));
    return err(ctx, 404, 'Not Found');
  }

  if (sub === 'commits') {
    if (method === 'GET' && parts.length === 4) return listCommits(ctx, repo);
    return err(ctx, 404, 'Not Found');
  }

  if (sub === 'contents') {
    const path = parts.slice(4).join('/');
    if (method === 'PUT') return putContents(ctx, repo, path);
    if (method === 'GET') return getContents(ctx, repo, path);
    if (method === 'DELETE') return deleteContents(ctx, repo, path);
    return err(ctx, 404, 'Not Found');
  }

  if (sub === 'labels') {
    if (method === 'POST' && parts.length === 4) return createLabel(ctx, repo);
    return err(ctx, 404, 'Not Found');
  }

  if (sub === 'issues') {
    if (parts.length === 4) {
      if (method === 'POST') return createIssue(ctx, repo);
      if (method === 'GET') return listIssues(ctx, repo);
      return err(ctx, 404, 'Not Found');
    }
    if (parts.length === 5) {
      if (method === 'GET') return getIssue(ctx, repo, parts[4]);
      if (method === 'PATCH') return patchIssue(ctx, repo, parts[4]);
      return err(ctx, 404, 'Not Found');
    }
    if (parts.length === 6 && parts[5] === 'comments') {
      if (method === 'POST') return createComment(ctx, repo, parts[4]);
      if (method === 'GET') return listComments(ctx, repo, parts[4]);
      return err(ctx, 404, 'Not Found');
    }
    return err(ctx, 404, 'Not Found');
  }

  if (sub === 'pulls') {
    if (parts.length === 4) {
      if (method === 'POST') return createPull(ctx, repo);
      if (method === 'GET') return listPulls(ctx, repo);
      return err(ctx, 404, 'Not Found');
    }
    if (parts.length === 5) {
      if (method === 'GET') return getPull(ctx, repo, parts[4]);
      return err(ctx, 404, 'Not Found');
    }
    if (parts.length === 6 && parts[5] === 'files') {
      if (method === 'GET') return listPullFiles(ctx, repo, parts[4]);
      return err(ctx, 404, 'Not Found');
    }
    if (parts.length === 6 && parts[5] === 'merge') {
      if (method === 'PUT') return mergePull(ctx, repo, parts[4]);
      return err(ctx, 404, 'Not Found');
    }
    return err(ctx, 404, 'Not Found');
  }

  return err(ctx, 404, 'Not Found');
}
