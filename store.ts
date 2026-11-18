// store.ts — in-memory store + deterministic clock + git object helpers.
//
// Single source of truth shared by the REST/GraphQL/MCP layers and the git
// layer. Everything in memory; no I/O. All timestamps come from the
// deterministic clock (epoch 1700000000 + tick seconds) — never Date.now()
// or Math.random() in any response or commit, so SHAs are stable across
// live/replay runs.

import { createHash } from 'node:crypto';

export type Oid = string; // 40-hex lowercase sha1
export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer; // raw content, no "<type> <len>\0" header
}

export const ZERO_OID: Oid = '0000000000000000000000000000000000000000';
export const EPOCH_SEC = 1700000000;

/** Token-owner identity, fixed by the suite scenario (see DESIGN.md). */
export const VIEWER = {
  login: 'adaiversen',
  id: 1000,
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;
export const ORG_LOGIN = 'faint-meadow-org';
export const STRANGER = {
  login: 'olgabauer',
  id: 1002,
  name: 'olga bauer',
  email: 'olgabauer@example.invalid',
} as const;

// ---------------------------------------------------------------------------
// Deterministic clock
// ---------------------------------------------------------------------------

let tick = 0;

/** Advance the clock by one second and return the tick just consumed. */
export function nextTick(): number {
  return tick++;
}

/** ISO timestamp from the deterministic clock (advances one second). */
export function nowIso(): string {
  return new Date((EPOCH_SEC + nextTick()) * 1000).toISOString();
}

/** Epoch seconds from the deterministic clock (advances one second). */
export function nowEpochSec(): number {
  return EPOCH_SEC + nextTick();
}

// ---------------------------------------------------------------------------
// Object hashing
// ---------------------------------------------------------------------------

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** SHA-1 of "<type> <len>\0<content>". */
export function hashObject(type: GitObjectType, data: Buffer): Oid {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Store an object in the repo (idempotent) and return its oid. */
export function storeObject(repo: Repo, type: GitObjectType, data: Buffer): Oid {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** Drop cached generated packs (call whenever any ref moves). */
export function invalidatePackCache(repo: Repo): void {
  repo.packCache.clear();
}

/** Move a ref and drop cached packs. Use for every ref mutation. */
export function setRef(repo: Repo, ref: string, oid: Oid): void {
  repo.refs.set(ref, oid);
  invalidatePackCache(repo);
}

/** Delete a ref and drop cached packs. */
export function deleteRef(repo: Repo, ref: string): void {
  repo.refs.delete(ref);
  invalidatePackCache(repo);
}

/** Oid of the default branch tip, or undefined when the repo is unborn. */
export function headOid(repo: Repo): Oid | undefined {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
}

// ---------------------------------------------------------------------------
// Repo / Issue / Pull
// ---------------------------------------------------------------------------

export interface Repo {
  id: number; // databaseId, sequential from 1
  nodeId: string; // base64("Repository:<id>")
  name: string;
  ownerLogin: string;
  fullName: string; // "owner/name"
  description: string;
  private: boolean;
  defaultBranch: string; // "main"
  refs: Map<string, Oid>; // "refs/heads/main" -> oid
  objects: Map<Oid, GitObject>;
  labels: Map<string, { name: string; color: string; description: string }>;
  issues: Map<number, Issue>;
  issueSeq: number;
  pulls: Map<number, Pull>;
  pullSeq: number;
  createdAt: string;
  updatedAt: string;
  /** Generated-pack cache: key `${owner}/${name}:${tipOid}:depth${n}`. */
  packCache: Map<string, Buffer>;
}

export interface Issue {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  user: { login: string };
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  files: string[];
  createdAt: string;
  updatedAt: string;
}

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

function b64(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}

export class Store {
  repos = new Map<string, Repo>();
  private repoSeq = 0;
  private issueIdSeq = 0;
  private pullIdSeq = 0;

  createRepo(ownerLogin: string, name: string, description = '', isPrivate = false): Repo {
    const id = ++this.repoSeq;
    const now = nowIso();
    const repo: Repo = {
      id,
      nodeId: b64(`Repository:${id}`),
      name,
      ownerLogin,
      fullName: `${ownerLogin}/${name}`,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: new Map(),
      issueSeq: 0,
      pulls: new Map(),
      pullSeq: 0,
      createdAt: now,
      updatedAt: now,
      packCache: new Map(),
    };
    this.repos.set(repoKey(ownerLogin, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(repoKey(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.ownerLogin === owner) out.push(repo);
    }
    return out;
  }

  createIssue(
    repo: Repo,
    opts: { title: string; body?: string; labels?: string[]; userLogin?: string },
  ): Issue {
    const id = ++this.issueIdSeq;
    const number = ++repo.issueSeq;
    const now = nowIso();
    const issue: Issue = {
      id,
      nodeId: b64(`Issue:${id}`),
      number,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      labels: opts.labels ? [...opts.labels] : [],
      user: { login: opts.userLogin ?? VIEWER.login },
      createdAt: now,
      updatedAt: now,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(
    repo: Repo,
    opts: {
      title: string;
      body?: string;
      headRef: string;
      headSha: string;
      baseRef: string;
      baseSha: string;
      files?: string[];
    },
  ): Pull {
    const id = ++this.pullIdSeq;
    const number = ++repo.pullSeq;
    const now = nowIso();
    const pull: Pull = {
      id,
      nodeId: b64(`PullRequest:${id}`),
      number,
      title: opts.title,
      body: opts.body ?? '',
      state: 'open',
      merged: false,
      mergeable: true,
      head: { ref: opts.headRef, sha: opts.headSha },
      base: { ref: opts.baseRef, sha: opts.baseSha },
      files: opts.files ? [...opts.files] : [],
      createdAt: now,
      updatedAt: now,
    };
    repo.pulls.set(number, pull);
    return pull;
  }
}

// ---------------------------------------------------------------------------
// Commit / tree / tag creation helpers (used by contents PUT and merges)
// ---------------------------------------------------------------------------

export interface CreateCommitOpts {
  tree: Oid;
  parents?: Oid[];
  message: string;
  authorName: string;
  authorEmail: string;
  committerName?: string;
  committerEmail?: string;
}

/**
 * Create a commit object with FIXED deterministic timestamps
 * (epoch 1700000000 + tick seconds, +0000) and store it. Returns the oid.
 * The message is stored verbatim.
 */
export function createCommit(repo: Repo, opts: CreateCommitOpts): Oid {
  const epoch = EPOCH_SEC + nextTick();
  const authorName = opts.authorName;
  const authorEmail = opts.authorEmail;
  const committerName = opts.committerName ?? authorName;
  const committerEmail = opts.committerEmail ?? authorEmail;
  let content = `tree ${opts.tree}\n`;
  for (const parent of opts.parents ?? []) content += `parent ${parent}\n`;
  content += `author ${authorName} <${authorEmail}> ${epoch} +0000\n`;
  content += `committer ${committerName} <${committerEmail}> ${epoch} +0000\n`;
  content += `\n${opts.message}`;
  return storeObject(repo, 'commit', Buffer.from(content, 'utf8'));
}

export interface CreateTagOpts {
  object: Oid;
  type: GitObjectType;
  tag: string;
  message: string;
  taggerName: string;
  taggerEmail: string;
}

/** Create an annotated tag object with deterministic timestamps. */
export function createTag(repo: Repo, opts: CreateTagOpts): Oid {
  const epoch = EPOCH_SEC + nextTick();
  const content =
    `object ${opts.object}\n` +
    `type ${opts.type}\n` +
    `tag ${opts.tag}\n` +
    `tagger ${opts.taggerName} <${opts.taggerEmail}> ${epoch} +0000\n` +
    `\n${opts.message}`;
  return storeObject(repo, 'tag', Buffer.from(content, 'utf8'));
}

interface DirNode {
  files: Map<string, Buffer>;
  dirs: Map<string, DirNode>;
}

function gitTreeSortKey(name: string, isDir: boolean): string {
  return isDir ? `${name}/` : name;
}

/** Compare two tree entry names the way git does (dirs sort as name + '/'). */
function compareTreeEntries(
  a: { name: string; isDir: boolean },
  b: { name: string; isDir: boolean },
): number {
  const ka = gitTreeSortKey(a.name, a.isDir);
  const kb = gitTreeSortKey(b.name, b.isDir);
  if (ka < kb) return -1;
  if (ka > kb) return 1;
  return 0;
}

function buildTreeRecursive(repo: Repo, node: DirNode): Oid {
  interface Entry {
    mode: string;
    name: string;
    isDir: boolean;
    oid: Oid;
  }
  const entries: Entry[] = [];
  for (const [name, data] of node.files) {
    entries.push({ mode: '100644', name, isDir: false, oid: storeObject(repo, 'blob', data) });
  }
  for (const [name, sub] of node.dirs) {
    entries.push({ mode: '40000', name, isDir: true, oid: buildTreeRecursive(repo, sub) });
  }
  entries.sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return storeObject(repo, 'tree', Buffer.concat(parts));
}

/**
 * Build a nested tree from a flat path -> content map (paths use '/').
 * Creates blob + tree objects in the repo. Returns the root tree oid.
 * An empty map yields the empty tree.
 */
export function buildTree(repo: Repo, files: Map<string, Buffer>): Oid {
  const root: DirNode = { files: new Map(), dirs: new Map() };
  for (const [path, data] of files) {
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) continue;
    let node = root;
    for (let i = 0; i < segments.length - 1; i++) {
      let sub = node.dirs.get(segments[i]);
      if (sub === undefined) {
        sub = { files: new Map(), dirs: new Map() };
        node.dirs.set(segments[i], sub);
      }
      node = sub;
    }
    node.files.set(segments[segments.length - 1], data);
  }
  return buildTreeRecursive(repo, root);
}
