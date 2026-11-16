// graphql.ts — a small GraphQL executor for POST /api/graphql, over forge.ts's shared store.
// It implements exactly the surface the suite drives: viewer/repository/node reads, __type
// introspection (fields and enumValues), issue and pull-request connections with cursor paging,
// and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations.
// Global ids are opaque base64url strings, stable across reads and distinct from the numeric ids.

import {
  TRIAL_NOW_ISO,
  VIEWER_ID,
  VIEWER_LOGIN,
  diffCommits,
  mergeBase,
  pullMergeable,
  squashMerge,
  store,
  type Issue,
  type Pull,
  type Repo,
} from './forge.ts';

// -------------------------------------------------------------------------------------------------
// global ids
// -------------------------------------------------------------------------------------------------

function gid(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64url');
}

function repoGid(repo: Repo): string {
  return gid('repo', repo.id);
}

function issueGid(repo: Repo, issue: Issue): string {
  return gid('issue', repo.id, issue.number);
}

function pullGid(repo: Repo, pull: Pull): string {
  return gid('pr', repo.id, pull.number);
}

function decodeGid(id: string): string[] | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    return parts.length >= 2 ? parts : null;
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------------------------------
// lexer and parser
// -------------------------------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  name: string;
  alias?: string;
  args: { name: string; value: Value }[];
  selectionSet?: Selection[];
}

type Selection =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition?: string; selectionSet: Selection[] }
  | { kind: 'spread'; name: string };

interface Operation {
  type: 'query' | 'mutation';
  name?: string;
  selectionSet: Selection[];
}

interface Fragment {
  typeCondition: string;
  selectionSet: Selection[];
}

interface Document {
  operations: Operation[];
  fragments: Map<string, Fragment>;
}

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        tokens.push(`"${input.slice(i + 3, end === -1 ? input.length : end)}"`);
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push(`"${out}"`);
      i = j + 1;
      continue;
    }
    const rest = input.slice(i);
    const nameMatch = /^[_A-Za-z][_0-9A-Za-z]*/.exec(rest);
    if (nameMatch !== null) {
      tokens.push(nameMatch[0]);
      i += nameMatch[0].length;
      continue;
    }
    const numMatch = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (numMatch !== null) {
      tokens.push(numMatch[0]);
      i += numMatch[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];

  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  private skipType(): void {
    // A type reference: Name, [Type], with optional trailing !.
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Fragment>();
    while (this.pos < this.tokens.length) {
      const token = this.peek()!;
      if (token === '{') {
        operations.push({ type: 'query', selectionSet: this.parseSelectionSet() });
      } else if (token === 'query' || token === 'mutation' || token === 'subscription') {
        const type = this.next() as Operation['type'];
        let name: string | undefined;
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek()!)) name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type, name, selectionSet: this.parseSelectionSet() });
      } else if (token === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        this.skipDirectives();
        fragments.set(name, { typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.skipType();
      if (this.peek() === '=') {
        this.next();
        this.parseValue();
      }
      this.skipDirectives();
    }
    this.expect(')');
  }

  private skipDirectives(): void {
    while (this.peek() === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek() === '(') this.parseArguments();
    }
  }

  private parseSelectionSet(): Selection[] {
    this.expect('{');
    const selections: Selection[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.next();
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
      } else {
        selections.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | undefined;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = this.peek() === '(' ? this.parseArguments() : [];
    this.skipDirectives();
    const selectionSet = this.peek() === '{' ? this.parseSelectionSet() : undefined;
    return { name, alias, args, selectionSet };
  }

  private parseArguments(): { name: string; value: Value }[] {
    this.expect('(');
    const args: { name: string; value: Value }[] = [];
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'var', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const items: Value[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d/.test(token)) return { kind: 'number', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------------
// sources (the runtime objects resolvers read)
// -------------------------------------------------------------------------------------------------

interface Source {
  __typename: string;
  [key: string]: unknown;
}

function userSource(): Source {
  return { __typename: 'User', login: VIEWER_LOGIN, id: gid('user', VIEWER_ID), name: 'ada iversen' };
}

function repoSource(repo: Repo): Source {
  return { __typename: 'Repository', repo };
}

function issueSource(repo: Repo, issue: Issue): Source {
  return { __typename: 'Issue', repo, issue };
}

function pullSource(repo: Repo, pull: Pull): Source {
  return { __typename: 'PullRequest', repo, pull };
}

function commentSource(repo: Repo, issue: Issue, comment: { id: number; body: string }): Source {
  return { __typename: 'IssueComment', repo, issue, comment };
}

// -------------------------------------------------------------------------------------------------
// connections
// -------------------------------------------------------------------------------------------------

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
  endCursor: string | null;
}

function pageOf<T extends { number: number }>(ordered: T[], first: unknown, after: unknown): Page<T> {
  let start = 0;
  const afterNumber = numberFromCursor(after);
  if (afterNumber !== null) {
    const index = ordered.findIndex((item) => item.number === afterNumber);
    if (index !== -1) start = index + 1;
  }
  const limit = typeof first === 'number' && Number.isFinite(first) ? Math.max(0, Math.trunc(first)) : ordered.length;
  const nodes = ordered.slice(start, start + limit);
  return {
    nodes,
    hasNextPage: start + nodes.length < ordered.length,
    endCursor: nodes.length > 0 ? cursorFor(nodes[nodes.length - 1]!.number) : null,
  };
}

function pageInfoSource(page: Page<unknown>): Source {
  return {
    __typename: 'PageInfo',
    hasNextPage: page.hasNextPage,
    hasPreviousPage: false,
    startCursor: page.nodes.length > 0 ? page.endCursor : null,
    endCursor: page.endCursor,
  };
}

function issuesConnection(repo: Repo, args: Record<string, unknown>): Source {
  let list = store.issues(repo);
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => String(state).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const descending = orderBy.direction !== 'ASC'; // CREATED_AT DESC is the default gh asks for
  const ordered = [...list].sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
  const hasOrder = args.orderBy !== undefined && args.orderBy !== null;
  const effective = hasOrder ? ordered : [...list].sort((a, b) => a.number - b.number);
  const page = pageOf(effective, args.first, args.after);
  return {
    __typename: 'IssueConnection',
    nodes: page.nodes.map((issue) => issueSource(repo, issue)),
    pageInfo: pageInfoSource(page as Page<unknown>),
    totalCount: effective.length,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): Source {
  const list = [...store.pulls(repo)].sort((a, b) => a.number - b.number);
  const page = pageOf(list, args.first, args.after);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.nodes.map((pull) => pullSource(repo, pull)),
    pageInfo: pageInfoSource(page as Page<unknown>),
    totalCount: list.length,
  };
}

function pullFilesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): Source {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const base = mergeBase(store, baseTip, headTip) ?? pull.baseSha;
  const changes = diffCommits(store, base, headTip);
  const limit = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
  return {
    __typename: 'PullRequestChangedFileConnection',
    nodes: changes.slice(0, limit).map((change) => ({
      __typename: 'PullRequestChangedFile',
      path: change.filename,
      additions: change.additions,
      deletions: change.deletions,
      changeType: change.status.toUpperCase(),
    })),
    totalCount: changes.length,
  };
}

// -------------------------------------------------------------------------------------------------
// schema: field resolvers per type (the key set is the introspected field list)
// -------------------------------------------------------------------------------------------------

type Resolver = (source: Source, args: Record<string, unknown>, ctx: Ctx) => unknown;

interface Ctx {
  variables: Record<string, unknown>;
  document: Document;
  errors: { message: string }[];
}

const prop =
  (key: string): Resolver =>
  (source) =>
    source[key];

const SCHEMA: Record<string, Record<string, { type: string; resolve: Resolver }>> = {
  Query: {
    viewer: { type: 'User', resolve: () => userSource() },
    repository: {
      type: 'Repository',
      resolve: (_source, args) => {
        const repo = store.repo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === undefined ? null : repoSource(repo);
      },
    },
    node: {
      type: 'Node',
      resolve: (_source, args) => {
        const parts = decodeGid(String(args.id ?? ''));
        if (parts === null) return null;
        if (parts[0] === 'repo') {
          const repo = store.repoById(Number(parts[1]));
          return repo === undefined ? null : repoSource(repo);
        }
        if (parts[0] === 'issue' || parts[0] === 'pr') {
          const repo = store.repoById(Number(parts[1]));
          const item = repo?.items.get(Number(parts[2]));
          if (repo === undefined || item === undefined) return null;
          return item.kind === 'issue' ? issueSource(repo, item) : pullSource(repo, item);
        }
        if (parts[0] === 'user') return userSource();
        return null;
      },
    },
    __type: {
      type: '__Type',
      resolve: (_source, args) => typeSource(String(args.name ?? '')),
    },
  },
  Mutation: {
    createIssue: {
      type: 'CreateIssuePayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parts = decodeGid(String(input.repositoryId ?? ''));
        const repo = parts?.[0] === 'repo' ? store.repoById(Number(parts[1])) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'Could not resolve the repository' });
          return null;
        }
        const issue = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
        return { __typename: 'CreateIssuePayload', issue: issueSource(repo, issue), clientMutationId: null };
      },
    },
    closeIssue: {
      type: 'CloseIssuePayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(String(input.issueId ?? ''));
        if (found === undefined) {
          ctx.errors.push({ message: 'Could not resolve the issue' });
          return null;
        }
        found.issue.state = 'closed';
        return { __typename: 'CloseIssuePayload', issue: issueSource(found.repo, found.issue), clientMutationId: null };
      },
    },
    createPullRequest: {
      type: 'CreatePullRequestPayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const parts = decodeGid(String(input.repositoryId ?? ''));
        const repo = parts?.[0] === 'repo' ? store.repoById(Number(parts[1])) : undefined;
        if (repo === undefined) {
          ctx.errors.push({ message: 'Could not resolve the repository' });
          return null;
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (headSha === undefined || baseSha === undefined) {
          ctx.errors.push({ message: 'Could not resolve the head or base branch' });
          return null;
        }
        const existing = store.pulls(repo).find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
        if (existing !== undefined) {
          return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, existing), clientMutationId: null };
        }
        const pull = store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
        return { __typename: 'CreatePullRequestPayload', pullRequest: pullSource(repo, pull), clientMutationId: null };
      },
    },
    mergePullRequest: {
      type: 'MergePullRequestPayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findPullByGid(String(input.pullRequestId ?? ''));
        if (found === undefined) {
          ctx.errors.push({ message: 'Could not resolve the pull request' });
          return null;
        }
        if (found.pull.state === 'open') {
          const result = squashMerge(store, found.repo, found.pull);
          if ('conflict' in result) {
            ctx.errors.push({ message: 'Pull Request is not mergeable' });
            return null;
          }
        }
        return { __typename: 'MergePullRequestPayload', pullRequest: pullSource(found.repo, found.pull), clientMutationId: null };
      },
    },
    addComment: {
      type: 'AddCommentPayload',
      resolve: (_source, args, ctx) => {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = findIssueByGid(String(input.subjectId ?? ''));
        if (found === undefined) {
          ctx.errors.push({ message: 'Could not resolve the subject' });
          return null;
        }
        const comment = { id: store.nextCommentId(), body: String(input.body ?? '') };
        found.issue.comments.push(comment);
        return {
          __typename: 'AddCommentPayload',
          commentEdge: {
            __typename: 'IssueCommentEdge',
            node: commentSource(found.repo, found.issue, comment),
            cursor: cursorFor(found.issue.number),
          },
          clientMutationId: null,
        };
      },
    },
  },
  User: {
    login: { type: 'String', resolve: prop('login') },
    id: { type: 'ID', resolve: prop('id') },
    name: { type: 'String', resolve: prop('name') },
  },
  Node: {
    id: {
      type: 'ID',
      resolve: (source) => {
        if (source.__typename === 'Repository') return repoGid(source.repo as Repo);
        if (source.__typename === 'Issue') return issueGid(source.repo as Repo, source.issue as Issue);
        if (source.__typename === 'PullRequest') return pullGid(source.repo as Repo, source.pull as Pull);
        if (source.__typename === 'User') return source.id;
        return null;
      },
    },
  },
  Repository: {
    id: { type: 'ID', resolve: (source) => repoGid(source.repo as Repo) },
    databaseId: { type: 'Int', resolve: (source) => (source.repo as Repo).id },
    name: { type: 'String', resolve: (source) => (source.repo as Repo).name },
    nameWithOwner: { type: 'String', resolve: (source) => `${(source.repo as Repo).owner}/${(source.repo as Repo).name}` },
    owner: { type: 'User', resolve: () => userSource() },
    description: { type: 'String', resolve: (source) => (source.repo as Repo).description },
    isPrivate: { type: 'Boolean', resolve: (source) => (source.repo as Repo).isPrivate },
    defaultBranchRef: {
      type: 'Ref',
      resolve: (source) => {
        const repo = source.repo as Repo;
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip } };
      },
    },
    viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
    hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
    issue: {
      type: 'Issue',
      resolve: (source, args) => {
        const repo = source.repo as Repo;
        const item = repo.items.get(Number(args.number));
        return item !== undefined && item.kind === 'issue' ? issueSource(repo, item) : null;
      },
    },
    issues: { type: 'IssueConnection', resolve: (source, args) => issuesConnection(source.repo as Repo, args) },
    pullRequest: {
      type: 'PullRequest',
      resolve: (source, args) => {
        const repo = source.repo as Repo;
        const item = repo.items.get(Number(args.number));
        return item !== undefined && item.kind === 'pull' ? pullSource(repo, item) : null;
      },
    },
    pullRequests: { type: 'PullRequestConnection', resolve: (source, args) => pullsConnection(source.repo as Repo, args) },
    url: { type: 'URI', resolve: (source) => `/${(source.repo as Repo).owner}/${(source.repo as Repo).name}` },
    createdAt: { type: 'DateTime', resolve: () => TRIAL_NOW_ISO },
    updatedAt: { type: 'DateTime', resolve: () => TRIAL_NOW_ISO },
  },
  Ref: {
    name: { type: 'String', resolve: prop('name') },
    prefix: { type: 'String', resolve: () => 'refs/heads/' },
    target: { type: 'Commit', resolve: prop('target') },
  },
  Commit: {
    oid: { type: 'GitObjectID', resolve: prop('oid') },
    id: { type: 'ID', resolve: (source) => gid('commit', String(source.oid)) },
  },
  Issue: {
    id: { type: 'ID', resolve: (source) => issueGid(source.repo as Repo, source.issue as Issue) },
    number: { type: 'Int', resolve: (source) => (source.issue as Issue).number },
    title: { type: 'String', resolve: (source) => (source.issue as Issue).title },
    body: { type: 'String', resolve: (source) => (source.issue as Issue).body },
    state: { type: 'IssueState', resolve: (source) => (source.issue as Issue).state.toUpperCase() },
    url: { type: 'URI', resolve: (source) => `/${(source.repo as Repo).owner}/${(source.repo as Repo).name}/issues/${(source.issue as Issue).number}` },
    createdAt: { type: 'DateTime', resolve: () => TRIAL_NOW_ISO },
    updatedAt: { type: 'DateTime', resolve: () => TRIAL_NOW_ISO },
    author: { type: 'User', resolve: () => userSource() },
    comments: {
      type: 'IssueCommentConnection',
      resolve: (source) => {
        const repo = source.repo as Repo;
        const issue = source.issue as Issue;
        return {
          __typename: 'IssueCommentConnection',
          nodes: issue.comments.map((comment) => commentSource(repo, issue, comment)),
          totalCount: issue.comments.length,
        };
      },
    },
  },
  PullRequest: {
    id: { type: 'ID', resolve: (source) => pullGid(source.repo as Repo, source.pull as Pull) },
    number: { type: 'Int', resolve: (source) => (source.pull as Pull).number },
    title: { type: 'String', resolve: (source) => (source.pull as Pull).title },
    body: { type: 'String', resolve: (source) => (source.pull as Pull).body },
    state: {
      type: 'PullRequestState',
      resolve: (source) => {
        const pull = source.pull as Pull;
        return pull.merged ? 'MERGED' : pull.state.toUpperCase();
      },
    },
    merged: { type: 'Boolean', resolve: (source) => (source.pull as Pull).merged },
    mergedAt: { type: 'DateTime', resolve: (source) => (source.pull as Pull).mergedAt },
    mergeable: { type: 'MergeableState', resolve: (source) => pullMergeable(store, source.repo as Repo, source.pull as Pull) },
    headRefName: { type: 'String', resolve: (source) => (source.pull as Pull).headRef },
    baseRefName: { type: 'String', resolve: (source) => (source.pull as Pull).baseRef },
    files: { type: 'PullRequestChangedFileConnection', resolve: (source, args) => pullFilesConnection(source.repo as Repo, source.pull as Pull, args) },
    url: { type: 'URI', resolve: (source) => `/${(source.repo as Repo).owner}/${(source.repo as Repo).name}/pull/${(source.pull as Pull).number}` },
    createdAt: { type: 'DateTime', resolve: () => TRIAL_NOW_ISO },
    updatedAt: { type: 'DateTime', resolve: () => TRIAL_NOW_ISO },
    author: { type: 'User', resolve: () => userSource() },
  },
  IssueConnection: {
    nodes: { type: '[Issue]', resolve: prop('nodes') },
    pageInfo: { type: 'PageInfo', resolve: prop('pageInfo') },
    totalCount: { type: 'Int', resolve: prop('totalCount') },
  },
  PullRequestConnection: {
    nodes: { type: '[PullRequest]', resolve: prop('nodes') },
    pageInfo: { type: 'PageInfo', resolve: prop('pageInfo') },
    totalCount: { type: 'Int', resolve: prop('totalCount') },
  },
  PullRequestChangedFileConnection: {
    nodes: { type: '[PullRequestChangedFile]', resolve: prop('nodes') },
    totalCount: { type: 'Int', resolve: prop('totalCount') },
  },
  PullRequestChangedFile: {
    path: { type: 'String', resolve: prop('path') },
    additions: { type: 'Int', resolve: prop('additions') },
    deletions: { type: 'Int', resolve: prop('deletions') },
    changeType: { type: 'String', resolve: prop('changeType') },
  },
  IssueCommentConnection: {
    nodes: { type: '[IssueComment]', resolve: prop('nodes') },
    totalCount: { type: 'Int', resolve: prop('totalCount') },
  },
  IssueComment: {
    id: { type: 'ID', resolve: (source) => gid('comment', (source.repo as Repo).id, (source.issue as Issue).number, (source.comment as { id: number }).id) },
    body: { type: 'String', resolve: (source) => (source.comment as { body: string }).body },
    createdAt: { type: 'DateTime', resolve: () => TRIAL_NOW_ISO },
    author: { type: 'User', resolve: () => userSource() },
  },
  PageInfo: {
    hasNextPage: { type: 'Boolean', resolve: prop('hasNextPage') },
    hasPreviousPage: { type: 'Boolean', resolve: prop('hasPreviousPage') },
    startCursor: { type: 'String', resolve: prop('startCursor') },
    endCursor: { type: 'String', resolve: prop('endCursor') },
  },
  CreateIssuePayload: {
    issue: { type: 'Issue', resolve: prop('issue') },
    clientMutationId: { type: 'String', resolve: prop('clientMutationId') },
  },
  CloseIssuePayload: {
    issue: { type: 'Issue', resolve: prop('issue') },
    clientMutationId: { type: 'String', resolve: prop('clientMutationId') },
  },
  CreatePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: prop('pullRequest') },
    clientMutationId: { type: 'String', resolve: prop('clientMutationId') },
  },
  MergePullRequestPayload: {
    pullRequest: { type: 'PullRequest', resolve: prop('pullRequest') },
    clientMutationId: { type: 'String', resolve: prop('clientMutationId') },
  },
  AddCommentPayload: {
    commentEdge: { type: 'IssueCommentEdge', resolve: prop('commentEdge') },
    clientMutationId: { type: 'String', resolve: prop('clientMutationId') },
  },
  IssueCommentEdge: {
    node: { type: 'IssueComment', resolve: prop('node') },
    cursor: { type: 'String', resolve: prop('cursor') },
  },
  __Type: {
    name: { type: 'String', resolve: prop('name') },
    kind: { type: 'String', resolve: prop('kind') },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '[__Field]',
      resolve: (source) => {
        const def = TYPE_DEFS[String(source.name)];
        if (def === undefined || def.kind !== 'OBJECT') return null;
        return def.fields.map((name) => ({ __typename: '__Field', name }));
      },
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (source) => {
        const def = TYPE_DEFS[String(source.name)];
        if (def === undefined || def.kind !== 'ENUM') return null;
        return (def.enumValues ?? []).map((name) => ({ __typename: '__EnumValue', name }));
      },
    },
  },
  __Field: {
    name: { type: 'String', resolve: prop('name') },
    description: { type: 'String', resolve: () => null },
  },
  __EnumValue: {
    name: { type: 'String', resolve: prop('name') },
    description: { type: 'String', resolve: () => null },
  },
};

/** The introspection registry: object types mirror SCHEMA; enums carry their values. */
const TYPE_DEFS: Record<string, { kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues?: string[] }> = (() => {
  const defs: Record<string, { kind: 'OBJECT' | 'ENUM'; fields: string[]; enumValues?: string[] }> = {};
  for (const [type, fields] of Object.entries(SCHEMA)) {
    if (type.startsWith('__')) continue;
    defs[type] = { kind: 'OBJECT', fields: Object.keys(fields) };
  }
  const enums: Record<string, string[]> = {
    SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
    IssueState: ['OPEN', 'CLOSED'],
    PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
    MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
    OrderDirection: ['ASC', 'DESC'],
    IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
    PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
    RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  };
  for (const [name, values] of Object.entries(enums)) defs[name] = { kind: 'ENUM', fields: [], enumValues: values };
  return defs;
})();

function typeSource(name: string): Source | null {
  const def = TYPE_DEFS[name];
  if (def === undefined) return null;
  return { __typename: '__Type', name, kind: def.kind };
}

function findIssueByGid(id: string): { repo: Repo; issue: Issue } | undefined {
  const parts = decodeGid(id);
  if (parts === null || parts[0] !== 'issue') return undefined;
  const repo = store.repoById(Number(parts[1]));
  const item = repo?.items.get(Number(parts[2]));
  return repo !== undefined && item !== undefined && item.kind === 'issue' ? { repo, issue: item } : undefined;
}

function findPullByGid(id: string): { repo: Repo; pull: Pull } | undefined {
  const parts = decodeGid(id);
  if (parts === null || parts[0] !== 'pr') return undefined;
  const repo = store.repoById(Number(parts[1]));
  const item = repo?.items.get(Number(parts[2]));
  return repo !== undefined && item !== undefined && item.kind === 'pull' ? { repo, pull: item } : undefined;
}

// -------------------------------------------------------------------------------------------------
// executor
// -------------------------------------------------------------------------------------------------

function namedType(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

function executeSelectionSet(source: Source, typeName: string, selections: Selection[], ctx: Ctx, out: Record<string, unknown>): void {
  const typeFields = SCHEMA[typeName] ?? {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === undefined || selection.typeCondition === source.__typename || selection.typeCondition === typeName) {
        executeSelectionSet(source, selection.typeCondition ?? typeName, selection.selectionSet, ctx, out);
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.document.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === source.__typename || fragment.typeCondition === typeName)) {
        executeSelectionSet(source, fragment.typeCondition, fragment.selectionSet, ctx, out);
      }
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = source.__typename;
      continue;
    }
    const def = typeFields[field.name];
    if (def === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
    const value = def.resolve(source, args, ctx);
    out[key] = completeValue(value, def.type, field, ctx);
  }
}

function completeValue(value: unknown, type: string, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, type, field, ctx));
  if (typeof value === 'object') {
    const source = value as Source;
    if (field.selectionSet === undefined) return source;
    const out: Record<string, unknown> = {};
    executeSelectionSet(source, source.__typename ?? namedType(type), field.selectionSet, ctx, out);
    return out;
  }
  return value;
}

export interface GraphQLReply {
  status: number;
  body: unknown;
}

/** Execute one operation document (or a batch array of them). */
export function handleGraphQL(payload: unknown): GraphQLReply {
  if (Array.isArray(payload)) {
    return { status: 200, body: payload.map((entry) => executeOne(entry)) };
  }
  return { status: 200, body: executeOne(payload) };
}

function executeOne(payload: unknown): Record<string, unknown> {
  const body = (payload ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  if (typeof body.query !== 'string') {
    return { errors: [{ message: 'query is required' }] };
  }
  let document: Document;
  try {
    document = new Parser(tokenize(body.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const variables = (typeof body.variables === 'object' && body.variables !== null ? body.variables : {}) as Record<string, unknown>;
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation = document.operations.find((op) => operationName === undefined || op.name === operationName) ?? document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: Ctx = { variables, document, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const root: Source = { __typename: rootType };
  const data: Record<string, unknown> = {};
  executeSelectionSet(root, rootType, operation.selectionSet, ctx, data);
  const out: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}
