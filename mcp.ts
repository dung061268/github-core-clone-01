// mcp.ts — the MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP, speaking the modern
// 2026-07-28 revision through server/discover and the legacy initialize handshake. The six tools
// act on forge.ts's shared store, so an object made here is the same object REST reads back.

import { squashMerge, store, type Repo } from './forge.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const SERVER_INFO = { name: 'github-core-clone-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (args: Record<string, unknown>) => Record<string, unknown> | unknown[];
}

class ToolError extends Error {}

function repoOf(args: Record<string, unknown>): Repo {
  const owner = String(args.owner ?? '');
  const name = String(args.repo ?? '');
  const repo = store.repo(owner, name);
  if (repo === undefined) throw new ToolError(`repository ${owner}/${name} not found`);
  return repo;
}

function textResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

/** The tool table: built once, so tools/list answers byte-identically on every call. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (args) => {
      const name = String(args.name ?? '');
      if (name === '') throw new ToolError('name is required');
      if (store.repos.has(name)) throw new ToolError(`a repository named ${name} already exists`);
      const repo = store.createRepo(name, args.private === true, typeof args.description === 'string' ? args.description : '');
      return repoJson(repo);
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
    run: (args) => repoJson(repoOf(args)),
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (args) => {
      const repo = repoOf(args);
      const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
      return issueJson(repo, issue);
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
    run: (args) => {
      const repo = repoOf(args);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = store.issues(repo);
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return issues.map((issue) => issueJson(repo, issue));
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch to merge from.' },
      base: { type: 'string', description: 'The base branch to merge into.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (args) => {
      const repo = repoOf(args);
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined) throw new ToolError(`head branch ${head} does not exist`);
      if (baseSha === undefined) throw new ToolError(`base branch ${base} does not exist`);
      const existing = store.pulls(repo).find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
      if (existing !== undefined) return pullJson(repo, existing);
      const pull = store.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base, headSha, baseSha);
      return pullJson(repo, pull);
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) by its number.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (args) => {
      const repo = repoOf(args);
      const number = Number(args.pull_number);
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') throw new ToolError(`pull request #${number} not found`);
      if (item.state === 'open') {
        const result = squashMerge(store, repo, item);
        if ('conflict' in result) throw new ToolError('pull request is not mergeable');
        if ('gone' in result) throw new ToolError('the base branch is gone');
      }
      return pullJson(repo, item);
    },
  },
];

const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

export interface McpReply {
  status: number;
  /** The JSON body; undefined means an empty body (a notification acknowledgement). */
  body?: unknown;
}

/** Handle one raw /mcp request body (already authenticated by app.ts). */
export function handleMcp(rawBody: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const answers = parsed.map((entry) => handleOne(entry)).filter((answer) => answer !== undefined);
    return { status: 200, body: answers };
  }
  const answer = handleOne(parsed);
  if (answer === undefined) return { status: 202 };
  return { status: 200, body: answer };
}

function handleOne(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== 'object' || message === null) {
    return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };
  }
  const request = message as { id?: unknown; method?: unknown; params?: unknown };
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  if (id === undefined || id === null) {
    // A notification: nothing to answer.
    return undefined;
  }
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;
  const ok = (result: unknown): Record<string, unknown> => ({ jsonrpc: '2.0', id, result });
  const failWith = (code: number, message: string): Record<string, unknown> => ({ jsonrpc: '2.0', id, error: { code, message } });

  switch (method) {
    case 'server/discover':
      return ok({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return ok({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok(TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (tool === undefined) return failWith(-32602, `unknown tool: ${name}`);
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const missing = tool.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return failWith(-32602, `missing required argument(s): ${missing.join(', ')}`);
      try {
        return ok(textResult(tool.run(args)));
      } catch (err) {
        if (err instanceof ToolError) {
          return ok({ content: [{ type: 'text', text: err.message }], isError: true });
        }
        throw err;
      }
    }
    default:
      return failWith(-32601, `method not found: ${method}`);
  }
}
