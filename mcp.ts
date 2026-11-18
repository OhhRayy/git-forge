// mcp.ts — MCP JSON-RPC 2.0 over Streamable HTTP (spec-graphql-mcp.md Part B).
// Both eras: modern 2026-07-28 via `server/discover`, and the legacy
// handshake via `initialize` + `notifications/initialized`.
// Stateless per request; JSON-RPC ids are echoed verbatim. All tools act
// on the same store as REST/GraphQL via rest.ts helpers.

import {
  getRepo, createRepoRecord, createIssueRecord, createPullRecord,
  mergePullRecord, repoToJson, issueToJson, pullToJson, VIEWER_LOGIN,
} from './rest.ts';
import type { HandlerCtx } from './rest.ts';

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

// Built once at module load; the same object is serialized on every
// tools/list call, so two consecutive calls are byte-identical.
const TOOLS: Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        owner: { type: 'string', description: 'Owner login' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch to a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with the squash method.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// The suite calls tools by their listed name, but match tolerantly
// (lowercase, non-alphanumerics stripped) so a client sending e.g.
// `createIssue` or `create-issue` still resolves to the canonical tool.
function normalizeToolName(n: string): string {
  return n.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function resolveToolName(name: string): string | null {
  if (!name) return null;
  for (const t of TOOLS) if (t.name === name) return name;
  const norm = normalizeToolName(name);
  for (const t of TOOLS) {
    if (typeof t.name === 'string' && normalizeToolName(t.name) === norm) return t.name;
  }
  return null;
}

function strArg(a: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = a[k];
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function toolOk(obj: unknown): Record<string, unknown> {
  const text = JSON.stringify(obj);
  return { content: [{ type: 'text', text }], structuredContent: obj };
}

function toolErr(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function callTool(name: string, args: unknown): Record<string, unknown> {
  const a: Record<string, unknown> = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
  switch (name) {
    case 'create_repo': {
      const repoName = strArg(a, 'name', 'repo', 'repository');
      if (!repoName) return toolErr('Missing required argument: name');
      const owner = strArg(a, 'owner') || VIEWER_LOGIN;
      if (owner !== VIEWER_LOGIN) return toolErr(`Unknown owner '${owner}'`);
      if (getRepo(owner, repoName)) return toolErr('Repository already exists');
      const repo = createRepoRecord(repoName, {
        private: a.private === true,
        description: typeof a.description === 'string' ? a.description : '',
      });
      return toolOk(repoToJson(repo));
    }
    case 'get_repo': {
      const owner = strArg(a, 'owner');
      const repoName = strArg(a, 'repo', 'repository');
      if (!owner || !repoName) return toolErr('Missing required arguments: owner, repo');
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErr('Repository not found');
      return toolOk(repoToJson(repo));
    }
    case 'create_issue': {
      const owner = strArg(a, 'owner');
      const repoName = strArg(a, 'repo', 'repository');
      const title = strArg(a, 'title');
      if (!owner || !repoName || !title) return toolErr('Missing required arguments: owner, repo, title');
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErr('Repository not found');
      const res = createIssueRecord(repo, title, typeof a.body === 'string' ? a.body : '', []);
      if ('error' in res) return toolErr(res.error);
      return toolOk(issueToJson(repo, res));
    }
    case 'list_issues': {
      const owner = strArg(a, 'owner');
      const repoName = strArg(a, 'repo', 'repository');
      if (!owner || !repoName) return toolErr('Missing required arguments: owner, repo');
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErr('Repository not found');
      const state = typeof a.state === 'string' ? a.state.toLowerCase() : 'open';
      let items = [...repo.issues.values()];
      if (state === 'open') items = items.filter((i) => i.state === 'open');
      else if (state === 'closed') items = items.filter((i) => i.state === 'closed');
      return toolOk(items.map((i) => issueToJson(repo, i)));
    }
    case 'create_pull_request': {
      const owner = strArg(a, 'owner');
      const repoName = strArg(a, 'repo', 'repository');
      const title = strArg(a, 'title');
      const head = strArg(a, 'head', 'head_ref', 'head_branch');
      const base = strArg(a, 'base', 'base_ref', 'base_branch');
      if (!owner || !repoName || !title || !head || !base) {
        return toolErr('Missing required arguments: owner, repo, title, head, base');
      }
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErr('Repository not found');
      const res = createPullRecord(repo, head, base, title, typeof a.body === 'string' ? a.body : '');
      if ('error' in res) return toolErr(res.error);
      const obj = pullToJson(repo, res) as Record<string, unknown>;
      obj.pull_number = res.number;
      return toolOk(obj);
    }
    case 'merge_pull_request': {
      const owner = strArg(a, 'owner');
      const repoName = strArg(a, 'repo', 'repository');
      const raw = a.pull_number ?? a.pull_request_number ?? a.number;
      const n = typeof raw === 'number' ? raw : (typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN);
      if (!owner || !repoName || !Number.isInteger(n)) {
        return toolErr('Missing required arguments: owner, repo, pull_number');
      }
      const repo = getRepo(owner, repoName);
      if (!repo) return toolErr('Repository not found');
      const pull = repo.pulls.get(n);
      if (!pull) return toolErr('Pull request not found');
      const res = mergePullRecord(repo, pull);
      if ('error' in res) return toolErr(res.error);
      return toolOk({ merged: true, sha: res.sha, number: n, pull_number: n, message: res.message });
    }
    default:
      return toolErr(`Unknown tool: ${name}`);
  }
}

// ---------- JSON-RPC dispatch ----------
function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}
function rpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

function extractIdFromRaw(raw: string): unknown {
  const m = /"id"\s*:\s*("[^"]*"|-?\d+)/.exec(raw);
  if (!m) return null;
  const v = m[1];
  if (v.startsWith('"')) {
    try { return JSON.parse(v); } catch { return null; }
  }
  return Number(v);
}

export function handleMcp(ctx: HandlerCtx): void {
  if (ctx.method === 'DELETE') {
    ctx.sendJson(200, {});
    return;
  }
  if (ctx.parseError) {
    ctx.sendJson(400, rpcError(extractIdFromRaw(ctx.rawBody), -32700, 'Parse error'));
    return;
  }
  const body = ctx.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    ctx.sendJson(200, rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const req = body as Record<string, unknown>;
  const id = 'id' in req ? req.id : undefined;
  const method = typeof req.method === 'string' ? req.method : '';
  const params: Record<string, unknown> = req.params !== null && typeof req.params === 'object' && !Array.isArray(req.params)
    ? (req.params as Record<string, unknown>)
    : {};

  // Notifications carry no id and get no reply (202, empty body).
  if (id === undefined) {
    if (method === 'notifications/initialized') {
      ctx.sendEmpty(202);
      return;
    }
    ctx.sendEmpty(202);
    return;
  }

  switch (method) {
    case 'server/discover': {
      ctx.sendJson(200, rpcResult(id, {
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      }));
      return;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      if (offered && !SUPPORTED_VERSIONS.includes(offered)) {
        ctx.sendJson(200, rpcError(id, -32602, `Unsupported protocol version: ${offered}`));
        return;
      }
      ctx.sendJson(200, rpcResult(id, {
        protocolVersion: offered || '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }));
      return;
    }
    case 'notifications/initialized': {
      ctx.sendEmpty(202);
      return;
    }
    case 'tools/list': {
      ctx.sendJson(200, rpcResult(id, { tools: TOOLS }));
      return;
    }
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const canonical = resolveToolName(name);
      if (!canonical) {
        ctx.sendJson(200, rpcError(id, -32602, `Unknown tool: ${name || '(missing)'}`));
        return;
      }
      const result = callTool(canonical, params.arguments);
      ctx.sendJson(200, rpcResult(id, result));
      return;
    }
    case 'ping': {
      ctx.sendJson(200, rpcResult(id, {}));
      return;
    }
    default: {
      ctx.sendJson(200, rpcError(id, -32601, `Method not found: ${method}`));
      return;
    }
  }
}
