// git.ts — git smart HTTP: pkt-lines, packfiles, upload-pack (protocol v2 ls-refs + fetch, v0 fetch
// fallback) and receive-pack v0 with report-status inside side-band-64k. Objects live in forge.ts's
// shared store, so anything pushed here is immediately visible to the REST contents API and back.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectReachable,
  isAncestor,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  store,
  type GitObjectType,
  type Repo,
  type Store,
} from './forge.ts';

// -------------------------------------------------------------------------------------------------
// pkt-lines
// -------------------------------------------------------------------------------------------------

const PKT_MAX = 65_520;

export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Decode a whole pkt-line stream; throws on a malformed frame. */
export function decodePktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const hex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
    } else if (length < 4 || offset + length > buffer.length) {
      throw new Error(`bad pkt-line length ${length}`);
    } else {
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

// -------------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------------

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** A version-2 pack of plain (never delta) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly { type: GitObjectType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    let size = object.data.length;
    const first = (TYPE_CODES[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    const bytes: number[] = [];
    if (size > 0) {
      bytes.push(first | 0x80);
      while (size > 0) {
        const byte = size & 0x7f;
        size >>= 7;
        bytes.push(size > 0 ? byte | 0x80 : byte);
      }
    } else {
      bytes.push(first);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset]!;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // base size
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset]!;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset]! << (8 * bit);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op > 0) {
      out.push(delta.subarray(offset, offset + op));
      produced += op;
      offset += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta size mismatch');
  return result;
}

interface RawEntry {
  type: GitObjectType;
  data: Buffer;
}

/** Read a pack into the store; resolves OFS_DELTA and REF_DELTA. Throws on any structural problem. */
export function readPackInto(store: Store, pack: Buffer): number {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (computed !== pack.subarray(trailerStart).toString('hex')) throw new Error('pack checksum mismatch');

  const entries: RawEntry[] = [];
  const byOffset = new Map<number, number>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset]!;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset]!;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOffset = 0;
    let baseOid = '';
    if (typeCode === 6) {
      byte = pack[offset]!;
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset]!;
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = entryOffset - back;
    } else if (typeCode === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateAt(pack, offset);
    offset = inflated.next;
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    if (typeCode === 6 || typeCode === 7) {
      entries.push({ type: 'blob', data: inflated.data, ...(typeCode === 6 ? { ofsBase: baseOffset } : { refBase: baseOid }) } as RawEntry & {
        ofsBase?: number;
        refBase?: string;
      });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      entries.push({ type, data: inflated.data });
    }
    byOffset.set(entryOffset, index);
  }

  const resolved: (RawEntry | undefined)[] = new Array(entries.length).fill(undefined);
  const resolve = (index: number): RawEntry => {
    const cached = resolved[index];
    if (cached !== undefined) return cached;
    const entry = entries[index]! as RawEntry & { ofsBase?: number; refBase?: string };
    let out: RawEntry;
    if (entry.ofsBase !== undefined) {
      const baseIndex = byOffset.get(entry.ofsBase);
      if (baseIndex === undefined) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseIndex);
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.refBase !== undefined) {
      let base: RawEntry | undefined;
      const stored = store.objects.get(entry.refBase);
      if (stored !== undefined) base = { type: stored.type, data: stored.data };
      if (base === undefined) {
        for (const candidate of byOffset.values()) {
          if (candidate === index) continue;
          try {
            const resolvedCandidate = resolve(candidate);
            if (storeHash(resolvedCandidate) === entry.refBase) {
              base = resolvedCandidate;
              break;
            }
          } catch {
            // not this candidate's chain; keep looking
          }
        }
      }
      if (base === undefined) throw new Error('ref-delta base not found');
      out = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      out = { type: entry.type, data: entry.data };
    }
    resolved[index] = out;
    return out;
  };
  const storeHash = (entry: RawEntry): string => {
    const header = Buffer.from(`${entry.type} ${entry.data.length}\0`, 'utf8');
    return createHash('sha1').update(header).update(entry.data).digest('hex');
  };
  let stored = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = resolve(index);
    store.putObject(entry.type, entry.data);
    stored += 1;
  }
  return stored;
}

// -------------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = 'multi_ack_detailed side-band-64k thin-pack ofs-delta shallow agent=forge/1.0';
const RECEIVE_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The v0 ref advertisement lines shared by upload-pack and receive-pack. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headTarget);
  const fullCaps = `${caps} symref=HEAD:${headTarget}`;
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${fullCaps}`));
  } else {
    let first = true;
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD\0${fullCaps}`));
      first = false;
    }
    for (const [ref, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${ref}\0${fullCaps}` : `${oid} ${ref}`));
      first = false;
      const target = store.objects.get(oid);
      if (target !== undefined && target.type === 'tag') {
        parts.push(pktLine(`${peelToCommit(store, oid)} ${ref}^{}`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// -------------------------------------------------------------------------------------------------
// fetch object selection
// -------------------------------------------------------------------------------------------------

interface FetchPlan {
  objects: { type: GitObjectType; data: Buffer }[];
  shallow: string[];
  unshallow: string[];
}

/**
 * What a fetch sends: objects reachable from the wants, minus everything reachable from the haves,
 * cut at `depth` commit generations when a depth is in force. Boundary commits (included, with a
 * parent left out) are reported as shallow; client-shallow commits the fetch fully covers are
 * reported as unshallow.
 */
export function planFetch(store: Store, wants: readonly string[], haves: readonly string[], clientShallow: readonly string[], depth: number | null): FetchPlan {
  // The haves' closure — except that a commit the client holds *shallow* is a cut point: the client
  // has the commit and its tree, but not its parents, so the parents do not count as held.
  const shallowSet = new Set(clientShallow);
  const haveClosure = new Set<string>();
  const haveStack = [...haves];
  while (haveStack.length > 0) {
    const oid = haveStack.pop()!;
    if (haveClosure.has(oid) || oid === ZERO_OID) continue;
    const object = store.objects.get(oid);
    if (object === undefined) continue;
    haveClosure.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      haveStack.push(commit.tree);
      if (!shallowSet.has(oid)) haveStack.push(...commit.parents);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) haveStack.push(entry.oid);
    } else if (object.type === 'tag') {
      haveStack.push(parseTag(object.data).object);
    }
  }

  // Commit generations from the wants (BFS over parents), tags peeled to commits first.
  const generation = new Map<string, number>();
  const queue: string[] = [];
  for (const want of wants) {
    const commit = peelToCommit(store, want);
    if (!generation.has(commit)) {
      generation.set(commit, 1);
      queue.push(commit);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift()!;
    const gen = generation.get(oid)!;
    if (depth !== null && gen >= depth) continue;
    const object = store.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!generation.has(parent)) {
        generation.set(parent, gen + 1);
        queue.push(parent);
      }
    }
  }

  const includedCommits = new Set<string>();
  for (const [oid, gen] of generation) {
    if (depth === null || gen <= depth) includedCommits.add(oid);
  }

  const boundary = new Set<string>();
  if (depth !== null) {
    for (const oid of includedCommits) {
      const object = store.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.some((parent) => !includedCommits.has(parent))) boundary.add(oid);
    }
  }

  // Everything reachable from the included commits and from non-commit wants (tags), with commit
  // traversal stopped at the boundary: an included commit's tree and blobs always travel.
  const send = new Set<string>();
  const stack: string[] = [];
  for (const want of wants) {
    const object = store.objects.get(want);
    if (object !== undefined && object.type !== 'commit') stack.push(want);
  }
  for (const oid of includedCommits) stack.push(oid);
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (send.has(oid) || haveClosure.has(oid)) continue;
    const object = store.objects.get(oid);
    if (object === undefined) continue;
    send.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) if (includedCommits.has(parent)) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }

  const unshallow: string[] = [];
  for (const oid of clientShallow) {
    if (includedCommits.has(oid) && !boundary.has(oid)) unshallow.push(oid);
  }

  const objects = [...send]
    .map((oid) => store.objects.get(oid)!)
    .filter((object) => object !== undefined)
    .map((object) => ({ type: object.type, data: object.data }));
  return { objects, shallow: [...boundary].sort(), unshallow: unshallow.sort() };
}

/** Wrap pack bytes in side-band-64k pkt-lines (band 1), as a fetch/push section body. */
export function sidebandWrap(pack: Buffer, chunkSize = 32_000): Buffer[] {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    if (payload.length + 4 > PKT_MAX) throw new Error('sideband chunk too large');
    parts.push(pktLine(payload));
  }
  return parts;
}

// -------------------------------------------------------------------------------------------------
// request handlers (called by app.ts with the repo already resolved)
// -------------------------------------------------------------------------------------------------

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

export function infoRefs(repo: Repo | undefined, service: string, protocolV2: boolean): GitResponse {
  if (repo === undefined) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
  if (service === 'git-upload-pack') {
    if (protocolV2) {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v2Advertisement() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: v0Advertisement(repo, 'git-upload-pack', UPLOAD_CAPS_V0) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack', RECEIVE_CAPS) };
  }
  return { status: 404, contentType: 'text/plain', body: Buffer.from('unknown service\n') };
}

interface V2Command {
  command: string;
  args: string[];
}

/** Parse a protocol-v2 request body: header lines, a delim, then argument lines to the flush. */
function parseV2Request(body: Buffer): V2Command {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let sawDelim = false;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!sawDelim) lines.push(line);
    else args.push(line);
  }
  const commandLine = lines.find((line) => line.startsWith('command='));
  if (commandLine === undefined) throw new Error('no command line');
  return { command: commandLine.slice('command='.length), args };
}

function lsRefsResponse(repo: Repo, args: readonly string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headTarget);
  if (symrefs && matches('HEAD')) {
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD symref-target:${headTarget}\n`));
    } else if (unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    const target = store.objects.get(oid);
    if (peel && target !== undefined && target.type === 'tag') line += ` peeled:${peelToCommit(store, oid)}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, wants: string[], haves: string[], shallowLines: string[], depth: number | null, v2: boolean): Buffer {
  const plan = planFetch(store, wants, haves, shallowLines, depth);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [];
  if (v2) {
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandWrap(pack));
    parts.push(PKT_FLUSH);
  } else {
    parts.push(pktLine('NAK\n'));
    parts.push(...sidebandWrap(pack));
    parts.push(PKT_FLUSH);
  }
  return Buffer.concat(parts);
}

export function uploadPack(repo: Repo | undefined, body: Buffer, protocolV2: boolean): GitResponse {
  if (repo === undefined) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
  try {
    if (protocolV2) {
      const { command, args } = parseV2Request(body);
      if (command === 'ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(repo, args) };
      }
      if (command === 'fetch') {
        const wants: string[] = [];
        const haves: string[] = [];
        const shallowLines: string[] = [];
        let depth: number | null = null;
        for (const arg of args) {
          if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
          else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
          else if (arg.startsWith('shallow ')) shallowLines.push(arg.slice(8).trim());
          else if (arg.startsWith('deepen ')) depth = Number.parseInt(arg.slice(7).trim(), 10);
        }
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, wants, haves, shallowLines, depth, true) };
      }
      return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown command\n') };
    }
    // Protocol v0: wants in the first section, haves and done after a flush.
    const packets = decodePktLines(body);
    const wants: string[] = [];
    const haves: string[] = [];
    const shallowLines: string[] = [];
    let depth: number | null = null;
    let section = 0;
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section += 1;
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = packet.payload.toString('utf8').replace(/\n$/, '');
      if (section === 0) {
        if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
        else if (line.startsWith('shallow ')) shallowLines.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
      } else if (line.startsWith('have ')) {
        haves.push(line.slice(5).trim());
      }
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponse(repo, wants, haves, shallowLines, depth, false) };
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }
}

interface PushCommandLine {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function receivePack(repo: Repo | undefined, body: Buffer): GitResponse {
  if (repo === undefined) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
  let commands: PushCommandLine[] = [];
  let pack = Buffer.alloc(0);
  let sideband = false;
  try {
    // Walk the pkt-line command list by hand so the pack bytes after the flush survive intact.
    let offset = 0;
    for (;;) {
      if (offset + 4 > body.length) throw new Error('truncated command list');
      const hex = body.subarray(offset, offset + 4).toString('ascii');
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('bad pkt-line in command list');
      const length = parseInt(hex, 16);
      offset += 4;
      if (length === 0) break;
      if (length < 4 || offset + length - 4 > body.length) throw new Error('bad command line length');
      let line = body.subarray(offset, offset + length - 4).toString('utf8');
      offset += length - 4;
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        const caps = line.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) sideband = true;
        line = line.slice(0, nul);
      }
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)\n?$/.exec(line);
      if (match === null) throw new Error('bad ref update line');
      commands.push({ oldOid: match[1]!, newOid: match[2]!, ref: match[3]! });
    }
    pack = body.subarray(offset);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (pack.length > 0) {
    try {
      readPackInto(store, pack);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'index-pack failed';
    }
  }

  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const command of commands) {
    const fail = (reason: string): void => {
      reportLines.push(`ng ${command.ref} ${reason}\n`);
    };
    if (!unpackOk) {
      fail('unpacker error');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      fail('reference is outdated');
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = store.objects.get(command.newOid);
    if (target === undefined) {
      fail('not our ref');
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== command.newOid) {
      const oldCommit = peelToCommit(store, command.oldOid);
      const newCommit = peelToCommit(store, command.newOid);
      if (!isAncestor(store, oldCommit, newCommit)) {
        fail('non-fast-forward');
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const report = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let responseBody: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    for (let offset = 0; offset < report.length; offset += 32_000) {
      const chunk = report.subarray(offset, Math.min(report.length, offset + 32_000));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    }
    parts.push(PKT_FLUSH);
    responseBody = Buffer.concat(parts);
  } else {
    responseBody = report;
  }
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: responseBody };
}
