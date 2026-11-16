// forge.ts — the forge's single shared store: git objects, repositories, issues, pull requests.
//
// One in-memory store backs every surface (git smart HTTP, REST v3, GraphQL, MCP), so an object
// created through one surface is the same object on the others. Everything is deterministic:
// timestamps come only from MAKEFUN_TRIAL_NOW, ids from sequential counters, and no Math.random
// is consulted anywhere in an output.

import { createHash } from 'node:crypto';

/** The token owner's identity: the one seeded scenario user every surface serves. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The forge's clock: MAKEFUN_TRIAL_NOW (an ISO timestamp) or the scenario epoch as fallback. */
function trialEpochSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  const asNumber = Number(raw);
  if (raw !== '' && Number.isFinite(asNumber)) return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
  return 1_735_689_600;
}

export const TRIAL_EPOCH_SEC = trialEpochSec();
export const TRIAL_NOW_ISO = new Date(TRIAL_EPOCH_SEC * 1000).toISOString();
/** The author/committer line every forge-made commit carries. */
export const FORGE_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${TRIAL_EPOCH_SEC} +0000`;

export const ZERO_OID = '0000000000000000000000000000000000000000';

// -------------------------------------------------------------------------------------------------
// git objects
// -------------------------------------------------------------------------------------------------

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** SHA-1 over `<type> <size>\0` + data, as git names an object. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: { tree: string; parents: readonly string[]; author: string; committer: string; message: string }): Buffer {
  const lines = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`, `committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  const out: TagInfo = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) out.object = line.slice(7).trim();
    else if (line.startsWith('type ')) out.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) out.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) out.tagger = line.slice(7);
  }
  return out;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree order: byte-wise by name, with directories compared as if the name ended in '/'. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Follow a tag chain to the commit it ultimately names (or the object itself when not a tag). */
export function peelToCommit(store: Store, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = store.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

// -------------------------------------------------------------------------------------------------
// the store
// -------------------------------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface Comment {
  /** The global sequential comment id (REST `id`). */
  id: number;
  body: string;
}

export interface Issue {
  kind: 'issue';
  /** The global sequential id (REST `id`), distinct from the per-repo number. */
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}

export interface Pull {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** The branch tips when the pull was opened (the fallback when a branch later disappears). */
  headSha: string;
  baseSha: string;
}

export type RepoItem = Issue | Pull;

export interface Repo {
  /** The sequential database id (REST `id`, GraphQL `databaseId`). */
  id: number;
  owner: string;
  name: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  /** Full ref name -> object id. */
  refs: Map<string, string>;
  labels: Map<string, Label>;
  /** The shared issue/pull number space, by number. */
  items: Map<number, RepoItem>;
  nextNumber: number;
}

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  private repoSeq = 0;
  private itemSeq = 0;
  private commentSeq = 0;
  private requestSeq = 0;

  /** A deterministic per-process request id (X-GitHub-Request-Id). */
  nextRequestId(): string {
    this.requestSeq += 1;
    return `FORGE-${String(this.requestSeq).padStart(8, '0')}`;
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    this.repoSeq += 1;
    const repo: Repo = {
      id: this.repoSeq,
      owner: VIEWER_LOGIN,
      name,
      isPrivate,
      description,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      nextNumber: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  /** A repo by owner/name; any owner but the token's is a miss (the surfaces answer 404). */
  repo(owner: string, name: string): Repo | undefined {
    if (owner !== VIEWER_LOGIN) return undefined;
    return this.repos.get(name);
  }

  repoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  nextItemId(): number {
    this.itemSeq += 1;
    return this.itemSeq;
  }

  nextCommentId(): number {
    this.commentSeq += 1;
    return this.commentSeq;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      kind: 'issue',
      id: this.nextItemId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
    };
    repo.nextNumber += 1;
    repo.items.set(issue.number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): Pull {
    const pull: Pull = {
      kind: 'pull',
      id: this.nextItemId(),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
    };
    repo.nextNumber += 1;
    repo.items.set(pull.number, pull);
    return pull;
  }

  issues(repo: Repo): Issue[] {
    return [...repo.items.values()].filter((item): item is Issue => item.kind === 'issue');
  }

  pulls(repo: Repo): Pull[] {
    return [...repo.items.values()].filter((item): item is Pull => item.kind === 'pull');
  }
}

/** The one store every surface shares. */
export const store = new Store();

// -------------------------------------------------------------------------------------------------
// tree <-> file-map helpers (contents API, merges, diffs)
// -------------------------------------------------------------------------------------------------

/** Flatten a tree (recursively) into path -> blob oid. */
export function flattenTree(store: Store, treeOid: string | null, prefix = '', out = new Map<string, string>()): Map<string, string> {
  if (treeOid === null || treeOid === ZERO_OID) return out;
  const object = store.objects.get(treeOid);
  if (object === undefined || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(store, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
  return out;
}

/** Build (and store) a tree hierarchy from a path -> blob oid map; answers the root tree oid. */
export function buildTreeFromFiles(store: Store, files: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, oid] of files) {
    const segments = path.split('/');
    let node = root;
    for (let index = 0; index < segments.length - 1; index += 1) {
      const name = segments[index]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return store.putObject('tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid of a commit (following a tag if handed one). */
export function commitTree(store: Store, oid: string): string | null {
  const commitOid = peelToCommit(store, oid);
  const object = store.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** The file map at a commit: path -> blob oid. */
export function filesAt(store: Store, commitOid: string): Map<string, string> {
  const tree = commitTree(store, commitOid);
  return tree === null ? new Map() : flattenTree(store, tree);
}

/** Make a commit on top of `parent` (or a root commit) holding exactly `files`. */
export function commitFiles(store: Store, parent: string | null, files: ReadonlyMap<string, string>, message: string): string {
  const tree = buildTreeFromFiles(store, files);
  const data = buildCommit({
    tree,
    parents: parent === null ? [] : [parent],
    author: FORGE_IDENTITY,
    committer: FORGE_IDENTITY,
    message,
  });
  return store.putObject('commit', data);
}

/** Every object reachable from the tips (commits, their trees and blobs, tags), tips included. */
export function collectReachable(store: Store, tips: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || oid === ZERO_OID) continue;
    const object = store.objects.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree, ...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** Whether `ancestor` is `descendant` itself or reachable from it through parent links. */
export function isAncestor(store: Store, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.objects.get(oid);
    if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  return false;
}

/** The best common ancestor of two commits (the merge base), or null when unrelated. */
export function mergeBase(store: Store, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = store.objects.get(oid);
    if (object !== undefined && object.type === 'commit') stack.push(...parseCommit(object.data).parents);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsOfA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.objects.get(oid);
    if (object !== undefined && object.type === 'commit') queue.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** Commits reachable from `tip`, newest first (a DFS pre-order over parents, duplicates removed). */
export function listCommits(store: Store, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const object = store.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    out.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let index = parents.length - 1; index >= 0; index -= 1) stack.push(parents[index]!);
  }
  return out;
}

// -------------------------------------------------------------------------------------------------
// pull-request diff and squash merge
// -------------------------------------------------------------------------------------------------

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts of a diff between two blob bodies, via a longest-common-subsequence walk. */
export function lineDiff(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const a = before === null ? [] : linesOf(before);
  const b = after === null ? [] : linesOf(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  // LCS lengths over suffixes, one row at a time.
  let prev = new Array<number>(b.length + 1).fill(0);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = new Array<number>(b.length + 1).fill(0);
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? prev[j + 1]! + 1 : Math.max(prev[j]!, row[j + 1]!);
    }
    prev = row;
  }
  const common = prev[0]!;
  return { additions: b.length - common, deletions: a.length - common };
}

/** The changed files between two commits' trees (merge-base -> head for a pull request). */
export function diffCommits(store: Store, fromCommit: string | null, toCommit: string): FileChange[] {
  const before = fromCommit === null ? new Map<string, string>() : filesAt(store, fromCommit);
  const after = filesAt(store, toCommit);
  const changes: FileChange[] = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = before.get(path);
    const newOid = after.get(path);
    if (oldOid === newOid) continue;
    const oldData = oldOid === undefined ? null : (store.objects.get(oldOid)?.data ?? null);
    const newData = newOid === undefined ? null : (store.objects.get(newOid)?.data ?? null);
    const { additions, deletions } = lineDiff(oldData, newData);
    changes.push({
      filename: path,
      status: oldOid === undefined ? 'added' : newOid === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return changes;
}

/**
 * A file-level three-way merge of `head` into `base` against their merge base.
 * Answers the merged file map, or null when both sides changed the same path differently.
 */
export function threeWayMerge(
  store: Store,
  baseTip: string,
  headTip: string,
): { files: Map<string, string>; mergeBase: string | null } | null {
  const base = mergeBase(store, baseTip, headTip);
  const baseFiles = base === null ? new Map<string, string>() : filesAt(store, base);
  const ours = filesAt(store, baseTip);
  const theirs = filesAt(store, headTip);
  const merged = new Map<string, string>();
  const paths = new Set([...baseFiles.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const ancestor = baseFiles.get(path);
    const our = ours.get(path);
    const their = theirs.get(path);
    if (their === ancestor) {
      if (our !== undefined) merged.set(path, our);
    } else if (our === ancestor) {
      if (their !== undefined) merged.set(path, their);
    } else if (our === their) {
      if (our !== undefined) merged.set(path, our);
    } else {
      return null;
    }
  }
  return { files: merged, mergeBase: base };
}

/** Squash-merge a pull request: one new commit on the base branch carrying the head's changes. */
export function squashMerge(store: Store, repo: Repo, pull: Pull): { sha: string } | { conflict: true } | { gone: true } {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (baseTip === undefined) return { gone: true };
  const result = threeWayMerge(store, baseTip, headTip);
  if (result === null) return { conflict: true };
  const sha = commitFiles(store, baseTip, result.files, `${pull.title}\n\n${pull.body}`.trimEnd());
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = TRIAL_NOW_ISO;
  pull.mergeCommitSha = sha;
  return { sha };
}

/** Whether a pull request would merge cleanly right now (GraphQL's `mergeable`). */
export function pullMergeable(store: Store, repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' {
  if (pull.state !== 'open') return 'CONFLICTING';
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  if (baseTip === undefined) return 'CONFLICTING';
  return threeWayMerge(store, baseTip, headTip) === null ? 'CONFLICTING' : 'MERGEABLE';
}
