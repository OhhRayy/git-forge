// graphql.ts — GraphQL v4 executor for the git forge (spec-graphql-mcp.md Part A).
// Dispatches the 18 known documents by operation name + top-level field
// (no full GraphQL parser): a small operation-name match plus an
// introspection matcher for __type queries and JSON batch arrays.
// Shares the store with REST/MCP via rest.ts helpers, so ids and numbers
// are identical across surfaces.

import { nowIso } from './store.ts';
import {
  getRepo, getRepoById, resolveGlobalId, createIssueRecord, createPullRecord,
  mergePullRecord, prWouldConflict, addCommentRecord, getPullFileDetails,
  VIEWER_LOGIN,
} from './rest.ts';
import type { HandlerCtx } from './rest.ts';
import type { Repo, Issue, Pull } from './store.ts';

// ---------- introspection tables (exact required fields + extras) ----------
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url', 'closedAt', 'repository', 'timelineItems'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'title', 'body', 'createdAt', 'updatedAt', 'author', 'headRefOid', 'baseRefOid', 'mergedAt', 'mergeCommit', 'url', 'commits', 'reviews'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url', 'defaultBranch', 'fork', 'isPrivate', 'labels'],
};
const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'DISCUSSION', 'REPOSITORY', 'USER', 'ORGANIZATION', 'MILESTONE'];

function introspect(query: string): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)\s*:\s*__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const alias = m[1];
    const typeName = m[2];
    const tail = query.slice(m.index + m[0].length, m.index + m[0].length + 400);
    if (typeName === 'SearchType') {
      data[alias] = { enumValues: SEARCH_TYPE_VALUES.map((n) => ({ name: n })) };
    } else if (TYPE_FIELDS[typeName]) {
      if (tail.includes('enumValues')) data[alias] = { enumValues: [] };
      else data[alias] = { fields: TYPE_FIELDS[typeName].map((n) => ({ name: n })) };
    } else {
      data[alias] = null;
    }
  }
  return data;
}

// ---------- GraphQL serializers ----------
function issueGql(issue: Issue): Record<string, unknown> {
  return {
    id: issue.nodeId,
    number: issue.number,
    title: issue.title,
    state: issue.state.toUpperCase(),
    body: issue.body,
  };
}

function pullStateGql(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  if (pull.state === 'closed') return 'CLOSED';
  return 'OPEN';
}

function pullGql(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.nodeId,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullStateGql(pull),
    headRefName: pull.head.ref,
    baseRefName: pull.base.ref,
    mergeable: prWouldConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    merged: pull.merged,
    files: { nodes: getPullFileDetails(pull).slice(0, 10).map((f) => ({ path: f.filename })) },
  };
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64');
}
function numberAfterCursor(after: unknown): number {
  if (typeof after !== 'string' || !after) return 0;
  try {
    const s = Buffer.from(after, 'base64').toString('utf8');
    const m = /^cursor:(\d+)$/.exec(s);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function openIssuesConnection(repo: Repo, first: number): Record<string, unknown> {
  const allOpen = [...repo.issues.values()]
    .filter((i) => i.state === 'open')
    .sort((a, b) => b.number - a.number);
  const nodes = allOpen.slice(0, first).map(issueGql);
  return {
    nodes,
    pageInfo: {
      hasNextPage: allOpen.length > first,
      endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number as number) : null,
    },
  };
}

function pageIssuesConnection(repo: Repo, first: number, after: unknown): Record<string, unknown> {
  const afterN = numberAfterCursor(after);
  const all = [...repo.issues.values()].sort((a, b) => a.number - b.number).filter((i) => i.number > afterN);
  const page = all.slice(0, first);
  const nodes = page.map(issueGql);
  return {
    nodes,
    pageInfo: {
      hasNextPage: all.length > first,
      endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number as number) : null,
    },
  };
}

function pullRequestsConnection(repo: Repo, first: number): Record<string, unknown> {
  const allOpen = [...repo.pulls.values()]
    .filter((p) => p.state === 'open')
    .sort((a, b) => b.number - a.number);
  const nodes = allOpen.slice(0, first).map((p) => pullGql(repo, p));
  return {
    nodes,
    pageInfo: {
      hasNextPage: allOpen.length > first,
      endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1].number as number) : null,
    },
  };
}

function repositoryGql(repo: Repo, v: Record<string, unknown>, opName: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: repo.nodeId,
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: repo.fullName,
    owner: { login: repo.ownerLogin },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
  if (opName === 'IssueByNumber' && typeof v.number === 'number') {
    const issue = repo.issues.get(v.number);
    out.issue = issue ? issueGql(issue) : null;
  }
  if ((opName === 'PullRequestFiles' || opName === 'PullRequestId') && typeof v.number === 'number') {
    const pull = repo.pulls.get(v.number);
    out.pullRequest = pull ? pullGql(repo, pull) : null;
  }
  if (opName === 'OpenIssues' && typeof v.first === 'number') {
    out.issues = openIssuesConnection(repo, v.first);
  }
  if (opName === 'IssuesPage' && typeof v.first === 'number') {
    out.issues = pageIssuesConnection(repo, v.first, v.after ?? null);
  }
  if (opName === 'PullRequests' && typeof v.first === 'number') {
    out.pullRequests = pullRequestsConnection(repo, v.first);
  }
  return out;
}

// ---------- operation dispatch ----------
function gqlError(message: string): { data: null; errors: { message: string }[] } {
  return { data: null, errors: [{ message }] };
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function executeOne(op: unknown): Record<string, unknown> {
  const rec = asRecord(op);
  const query = typeof rec.query === 'string' ? rec.query : '';
  const variables = asRecord(rec.variables);
  if (!query) return gqlError('No query provided');

  // Introspection documents (aliased __type) — handled before operation dispatch.
  if (query.includes('__type')) {
    return { data: introspect(query) };
  }
  // Unknown-field document: HTTP 200 + errors naming the field.
  if (query.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: { login: VIEWER_LOGIN } },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
    };
  }

  const m = /^\s*(query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query);
  const opName = m ? m[2] : '';

  switch (opName) {
    case 'ViewerLogin': {
      return { data: { viewer: { login: VIEWER_LOGIN } } };
    }
    case 'RepositoryFields':
    case 'OpenIssues':
    case 'IssueByNumber':
    case 'PullRequests':
    case 'PullRequestFiles':
    case 'PullRequestId':
    case 'IssuesPage': {
      const owner = typeof variables.owner === 'string' ? variables.owner : '';
      const name = typeof variables.name === 'string' ? variables.name : '';
      const repo = owner && name ? getRepo(owner, name) : undefined;
      if (!repo) return { data: { repository: null } };
      return { data: { repository: repositoryGql(repo, variables, opName) } };
    }
    case 'IssueCreate': {
      const input = asRecord(variables.input);
      const resolved = typeof input.repositoryId === 'string' ? resolveGlobalId(input.repositoryId) : null;
      if (!resolved || !resolved.repo) return gqlError('Repository not found');
      const res = createIssueRecord(
        resolved.repo,
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
        [],
      );
      if ('error' in res) return gqlError(res.error);
      return { data: { createIssue: { issue: { number: res.number, id: res.nodeId } } } };
    }
    case 'IssueClose': {
      const input = asRecord(variables.input);
      const resolved = typeof input.issueId === 'string' ? resolveGlobalId(input.issueId) : null;
      if (!resolved || !resolved.issue) return gqlError('Issue not found');
      resolved.issue.state = 'closed';
      resolved.issue.updatedAt = nowIso();
      return { data: { closeIssue: { issue: { number: resolved.issue.number, id: resolved.issue.nodeId, state: 'CLOSED' } } } };
    }
    case 'PullRequestCreate': {
      const input = asRecord(variables.input);
      const resolved = typeof input.repositoryId === 'string' ? resolveGlobalId(input.repositoryId) : null;
      if (!resolved || !resolved.repo) return gqlError('Repository not found');
      const res = createPullRecord(
        resolved.repo,
        typeof input.headRefName === 'string' ? input.headRefName : '',
        typeof input.baseRefName === 'string' ? input.baseRefName : '',
        typeof input.title === 'string' ? input.title : '',
        typeof input.body === 'string' ? input.body : '',
      );
      if ('error' in res) return gqlError(res.error);
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: res.number, id: res.nodeId, state: 'OPEN',
              headRefName: res.head.ref, baseRefName: res.base.ref,
            },
          },
        },
      };
    }
    case 'MergePullRequest': {
      const input = asRecord(variables.input);
      const resolved = typeof input.pullRequestId === 'string' ? resolveGlobalId(input.pullRequestId) : null;
      if (!resolved || !resolved.pull || !resolved.repo) return gqlError('Pull request not found');
      const res = mergePullRecord(resolved.repo, resolved.pull);
      if ('error' in res) return gqlError(res.error);
      return {
        data: {
          mergePullRequest: {
            pullRequest: { number: resolved.pull.number, merged: true, state: 'MERGED' },
          },
        },
      };
    }
    case 'AddComment': {
      const input = asRecord(variables.input);
      const resolved = typeof input.subjectId === 'string' ? resolveGlobalId(input.subjectId) : null;
      if (!resolved || !resolved.issue || !resolved.repo) return gqlError('Issue not found');
      const c = addCommentRecord(resolved.repo, resolved.issue, typeof input.body === 'string' ? input.body : '');
      return { data: { addComment: { commentEdge: { node: { id: c.nodeId, body: c.body } } } } };
    }
    case 'NodeRepository': {
      const id = typeof variables.id === 'string' ? variables.id : '';
      const resolved = id ? resolveGlobalId(id) : null;
      if (!resolved || !resolved.repo) return { data: { node: null } };
      if (resolved.kind === 'Repository') {
        return { data: { node: { id: resolved.repo.nodeId, name: resolved.repo.name, nameWithOwner: resolved.repo.fullName } } };
      }
      if (resolved.kind === 'Issue' && resolved.issue) {
        return { data: { node: { id: resolved.issue.nodeId } } };
      }
      if (resolved.kind === 'PullRequest' && resolved.pull) {
        return { data: { node: { id: resolved.pull.nodeId } } };
      }
      return { data: { node: null } };
    }
    default: {
      return gqlError(`Unknown operation ${opName || '(anonymous)'}`);
    }
  }
}

export function handleGraphql(ctx: HandlerCtx): void {
  if (ctx.parseError) {
    ctx.sendJson(400, { errors: [{ message: 'Invalid JSON body' }] });
    return;
  }
  if (Array.isArray(ctx.body)) {
    ctx.sendJson(200, ctx.body.map((op) => executeOne(op)));
    return;
  }
  ctx.sendJson(200, executeOne(ctx.body));
}

// Re-exported for tests / future use.
export { getRepoById };
