// rest.ts — the REST v3 surface under /api/v3, over forge.ts's shared store. The contents API is
// backed by the real git object store: a contents commit is a git commit on a branch ref, so git
// pushes and contents writes see each other's bytes immediately.

import {
  TRIAL_NOW_ISO,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  commitFiles,
  commitTree,
  diffCommits,
  filesAt,
  listCommits,
  mergeBase,
  parseCommit,
  parseTree,
  squashMerge,
  store,
  type Issue,
  type Pull,
  type Repo,
} from './forge.ts';

export interface RestRequest {
  method: string;
  /** The decoded path segments after /api/v3 (empty for the root). */
  segments: string[];
  query: URLSearchParams;
  /** The parsed JSON body, or undefined when there was none. */
  body: Record<string, unknown> | undefined;
  /** `http://<host>` of the request, for absolute Link URLs. */
  origin: string;
}

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const notFound = (): RestReply => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestReply => ({ status: 422, body: { message } });

// -------------------------------------------------------------------------------------------------
// serializers
// -------------------------------------------------------------------------------------------------

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', description: label?.description ?? null };
    }),
    comments: issue.comments.length,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
}

function commentJson(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: TRIAL_NOW_ISO,
    updated_at: TRIAL_NOW_ISO,
  };
}

// -------------------------------------------------------------------------------------------------
// helpers
// -------------------------------------------------------------------------------------------------

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  return { page, perPage };
}

/** Resolve a ref parameter (branch name or commit id) to a commit oid. */
function resolveCommit(repo: Repo, ref: string | undefined): string | undefined {
  if (ref === undefined || ref === '') return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (/^[0-9a-f]{40}$/.test(ref) && store.objects.has(ref)) return ref;
  return repo.refs.get(ref);
}

/** The branch tip a contents write targets, creating the branch ref state when the repo is unborn. */
function contentsTarget(repo: Repo, branch: string): { tip: string | undefined } {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip !== undefined) return { tip };
  if (branch !== repo.defaultBranch) {
    const fallback = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (fallback !== undefined) return { tip: fallback };
  }
  return { tip: undefined };
}

// -------------------------------------------------------------------------------------------------
// route handlers
// -------------------------------------------------------------------------------------------------

function createRepo(req: RestRequest): RestReply {
  const name = stringOf(req.body?.name);
  if (name === undefined || name === '') return unprocessable('Repository creation failed: name is required');
  if (store.repos.has(name)) {
    return { status: 422, body: { message: 'Repository creation failed: name already exists on this account', errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }] } };
  }
  const repo = store.createRepo(name, req.body?.private === true, stringOf(req.body?.description) ?? '');
  return { status: 201, body: repoJson(repo) };
}

function listUserRepos(req: RestRequest): RestReply {
  const all = [...store.repos.values()].sort((a, b) => a.id - b.id);
  const { page, perPage } = pageParams(req.query);
  const start = (page - 1) * perPage;
  const slice = all.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < all.length) {
    const lastPage = Math.ceil(all.length / perPage);
    const base = `${req.origin}/api/v3/user/repos`;
    headers.link = `<${base}?page=${page + 1}&per_page=${perPage}>; rel="next", <${base}?page=${lastPage}&per_page=${perPage}>; rel="last"`;
  }
  return { status: 200, body: slice.map(repoJson), headers };
}

function getContents(repo: Repo, pathParts: string[], req: RestRequest): RestReply {
  const commitOid = resolveCommit(repo, req.query.get('ref') ?? undefined);
  if (commitOid === undefined) return notFound();
  const treeOid = commitTree(store, commitOid);
  if (treeOid === null) return notFound();
  const path = pathParts.join('/');
  if (path === '') {
    const tree = store.objects.get(treeOid);
    if (tree === undefined) return notFound();
    return { status: 200, body: parseTree(tree.data).map((entry) => listingEntry(repo, entry, '')) };
  }
  // Walk the tree segment by segment.
  let currentTree = treeOid;
  for (let index = 0; index < pathParts.length; index += 1) {
    const tree = store.objects.get(currentTree);
    if (tree === undefined || tree.type !== 'tree') return notFound();
    const entry = parseTree(tree.data).find((candidate) => candidate.name === pathParts[index]);
    if (entry === undefined) return notFound();
    const isLast = index === pathParts.length - 1;
    if (!isLast) {
      if (entry.mode !== '40000') return notFound();
      currentTree = entry.oid;
      continue;
    }
    if (entry.mode === '40000') {
      const dir = store.objects.get(entry.oid);
      if (dir === undefined) return notFound();
      return { status: 200, body: parseTree(dir.data).map((child) => listingEntry(repo, child, path)) };
    }
    const blob = store.objects.get(entry.oid);
    if (blob === undefined) return notFound();
    return {
      status: 200,
      body: {
        type: 'file',
        name: entry.name,
        path,
        sha: entry.oid,
        size: blob.data.length,
        encoding: 'base64',
        content: blob.data.toString('base64'),
      },
    };
  }
  return notFound();
}

function listingEntry(_repo: Repo, entry: { mode: string; name: string; oid: string }, prefix: string): Record<string, unknown> {
  const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  const out: Record<string, unknown> = {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
  };
  if (entry.mode !== '40000') {
    const blob = store.objects.get(entry.oid);
    out.size = blob?.data.length ?? 0;
  }
  return out;
}

function putContents(repo: Repo, pathParts: string[], req: RestRequest): RestReply {
  const path = pathParts.join('/');
  if (path === '') return unprocessable('path is required');
  const message = stringOf(req.body?.message) ?? '';
  const contentB64 = stringOf(req.body?.content);
  if (contentB64 === undefined) return unprocessable('content is required');
  const branch = stringOf(req.body?.branch) ?? repo.defaultBranch;
  const { tip } = contentsTarget(repo, branch);
  const files = tip === undefined ? new Map<string, string>() : filesAt(store, tip);
  const existing = files.get(path);
  const givenSha = stringOf(req.body?.sha);
  if (givenSha !== undefined && givenSha !== existing) {
    return { status: 409, body: { message: 'Conflict: the given sha does not match the current blob' } };
  }
  const data = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  const blobOid = store.putObject('blob', data);
  files.set(path, blobOid);
  const commit = commitFiles(store, tip ?? null, files, message);
  repo.refs.set(`refs/heads/${branch}`, commit);
  return {
    status: existing === undefined ? 201 : 200,
    body: {
      content: { type: 'file', name: pathParts[pathParts.length - 1], path, sha: blobOid, size: data.length, encoding: 'base64' },
      commit: { sha: commit, message },
    },
  };
}

function deleteContents(repo: Repo, pathParts: string[], req: RestRequest): RestReply {
  const path = pathParts.join('/');
  const branch = stringOf(req.body?.branch) ?? repo.defaultBranch;
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return notFound();
  const files = filesAt(store, tip);
  const existing = files.get(path);
  if (existing === undefined) return notFound();
  const givenSha = stringOf(req.body?.sha);
  if (givenSha !== undefined && givenSha !== existing) {
    return { status: 409, body: { message: 'Conflict: the given sha does not match the current blob' } };
  }
  files.delete(path);
  const commit = commitFiles(store, tip, files, stringOf(req.body?.message) ?? '');
  repo.refs.set(`refs/heads/${branch}`, commit);
  return { status: 200, body: { content: null, commit: { sha: commit } } };
}

function listCommitsRoute(repo: Repo, req: RestRequest): RestReply {
  const tip = resolveCommit(repo, req.query.get('sha') ?? undefined);
  if (tip === undefined) return { status: 200, body: [] };
  const out = listCommits(store, tip).map((oid) => {
    const object = store.objects.get(oid)!;
    const commit = parseCommit(object.data);
    const identity = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line);
      return {
        name: match?.[1] ?? '',
        email: match?.[2] ?? '',
        date: new Date(Number(match?.[3] ?? 1_735_689_600) * 1000).toISOString(),
      };
    };
    return {
      sha: oid,
      commit: {
        message: commit.message,
        tree: { sha: commit.tree },
        author: identity(commit.author),
        committer: identity(commit.committer),
      },
      parents: commit.parents.map((parent) => ({ sha: parent })),
    };
  });
  return { status: 200, body: out };
}

function listIssues(repo: Repo, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  let issues = store.issues(repo);
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  const direction = req.query.get('direction') ?? 'desc';
  issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  const { page, perPage } = pageParams(req.query);
  const start = (page - 1) * perPage;
  return { status: 200, body: issues.slice(start, start + perPage).map((issue) => issueJson(repo, issue)) };
}

function createIssue(repo: Repo, req: RestRequest): RestReply {
  const title = stringOf(req.body?.title);
  if (title === undefined || title === '') return unprocessable('Validation Failed: title is required');
  const rawLabels = req.body?.labels;
  const labels: string[] = [];
  if (Array.isArray(rawLabels)) {
    for (const entry of rawLabels) {
      const name = typeof entry === 'string' ? entry : stringOf((entry as Record<string, unknown>)?.name);
      if (name === undefined) return unprocessable('Validation Failed: labels must be names');
      if (!repo.labels.has(name)) return unprocessable(`Validation Failed: label "${name}" does not exist`);
      labels.push(name);
    }
  }
  const issue = store.createIssue(repo, title, stringOf(req.body?.body) ?? '', labels);
  return { status: 201, body: issueJson(repo, issue) };
}

function listPulls(repo: Repo, req: RestRequest): RestReply {
  const state = req.query.get('state') ?? 'open';
  let pulls = store.pulls(repo);
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => a.number - b.number);
  const { page, perPage } = pageParams(req.query);
  const start = (page - 1) * perPage;
  return { status: 200, body: pulls.slice(start, start + perPage).map((pull) => pullJson(repo, pull)) };
}

function createPull(repo: Repo, req: RestRequest): RestReply {
  const title = stringOf(req.body?.title) ?? '';
  const stripLabel = (ref: string): string => (ref.includes(':') ? ref.slice(ref.indexOf(':') + 1) : ref);
  const head = stripLabel(stringOf(req.body?.head) ?? '');
  const base = stripLabel(stringOf(req.body?.base) ?? '');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined) return unprocessable(`Validation Failed: head branch "${head}" does not exist`);
  if (baseSha === undefined) return unprocessable(`Validation Failed: base branch "${base}" does not exist`);
  if (head === base) return unprocessable('Validation Failed: head and base are the same');
  const duplicate = store.pulls(repo).some((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
  if (duplicate) return unprocessable(`A pull request already exists for ${VIEWER_LOGIN}:${head} -> ${base}`);
  const pull = store.createPull(repo, title, stringOf(req.body?.body) ?? '', head, base, headSha, baseSha);
  return { status: 201, body: pullJson(repo, pull) };
}

function pullFiles(repo: Repo, pull: Pull): RestReply {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(store, baseTip, headTip) ?? pull.baseSha;
  const changes = diffCommits(store, base, headTip);
  return {
    status: 200,
    body: changes.map((change) => ({
      filename: change.filename,
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
      changes: change.changes,
    })),
  };
}

function mergePull(repo: Repo, pull: Pull): RestReply {
  if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not open' } };
  const result = squashMerge(store, repo, pull);
  if ('conflict' in result) return { status: 405, body: { message: 'Pull Request is not mergeable: the head branch conflicts with the base' } };
  if ('gone' in result) return notFound();
  return { status: 200, body: { sha: result.sha, merged: true, message: 'Pull Request successfully merged' } };
}

// -------------------------------------------------------------------------------------------------
// the router
// -------------------------------------------------------------------------------------------------

export function handleRest(req: RestRequest): RestReply {
  const seg = req.segments;
  const method = req.method;

  if (seg.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
      headers: { 'x-oauth-scopes': 'repo, read:org' },
    };
  }
  if (seg[0] === 'meta' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { installed_version: '1.0.0' } };
  }
  if (seg[0] === 'user' && seg.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' } };
  }
  if (seg[0] === 'user' && seg[1] === 'repos' && seg.length === 2) {
    if (method === 'POST') return createRepo(req);
    if (method === 'GET') return listUserRepos(req);
    return notFound();
  }
  if (seg[0] !== 'repos' || seg.length < 3) return notFound();

  const repo = store.repo(seg[1]!, seg[2]!);
  if (repo === undefined) return notFound();
  const rest = seg.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      const description = stringOf(req.body?.description);
      if (description !== undefined) repo.description = description;
      if (typeof req.body?.private === 'boolean') repo.isPrivate = req.body.private;
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      store.repos.delete(repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  if (rest[0] === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const name = rest.slice(1).join('/');
      const sha = repo.refs.get(`refs/heads/${name}`);
      if (sha === undefined) return notFound();
      return { status: 200, body: { name, commit: { sha }, protected: false } };
    }
    return notFound();
  }

  if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommitsRoute(repo, req);

  if (rest[0] === 'contents') {
    const pathParts = rest.slice(1);
    if (method === 'GET') return getContents(repo, pathParts, req);
    if (method === 'PUT') return putContents(repo, pathParts, req);
    if (method === 'DELETE') return deleteContents(repo, pathParts, req);
    return notFound();
  }

  if (rest[0] === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = stringOf(req.body?.ref);
      const sha = stringOf(req.body?.sha);
      if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) return unprocessable('ref and sha are required');
      const target = store.objects.get(sha);
      if (target === undefined) return unprocessable('the given sha does not name an object');
      if (repo.refs.has(ref)) return unprocessable('Reference already exists');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: target.type } } };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) return notFound();
      const target = store.objects.get(sha);
      return { status: 200, body: { ref, object: { sha, type: target?.type ?? 'commit' } } };
    }
    return notFound();
  }

  if (rest[0] === 'labels' && rest.length === 1) {
    if (method === 'POST') {
      const name = stringOf(req.body?.name);
      if (name === undefined || name === '') return unprocessable('Validation Failed: name is required');
      if (repo.labels.has(name)) return unprocessable('Validation Failed: label already exists');
      const label = { name, color: stringOf(req.body?.color) ?? 'ededed', description: stringOf(req.body?.description) ?? null };
      repo.labels.set(name, label);
      return { status: 201, body: { name: label.name, color: label.color, description: label.description } };
    }
    if (method === 'GET') {
      return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })) };
    }
    return notFound();
  }

  if (rest[0] === 'issues') {
    if (rest.length === 1) {
      if (method === 'GET') return listIssues(repo, req);
      if (method === 'POST') return createIssue(repo, req);
      return notFound();
    }
    const number = Number.parseInt(rest[1]!, 10);
    const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
    if (rest.length === 2) {
      if (item === undefined || item.kind !== 'issue') return notFound();
      if (method === 'GET') return { status: 200, body: issueJson(repo, item) };
      if (method === 'PATCH') {
        const state = stringOf(req.body?.state);
        if (state === 'open' || state === 'closed') item.state = state;
        const title = stringOf(req.body?.title);
        if (title !== undefined) item.title = title;
        const bodyText = stringOf(req.body?.body);
        if (bodyText !== undefined) item.body = bodyText;
        return { status: 200, body: issueJson(repo, item) };
      }
      return notFound();
    }
    if (rest.length === 3 && rest[2] === 'comments') {
      if (item === undefined || item.kind !== 'issue') return notFound();
      if (method === 'GET') return { status: 200, body: item.comments.map(commentJson) };
      if (method === 'POST') {
        const bodyText = stringOf(req.body?.body);
        if (bodyText === undefined) return unprocessable('Validation Failed: body is required');
        const comment = { id: store.nextCommentId(), body: bodyText };
        item.comments.push(comment);
        return { status: 201, body: commentJson(comment) };
      }
      return notFound();
    }
    return notFound();
  }

  if (rest[0] === 'pulls') {
    if (rest.length === 1) {
      if (method === 'GET') return listPulls(repo, req);
      if (method === 'POST') return createPull(repo, req);
      return notFound();
    }
    const number = Number.parseInt(rest[1]!, 10);
    const item = Number.isInteger(number) ? repo.items.get(number) : undefined;
    if (item === undefined || item.kind !== 'pull') return notFound();
    if (rest.length === 2 && method === 'GET') return { status: 200, body: pullJson(repo, item) };
    if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return pullFiles(repo, item);
    if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePull(repo, item);
    return notFound();
  }

  return notFound();
}
