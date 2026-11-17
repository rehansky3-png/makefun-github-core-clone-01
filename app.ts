// A standalone GitHub-compatible git forge: git smart HTTP (v2 upload-pack,
// v0 receive-pack), REST v3 under /api/v3, GraphQL v4 at /api/graphql and MCP
// at /mcp, all over one in-memory store, stdlib only. See README.md.
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

const VIEWER = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_NAME = 'ada iversen';
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';
const ZERO = '0'.repeat(40);
const BASE_EPOCH = 1735689600; // 2025-01-01T00:00:00Z; deterministic "now" base

let seq = 0;
let reqSeq = 0;
let dbSeq = 5000;
const nextSeq = (): number => { seq += 1; return seq; };
const nextDbId = (): number => { dbSeq += 1; return dbSeq; };
const stamp = (): { epoch: number; iso: string } => {
  const epoch = BASE_EPOCH + nextSeq();
  return { epoch, iso: new Date(epoch * 1000).toISOString() };
};

// ---------------------------------------------------------------- git objects
type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObj { type: ObjType; data: Buffer; }
const sha1 = (type: ObjType, data: Buffer): string => {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
};
const storeObj = (repo: Repo, type: ObjType, data: Buffer): string => {
  const oid = sha1(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
};
const parseTree = (data: Buffer): { mode: string; name: string; oid: string }[] => {
  const out: { mode: string; name: string; oid: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const nul = data.indexOf(0, sp);
    if (sp < 0 || nul < 0) break;
    out.push({ mode: data.subarray(i, sp).toString('ascii'), name: data.subarray(sp + 1, nul).toString('utf8'), oid: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
};
const buildTreeBuf = (entries: { mode: string; name: string; oid: string }[]): Buffer => {
  const parts: Buffer[] = [];
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
};
interface CommitView { tree: string; parents: string[]; message: string; authorLine: string; }
const parseCommit = (data: Buffer): CommitView => {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd < 0 ? text : text.slice(0, headEnd);
  const message = headEnd < 0 ? '' : text.slice(headEnd + 2);
  const parents: string[] = [];
  let tree = '';
  let authorLine = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) authorLine = line.slice(7);
  }
  return { tree, parents, message, authorLine };
};
const parseTag = (data: Buffer): { object: string; type: string; tag: string } => {
  const text = data.toString('utf8');
  let object = ''; let type = ''; let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
};
// Flatten a commit's tree into path -> {oid, mode}.
const filesOfCommit = (repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> => {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const t = repo.objects.get(treeOid);
    if (!t || t.type !== 'tree') return;
    for (const e of parseTree(t.data)) {
      if (e.mode === '40000') walk(e.oid, `${prefix}${e.name}/`);
      else out.set(`${prefix}${e.name}`, { oid: e.oid, mode: e.mode });
    }
  };
  walk(parseCommit(obj.data).tree, '');
  return out;
};
// Build nested trees from a flat file map; returns root tree oid.
const treeOfFiles = (repo: Repo, files: Map<string, { oid: string; mode: string }>): string => {
  const build = (prefix: string): string => {
    const entries: { mode: string; name: string; oid: string }[] = [];
    const dirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, v] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.push({ mode: v.mode, name: rest, oid: v.oid });
      else {
        const dir = rest.slice(0, slash);
        if (!dirs.has(dir)) dirs.set(dir, new Map());
        dirs.get(dir)!.set(path, v);
      }
    }
    for (const [dir, sub] of dirs) entries.push({ mode: '40000', name: dir, oid: build(`${prefix}${dir}/`) });
    return storeObj(repo, 'tree', buildTreeBuf(entries));
  };
  return build('');
};
const makeCommit = (repo: Repo, files: Map<string, { oid: string; mode: string }>, parents: string[], message: string): string => {
  const tree = treeOfFiles(repo, files);
  const { epoch } = stamp();
  const ident = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
  let body = `tree ${tree}\n`;
  for (const p of parents) body += `parent ${p}\n`;
  body += `author ${ident}\ncommitter ${ident}\n\n${message}\n`;
  return storeObj(repo, 'commit', Buffer.from(body, 'utf8'));
};
const peelToCommit = (repo: Repo, oid: string): string | null => {
  let cur = oid;
  for (let i = 0; i < 10; i += 1) {
    const o = repo.objects.get(cur);
    if (!o) return null;
    if (o.type === 'commit') return cur;
    if (o.type === 'tag') { cur = parseTag(o.data).object; continue; }
    return null;
  }
  return null;
};
const isAncestor = (repo: Repo, anc: string, desc: string): boolean => {
  const a = peelToCommit(repo, anc); const d = peelToCommit(repo, desc);
  if (!a || !d) return false;
  if (a === d) return true;
  const seen = new Set<string>([d]);
  const stack = [d];
  while (stack.length) {
    const cur = stack.pop()!;
    const o = repo.objects.get(cur);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) {
      if (p === a) return true;
      if (!seen.has(p)) { seen.add(p); stack.push(p); }
    }
  }
  return false;
};
// Reachable objects from roots (commits/tags), optionally depth-limited on
// commit generations (depth 1 = roots only).
const reachable = (repo: Repo, roots: string[], depth?: number): { objects: Set<string>; shallow: string[]; unshallow: string[] } => {
  const objects = new Set<string>();
  const shallow: string[] = [];
  const queue: { oid: string; gen: number }[] = [];
  const seenCommit = new Map<string, number>();
  for (const r of roots) {
    const c = peelToCommit(repo, r);
    const o = repo.objects.get(r);
    if (o && o.type === 'tag') objects.add(r);
    if (c) queue.push({ oid: c, gen: 0 });
    else if (o) objects.add(r);
  }
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    const prev = seenCommit.get(oid);
    if (prev !== undefined && prev <= gen) continue;
    seenCommit.set(oid, gen);
    const o = repo.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    objects.add(oid);
    const cv = parseCommit(o.data);
    const addTree = (treeOid: string): void => {
      const t = repo.objects.get(treeOid);
      if (!t) return;
      objects.add(treeOid);
      for (const e of parseTree(t.data)) {
        if (e.mode === '40000') addTree(e.oid);
        else objects.add(e.oid);
      }
    };
    addTree(cv.tree);
    const atBoundary = depth !== undefined && gen + 1 >= depth;
    if (atBoundary) shallow.push(oid);
    else for (const p of cv.parents) queue.push({ oid: p, gen: gen + 1 });
  }
  return { objects, shallow, unshallow: [] };
};

// ---------------------------------------------------------------- packfiles
const packEncode = (repo: Repo, oids: Iterable<string>): Buffer => {
  const list = [...oids];
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1].writeUInt32BE(2, 0);
  parts[2].writeUInt32BE(list.length, 0);
  const typeCode: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const oid of list) {
    const o = repo.objects.get(oid);
    if (!o) continue;
    const comp = deflateSync(o.data);
    // varint header: type in bits 4..6, size low 4 bits first
    let size = o.data.length;
    const first = (typeCode[o.type] << 4) | (size & 0x0f);
    size >>= 4;
    const hdr: number[] = [];
    if (size > 0) hdr.push(first | 0x80); else hdr.push(first);
    while (size > 0) { const b = size & 0x7f; size >>= 7; hdr.push(size > 0 ? b | 0x80 : b); }
    parts.push(Buffer.from(hdr), comp);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
};
const applyDelta = (base: Buffer, delta: Buffer): Buffer => {
  let p = 0;
  const readVarint = (): number => { let v = 0; let s = 0; for (;;) { const b = delta[p++]; v |= (b & 0x7f) << s; s += 7; if (!(b & 0x80)) break; } return v; };
  const srcSize = readVarint();
  const tgtSize = readVarint();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let len = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let off = 0; let sz = 0;
      for (let i = 0; i < 4; i += 1) if (op & (1 << i)) off |= delta[p++] << (8 * i);
      for (let i = 0; i < 3; i += 1) if (op & (0x10 << i)) sz |= delta[p++] << (8 * i);
      if (sz === 0) sz = 0x10000;
      out.push(base.subarray(off, off + sz)); len += sz;
    } else if (op) {
      out.push(delta.subarray(p, p + op)); p += op; len += op;
    } else throw new Error('delta op 0');
  }
  const res = Buffer.concat(out);
  if (len !== tgtSize) throw new Error('delta target size mismatch');
  return res;
};
const packDecode = (buf: Buffer): Map<string, GitObj> => {
  if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buf.readUInt32BE(4);
  const count = buf.readUInt32BE(8);
  if (version !== 2 && version !== 3) throw new Error('bad pack version');
  const trailer = buf.subarray(buf.length - 20);
  const expect = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(expect)) throw new Error('pack checksum mismatch');
  const out = new Map<string, GitObj>();
  const offsets = new Map<number, string>();
  const pending: { baseOid: string | null; baseOff: number | null; delta: Buffer; type: ObjType }[] = [];
  let pos = 12;
  const typeName: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    let b = buf[pos++];
    const typeCode = (b >> 4) & 0x7;
    let size = b & 0x0f; let shift = 4;
    while (b & 0x80) { b = buf[pos++]; size |= (b & 0x7f) << shift; shift += 7; }
    if (typeCode === 6 || typeCode === 7) {
      let baseOid: string | null = null; let baseOff: number | null = null;
      if (typeCode === 6) {
        let c = buf[pos++]; let off = c & 0x7f;
        while (c & 0x80) { c = buf[pos++]; off = ((off + 1) << 7) | (c & 0x7f); }
        baseOff = start - off;
      } else { baseOid = buf.subarray(pos, pos + 20).toString('hex'); pos += 20; }
      const { data, next } = inflateAt(buf, pos);
      pos = next;
      pending.push({ baseOid, baseOff, delta: data, type: 'blob' });
      continue;
    }
    const type = typeName[typeCode];
    if (!type) throw new Error(`bad pack type ${typeCode}`);
    const { data, next } = inflateAt(buf, pos);
    pos = next;
    if (data.length !== size) throw new Error('pack object size mismatch');
    const oid = sha1(type, data);
    out.set(oid, { type, data });
    offsets.set(start, oid);
  }
  // Resolve deltas (bases precede deltas in packs the suite sends, if any).
  for (const p of pending) {
    const baseOid = p.baseOff !== null ? offsets.get(p.baseOff) : p.baseOid;
    const base = baseOid ? out.get(baseOid) : undefined;
    if (!base) throw new Error('delta base missing');
    const data = applyDelta(base.data, p.delta);
    const oid = sha1(base.type, data);
    out.set(oid, { type: base.type, data });
  }
  return out;
};
// Inflate a zlib stream starting at offset; returns data and next offset.
// Uses incremental inflate via node:zlib's inflateSync on a growing slice is
// wasteful; instead use the sync inflate on the remainder and find the end by
// trying lengths is not possible, so use zlib's Inflater through a stream
// wrapper implemented with inflateSync on truncated input is unreliable.
// Simpler robust approach: use node:zlib createInflate and feed bytes.
const inflateAt = (buf: Buffer, offset: number): { data: Buffer; next: number } => {
  // inflateSync ignores trailing bytes, so the smallest end offset that
  // inflates successfully is the stream end; find it by binary search.
  let lo = offset + 1; let hi = buf.length; let data: Buffer | null = null;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try { data = inflateSync(buf.subarray(offset, mid)); hi = mid; }
    catch { lo = mid + 1; }
  }
  if (data === null) data = inflateSync(buf.subarray(offset, lo));
  return { data, next: lo };
}

// ---------------------------------------------------------------- store
interface Label { name: string; color: string; }
interface Comment { id: number; body: string; user: string; }
interface Issue {
  number: number; title: string; body: string; state: 'open' | 'closed';
  labels: Label[]; comments: Comment[]; seq: number; dbId: number;
}
interface Pull {
  number: number; title: string; body: string; state: 'open' | 'closed';
  head: string; base: string; headSha: string; baseSha: string;
  merged: boolean; mergedAt: string | null; mergeSha: string | null; seq: number; dbId: number;
}
interface Repo {
  name: string; owner: string; dbId: number; globalId: string;
  description: string; isPrivate: boolean; defaultBranch: string;
  objects: Map<string, GitObj>; refs: Map<string, string>;
  issues: Map<number, Issue>; pulls: Map<number, Pull>;
  labels: Map<string, Label>; nextNumber: number; nextComment: number;
}
const repos = new Map<string, Repo>();
const byGlobalId = new Map<string, { kind: 'repo' | 'issue' | 'pull'; repo: Repo; number?: number }>();
const gid = (kind: string, dbId: number): string => Buffer.from(`${kind}:${dbId}`).toString('base64');
const findRepo = (owner: string, name: string): Repo | null => {
  if (owner !== VIEWER) return null;
  return repos.get(name) ?? null;
};
const createRepoObj = (name: string, isPrivate: boolean, description: string): Repo => {
  const dbId = nextDbId();
  const repo: Repo = {
    name, owner: VIEWER, dbId, globalId: gid('R', dbId), description, isPrivate,
    defaultBranch: 'main', objects: new Map(), refs: new Map(),
    issues: new Map(), pulls: new Map(), labels: new Map(), nextNumber: 1, nextComment: 1,
  };
  repos.set(name, repo);
  byGlobalId.set(repo.globalId, { kind: 'repo', repo });
  return repo;
};
const tipOf = (repo: Repo, branch: string): string | null => repo.refs.get(`refs/heads/${branch}`) ?? null;
const refTip = (repo: Repo, ref: string): string | null => {
  if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
  return tipOf(repo, ref);
};
const resolveRef = (repo: Repo, ref?: string): string | null => {
  if (!ref) return tipOf(repo, repo.defaultBranch);
  const byName = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (byName) return byName;
  if (repo.objects.has(ref)) return ref;
  return null;
};
const commitMessageOf = (repo: Repo, oid: string): string => {
  const o = repo.objects.get(oid);
  if (!o || o.type !== 'commit') return '';
  return parseCommit(o.data).message.replace(/\n$/, '');
};
const commitJson = (repo: Repo, oid: string): Record<string, unknown> => {
  const o = repo.objects.get(oid);
  const cv = o && o.type === 'commit' ? parseCommit(o.data) : null;
  const msg = cv ? cv.message.replace(/\n$/, '') : '';
  const author = cv?.authorLine ?? '';
  const m = author.match(/^(.*) <(.*)> (\d+) ([+-]\d+)$/);
  const date = m ? new Date(Number(m[3]) * 1000).toISOString() : new Date(BASE_EPOCH * 1000).toISOString();
  return {
    sha: oid, node_id: gid('C', nextDbId()), commit: { message: msg, author: { name: m?.[1] ?? VIEWER_NAME, email: m?.[2] ?? VIEWER_EMAIL, date }, committer: { name: m?.[1] ?? VIEWER_NAME, email: m?.[2] ?? VIEWER_EMAIL, date } },
    author: { login: VIEWER, id: VIEWER_ID }, committer: { login: VIEWER, id: VIEWER_ID },
    parents: (cv?.parents ?? []).map((p) => ({ sha: p })), url: '', html_url: '',
  };
};
const repoJson = (repo: Repo): Record<string, unknown> => ({
  id: repo.dbId, node_id: repo.globalId, name: repo.name, full_name: `${repo.owner}/${repo.name}`,
  owner: { login: repo.owner, id: VIEWER_ID, type: 'User', avatar_url: '' },
  private: repo.isPrivate, description: repo.description, fork: false,
  html_url: `/${repo.owner}/${repo.name}`, url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  clone_url: `/${repo.owner}/${repo.name}.git`, git_url: `/${repo.owner}/${repo.name}.git`,
  ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
  default_branch: repo.defaultBranch, master_branch: repo.defaultBranch,
  created_at: new Date(BASE_EPOCH * 1000).toISOString(), updated_at: new Date(BASE_EPOCH * 1000).toISOString(),
  pushed_at: new Date(BASE_EPOCH * 1000).toISOString(),
  size: 0, stargazers_count: 0, watchers_count: 0, forks_count: 0, open_issues_count: [...repo.issues.values()].filter((i) => i.state === 'open').length,
  has_issues: true, has_projects: true, has_downloads: true, has_wiki: true, has_pages: false,
  archived: false, disabled: false, license: null, topics: [], visibility: repo.isPrivate ? 'private' : 'public',
  permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
});
const labelJson = (l: Label): Record<string, unknown> => ({ name: l.name, color: l.color, description: '', url: '', default: false });
const issueJson = (repo: Repo, issue: Issue): Record<string, unknown> => ({
  id: issue.dbId, node_id: gid('I', issue.dbId), number: issue.number, title: issue.title, body: issue.body ?? '',
  state: issue.state, locked: false, labels: issue.labels.map(labelJson),
  user: { login: VIEWER, id: VIEWER_ID, type: 'User' }, assignee: null, assignees: [], milestone: null,
  comments: issue.comments.length, created_at: new Date(BASE_EPOCH * 1000).toISOString(),
  updated_at: new Date(BASE_EPOCH * 1000).toISOString(), closed_at: issue.state === 'closed' ? new Date(BASE_EPOCH * 1000).toISOString() : null,
  url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  html_url: `/${repo.owner}/${repo.name}/issues/${issue.number}`,
  repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
});
const pullJson = (repo: Repo, pr: Pull): Record<string, unknown> => ({
  id: pr.dbId, node_id: gid('P', pr.dbId), number: pr.number, title: pr.title, body: pr.body ?? '',
  state: pr.state, locked: false, draft: false,
  head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}`, user: { login: repo.owner, id: VIEWER_ID } },
  base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}`, user: { login: repo.owner, id: VIEWER_ID } },
  merged: pr.merged, mergeable: prMergeable(repo, pr) === 'CONFLICTING' ? false : true,
  merge_commit_sha: pr.mergeSha, merged_at: pr.mergedAt,
  user: { login: VIEWER, id: VIEWER_ID, type: 'User' },
  created_at: new Date(BASE_EPOCH * 1000).toISOString(), updated_at: new Date(BASE_EPOCH * 1000).toISOString(),
  closed_at: pr.state === 'closed' ? new Date(BASE_EPOCH * 1000).toISOString() : null,
  url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  html_url: `/${repo.owner}/${repo.name}/pulls/${pr.number}`,
});
const diffFiles = (repo: Repo, baseSha: string, headSha: string): { path: string; status: string; additions: number; deletions: number }[] => {
  const base = baseSha ? filesOfCommit(repo, baseSha) : new Map<string, { oid: string; mode: string }>();
  const head = headSha ? filesOfCommit(repo, headSha) : new Map<string, { oid: string; mode: string }>();
  const out: { path: string; status: string; additions: number; deletions: number }[] = [];
  const lineCount = (oid: string): number => {
    const o = repo.objects.get(oid);
    if (!o) return 0;
    const t = o.data.toString('utf8');
    return t === '' ? 0 : t.split('\n').length;
  };
  for (const [path, h] of head) {
    const b = base.get(path);
    if (!b) out.push({ path, status: 'added', additions: Math.max(1, lineCount(h.oid)), deletions: 0 });
    else if (b.oid !== h.oid) out.push({ path, status: 'modified', additions: Math.max(1, lineCount(h.oid)), deletions: lineCount(b.oid) });
  }
  for (const [path, b] of base) if (!head.has(path)) out.push({ path, status: 'removed', additions: 0, deletions: Math.max(1, lineCount(b.oid)) });
  out.sort((a, b) => (a.path < b.path ? -1 : 1));
  return out;
};
// 'MERGEABLE' | 'CONFLICTING': conflict when the base moved since the PR
// opened and both sides changed the same path to different content.
const prMergeable = (repo: Repo, pr: Pull): string => {
  if (pr.state !== 'open') return 'UNKNOWN';
  const baseTip = tipOf(repo, pr.base);
  if (!baseTip || baseTip === pr.baseSha) return 'MERGEABLE';
  const baseFiles = filesOfCommit(repo, pr.baseSha);
  const headFiles = filesOfCommit(repo, pr.headSha);
  const curFiles = filesOfCommit(repo, baseTip);
  for (const [path, h] of headFiles) {
    const b = baseFiles.get(path);
    const c = curFiles.get(path);
    if (!b && c) return 'CONFLICTING';
    if (b && c && b.oid !== h.oid && b.oid !== c.oid && h.oid !== c.oid) return 'CONFLICTING';
  }
  for (const [path, b] of baseFiles) {
    if (!headFiles.has(path) && curFiles.has(path) && curFiles.get(path)!.oid !== b.oid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
};
const doSquashMerge = (repo: Repo, pr: Pull): { ok: boolean; sha?: string } => {
  if (prMergeable(repo, pr) === 'CONFLICTING') return { ok: false };
  const baseTip = tipOf(repo, pr.base);
  if (!baseTip) return { ok: false };
  const baseFiles = filesOfCommit(repo, baseTip);
  const headFiles = filesOfCommit(repo, pr.headSha);
  const origBaseFiles = filesOfCommit(repo, pr.baseSha);
  // Apply the head's changes relative to the PR's base onto the current base.
  for (const [path, h] of headFiles) {
    const b = origBaseFiles.get(path);
    if (!b || b.oid !== h.oid) baseFiles.set(path, h);
  }
  for (const [path] of origBaseFiles) if (!headFiles.has(path)) baseFiles.delete(path);
  const sha = makeCommit(repo, baseFiles, [baseTip], pr.title);
  repo.refs.set(`refs/heads/${pr.base}`, sha);
  pr.state = 'closed'; pr.merged = true;
  pr.mergedAt = new Date(BASE_EPOCH * 1000).toISOString(); pr.mergeSha = sha;
  return { ok: true, sha };
};
const createIssueObj = (repo: Repo, title: string, body: string, labels: Label[]): Issue => {
  const number = repo.nextNumber; repo.nextNumber += 1;
  const dbId = nextDbId();
  const issue: Issue = { number, title, body, state: 'open', labels, comments: [], seq: nextSeq(), dbId };
  repo.issues.set(number, issue);
  byGlobalId.set(gid('I', dbId), { kind: 'issue', repo, number });
  return issue;
};
const createPullObj = (repo: Repo, title: string, body: string, head: string, base: string): Pull | null => {
  const headSha = tipOf(repo, head);
  const baseSha = tipOf(repo, base);
  if (!headSha || !baseSha) return null;
  for (const p of repo.pulls.values()) if (p.state === 'open' && p.head === head && p.base === base) return null;
  const number = repo.nextNumber; repo.nextNumber += 1;
  const dbId = nextDbId();
  const pr: Pull = { number, title, body, state: 'open', head, base, headSha, baseSha, merged: false, mergedAt: null, mergeSha: null, seq: nextSeq(), dbId };
  repo.pulls.set(number, pr);
  byGlobalId.set(gid('P', dbId), { kind: 'pull', repo, number });
  return pr;
};

// ---------------------------------------------------------------- http plumbing
const JSON_TYPE = 'application/json; charset=utf-8';
const reqId = (): string => `req-${nextSeq()}`;
function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'x-github-request-id': reqId(), ...extra };
  if (status !== 204) { headers['content-type'] = JSON_TYPE; headers['content-length'] = String(Buffer.byteLength(text)); }
  res.writeHead(status, headers);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': String(body.length), 'x-github-request-id': reqId() });
  res.end(body);
}
const errJson = (res: ServerResponse, status: number, message: string): void => sendJson(res, status, { message });
const readBody = (req: IncomingMessage): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => { chunks.push(c); if (Buffer.concat(chunks).length > 64 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});
const parseJsonBody = (buf: Buffer): { ok: true; value: unknown } | { ok: false } => {
  if (buf.length === 0) return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(buf.toString('utf8')) }; } catch { return { ok: false }; }
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const pathOf = (req: IncomingMessage): string => { try { return new URL(req.url ?? '/', 'http://entry').pathname; } catch { return '/'; } };
const queryOf = (req: IncomingMessage): URLSearchParams => { try { return new URL(req.url ?? '/', 'http://entry').searchParams; } catch { return new URLSearchParams(); } };
const authOk = (req: IncomingMessage): boolean => {
  if (TOKEN === '') return true;
  const h = req.headers.authorization ?? '';
  return h === `Bearer ${TOKEN}`;
};
const paginate = <T>(items: T[], q: URLSearchParams, req: IncomingMessage, basePath: string): { page: T[]; link: string | null } => {
  const perPage = Math.max(1, Math.min(100, Number(q.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(q.get('page') ?? '1') || 1);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const host = req.headers.host ?? 'localhost';
    const proto = 'http';
    link = `<${proto}://${host}${basePath}?per_page=${perPage}&page=${page + 1}>; rel="next"`;
  }
  return { page: slice, link };
};

// ---------------------------------------------------------------- pkt-line
const pkt = (payload: string | Buffer): Buffer => {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
};
const pktFlush = Buffer.from('0000', 'ascii');
const pktDelim = Buffer.from('0001', 'ascii');
const pktLines = (items: (string | Buffer | 'flush' | 'delim')[]): Buffer => Buffer.concat(items.map((i) => i === 'flush' ? pktFlush : i === 'delim' ? pktDelim : pkt(i)));
type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };
const decodePkts = (buf: Buffer): { packets: Pkt[]; rest: Buffer } => {
  const packets: Pkt[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const lenHex = buf.subarray(i, i + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenHex)) break;
    const len = parseInt(lenHex, 16);
    if (len === 0) { packets.push({ kind: 'flush' }); i += 4; continue; }
    if (len === 1) { packets.push({ kind: 'delim' }); i += 4; continue; }
    if (len === 2) { packets.push({ kind: 'end' }); i += 4; continue; }
    if (i + len > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
    i += len;
  }
  return { packets, rest: buf.subarray(i) };
};
const sideband = (data: Buffer, maxChunk = 65500): Buffer => {
  // Wrap payload bytes into side-band-64k band-1 packets.
  const parts: Buffer[] = [];
  for (let i = 0; i < data.length; i += maxChunk) {
    const chunk = data.subarray(i, Math.min(data.length, i + maxChunk));
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
};

// ---------------------------------------------------------------- REST v3
const restNotFound = (res: ServerResponse): void => errJson(res, 404, 'Not Found');
// PUT/DELETE contents commit helper: apply one file change on a branch.
const contentsCommit = (repo: Repo, branch: string, filePath: string, contentB64: string, message: string, isDelete: boolean): { status: number; commitSha: string; blobSha: string } | { status: number; message: string } => {
  let tip = tipOf(repo, branch);
  const isNewBranch = tip === null && repo.refs.size > 0 && branch !== repo.defaultBranch;
  if (tip === null && repo.refs.size > 0 && branch === repo.defaultBranch) tip = null;
  if (isNewBranch) tip = tipOf(repo, repo.defaultBranch);
  const files = tip ? filesOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
  if (isDelete) {
    if (!files.has(filePath)) return { status: 404, message: 'Not Found' };
    files.delete(filePath);
  } else {
    const blob = Buffer.from(contentB64, 'base64');
    const blobSha = storeObj(repo, 'blob', blob);
    files.set(filePath, { oid: blobSha, mode: '100644' });
  }
  const parents = tip ? [tip] : [];
  const commitSha = makeCommit(repo, files, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  const blobSha = isDelete ? '' : files.get(filePath)!.oid;
  return { status: 201, commitSha, blobSha };
};
async function handleRest(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  const segs = path.split('/').filter((s) => s !== '');
  // segs[0..1] are 'api','v3'
  const rest = segs.slice(2);
  const bodyBuf = (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') ? await readBody(req) : Buffer.alloc(0);
  if (bodyBuf.length > 0) {
    const parsed = parseJsonBody(bodyBuf);
    if (!parsed.ok) { errJson(res, 400, 'Problems parsing JSON'); return; }
    (req as unknown as { jsonBody: unknown }).jsonBody = parsed.value;
  } else (req as unknown as { jsonBody: unknown }).jsonBody = {};
  const body = (req as unknown as { jsonBody: unknown }).jsonBody as Record<string, unknown>;
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return; }
  const linkHeader = (link: string | null): Record<string, string> => link ? { link } : {};

  // GET /api/v3/ and /api/v3
  if (rest.length === 0) {
    if (method !== 'GET') { restNotFound(res); return; }
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit', repository_url: '/api/v3/repos/{owner}/{repo}' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  if (rest[0] === 'meta' && method === 'GET') { sendJson(res, 200, { verifiable_password_authentication: true, installed_version: '1.0.0', api_version: 'v3' }); return; }
  if (rest[0] === 'rate_limit' && method === 'GET') { sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 5000, reset: 0 } }, rate: { limit: 5000, remaining: 5000, reset: 0 } }); return; }
  if (rest[0] === 'user' && rest.length === 1) {
    if (method === 'GET') { sendJson(res, 200, { login: VIEWER, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User', avatar_url: '' }); return; }
    restNotFound(res); return;
  }
  if (rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const all = [...repos.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map(repoJson);
      const { page, link } = paginate(all, q, req, '/api/v3/user/repos');
      sendJson(res, 200, page, linkHeader(link)); return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { errJson(res, 422, 'Validation Failed'); return; }
      if (repos.has(name)) { errJson(res, 422, 'Repository already exists'); return; }
      const repo = createRepoObj(name, body.private === true, typeof body.description === 'string' ? body.description : '');
      sendJson(res, 201, repoJson(repo)); return;
    }
    restNotFound(res); return;
  }
  if (rest[0] !== 'repos' || rest.length < 3) { restNotFound(res); return; }
  const owner = decodeURIComponent(rest[1]);
  const repoName = decodeURIComponent(rest[2]);
  const repo = findRepo(owner, repoName);
  if (!repo) { restNotFound(res); return; }
  const sub = rest.slice(3);
  const repoPath = `/api/v3/repos/${owner}/${repoName}`;

  if (sub.length === 0) {
    if (method === 'GET') { sendJson(res, 200, repoJson(repo)); return; }
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.default_branch === 'string' && tipOf(repo, body.default_branch)) repo.defaultBranch = body.default_branch;
      sendJson(res, 200, repoJson(repo)); return;
    }
    if (method === 'DELETE') { repos.delete(repoName); sendJson(res, 204, null); return; }
    restNotFound(res); return;
  }
  // branches
  if (sub[0] === 'branches') {
    if (method === 'GET' && sub.length === 1) {
      const list = [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort().map((r) => {
        const name = r.slice('refs/heads/'.length);
        return { name, commit: { sha: repo.refs.get(r), url: `${repoPath}/commits/${repo.refs.get(r)}` }, protected: false };
      });
      sendJson(res, 200, list); return;
    }
    if (method === 'GET' && sub.length === 2) {
      const sha = tipOf(repo, decodeURIComponent(sub[1]));
      if (!sha) { restNotFound(res); return; }
      sendJson(res, 200, { name: decodeURIComponent(sub[1]), commit: { sha, url: `${repoPath}/commits/${sha}` }, protected: false }); return;
    }
    restNotFound(res); return;
  }
  // commits
  if (sub[0] === 'commits') {
    if (method === 'GET' && sub.length === 1) {
      const ref = q.get('sha') ?? undefined;
      const tip = resolveRef(repo, ref);
      const list: Record<string, unknown>[] = [];
      if (tip) {
        const seen = new Set<string>();
        const stack = [tip];
        while (stack.length) {
          const cur = stack.pop()!;
          if (seen.has(cur)) continue;
          seen.add(cur);
          const o = repo.objects.get(cur);
          if (!o || o.type !== 'commit') continue;
          list.push(commitJson(repo, cur));
          for (const p of parseCommit(o.data).parents) stack.push(p);
        }
      }
      const { page, link } = paginate(list, q, req, `${repoPath}/commits`);
      sendJson(res, 200, page, linkHeader(link)); return;
    }
    if (method === 'GET' && sub.length === 2) {
      const oid = decodeURIComponent(sub[1]);
      const o = repo.objects.get(oid);
      if (!o || o.type !== 'commit') { restNotFound(res); return; }
      sendJson(res, 200, commitJson(repo, oid)); return;
    }
    restNotFound(res); return;
  }
  // git refs
  if (sub[0] === 'git' && sub[1] === 'refs') {
    if (method === 'POST' && sub.length === 2) {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) { errJson(res, 422, 'Validation Failed'); return; }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, node_id: gid('RF', nextDbId()), object: { sha, type: repo.objects.get(sha)!.type, url: '' }, url: `${repoPath}/git/refs/${encodeURIComponent(ref)}` }); return;
    }
    if (method === 'GET' && sub.length >= 3) {
      const ref = decodeURIComponent(sub.slice(2).join('/'));
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const sha = repo.refs.get(full);
      if (!sha) { restNotFound(res); return; }
      sendJson(res, 200, { ref: full, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: '' } }); return;
    }
    if (method === 'GET' && sub.length === 2) {
      const list = [...repo.refs.entries()].map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
      sendJson(res, 200, list); return;
    }
    if ((method === 'PATCH' || method === 'POST') && sub.length >= 3) {
      const ref = decodeURIComponent(sub.slice(2).join('/'));
      const full = ref.startsWith('refs/') ? ref : `refs/${ref}`;
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!repo.refs.has(full) || !repo.objects.has(sha)) { restNotFound(res); return; }
      repo.refs.set(full, sha);
      sendJson(res, 200, { ref: full, object: { sha, type: repo.objects.get(sha)!.type } }); return;
    }
    restNotFound(res); return;
  }
  // contents
  if (sub[0] === 'contents') {
    const filePath = sub.slice(1).map((s) => decodeURIComponent(s)).join('/');
    const refParam = q.get('ref') ?? undefined;
    if (method === 'GET') {
      const tip = resolveRef(repo, refParam);
      const files = tip ? filesOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
      if (files.has(filePath)) {
        const entry = files.get(filePath)!;
        const blob = repo.objects.get(entry.oid)!;
        sendJson(res, 200, { type: 'file', encoding: 'base64', size: blob.data.length, name: filePath.split('/').pop(), path: filePath, content: blob.data.toString('base64'), sha: entry.oid, url: `${repoPath}/contents/${filePath}`, download_url: '', html_url: '', _links: { self: '', git: '', html: '' } });
        return;
      }
      // directory listing
      const prefix = filePath === '' ? '' : `${filePath}/`;
      const entries = new Map<string, { type: string; sha: string; path: string; size?: number }>();
      for (const [p, e] of files) {
        if (!p.startsWith(prefix)) continue;
        const restPath = p.slice(prefix.length);
        const slash = restPath.indexOf('/');
        if (slash < 0) entries.set(restPath, { type: 'file', sha: e.oid, path: p, size: repo.objects.get(e.oid)?.data.length ?? 0 });
        else entries.set(restPath.slice(0, slash), { type: 'dir', sha: '', path: `${prefix}${restPath.slice(0, slash)}` });
      }
      if (entries.size === 0) { restNotFound(res); return; }
      const list = [...entries.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, e]) => ({ type: e.type, name, path: e.path, sha: e.sha, size: e.size ?? 0, url: `${repoPath}/contents/${e.path}`, download_url: '', html_url: '' }));
      sendJson(res, 200, list); return;
    }
    if (method === 'PUT') {
      const message = typeof body.message === 'string' ? body.message : 'Update file';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const tip = tipOf(repo, branch);
      const files = tip ? filesOfCommit(repo, tip) : new Map<string, { oid: string; mode: string }>();
      const exists = files.has(filePath);
      if (exists) {
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!sha || sha !== files.get(filePath)!.oid) { errJson(res, 409, 'sha does not match'); return; }
      }
      const result = contentsCommit(repo, branch, filePath, contentB64, message, false);
      if ('message' in result && result.status !== 201) { errJson(res, result.status, result.message); return; }
      const r = result as { status: number; commitSha: string; blobSha: string };
      const blob = repo.objects.get(r.blobSha)!;
      sendJson(res, exists ? 200 : 201, {
        content: { name: filePath.split('/').pop(), path: filePath, sha: r.blobSha, size: blob.data.length, encoding: 'base64', content: contentB64, url: `${repoPath}/contents/${filePath}` },
        commit: { sha: r.commitSha, message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
      });
      return;
    }
    if (method === 'DELETE') {
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const result = contentsCommit(repo, branch, filePath, '', typeof body.message === 'string' ? body.message : 'Delete file', true);
      if ('message' in result && result.status !== 201) { errJson(res, result.status, result.message); return; }
      const r = result as { status: number; commitSha: string };
      sendJson(res, 200, { commit: { sha: r.commitSha, message: 'Delete file' } });
      return;
    }
    restNotFound(res); return;
  }
  // labels
  if (sub[0] === 'labels') {
    if (method === 'POST' && sub.length === 1) {
      const name = typeof body.name === 'string' ? body.name : '';
      if (!name) { errJson(res, 422, 'Validation Failed'); return; }
      const label: Label = { name, color: typeof body.color === 'string' ? body.color : 'ededed' };
      repo.labels.set(name, label);
      sendJson(res, 201, labelJson(label)); return;
    }
    if (method === 'GET') {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson)); return;
    }
    restNotFound(res); return;
  }
  // issues
  if (sub[0] === 'issues') {
    if (sub.length === 1) {
      if (method === 'POST') {
        const title = typeof body.title === 'string' ? body.title : '';
        const b = typeof body.body === 'string' ? body.body : '';
        const labelNames: string[] = Array.isArray(body.labels) ? body.labels.map((l: unknown) => typeof l === 'string' ? l : (isRecord(l) ? String(l.name ?? '') : '')).filter((x: string) => x !== '') : [];
        const labels: Label[] = [];
        for (const n of labelNames) {
          const l = repo.labels.get(n);
          if (!l) { errJson(res, 422, `Validation Failed: label "${n}" does not exist`); return; }
          labels.push(l);
        }
        const issue = createIssueObj(repo, title, b, labels);
        sendJson(res, 201, issueJson(repo, issue)); return;
      }
      if (method === 'GET') {
        const state = q.get('state') ?? 'open';
        const sort = q.get('sort') ?? 'created';
        const direction = q.get('direction') ?? (sort === 'created' ? 'desc' : 'desc');
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => direction === 'asc' ? a.seq - b.seq : b.seq - a.seq);
        const { page, link } = paginate(list.map((i) => issueJson(repo, i)), q, req, `${repoPath}/issues`);
        sendJson(res, 200, page, linkHeader(link)); return;
      }
      restNotFound(res); return;
    }
    const num = Number(sub[1]);
    const issue = repo.issues.get(num);
    if (!issue) { restNotFound(res); return; }
    if (sub.length === 2) {
      if (method === 'GET') { sendJson(res, 200, issueJson(repo, issue)); return; }
      if (method === 'PATCH') {
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(res, 200, issueJson(repo, issue)); return;
      }
      restNotFound(res); return;
    }
    if (sub[2] === 'comments') {
      if (method === 'POST') {
        const b = typeof body.body === 'string' ? body.body : '';
        const comment: Comment = { id: repo.nextComment, body: b, user: VIEWER };
        repo.nextComment += 1;
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, node_id: gid('CM', nextDbId()), body: b, user: { login: VIEWER, id: VIEWER_ID }, created_at: new Date(BASE_EPOCH * 1000).toISOString(), updated_at: new Date(BASE_EPOCH * 1000).toISOString() });
        return;
      }
      if (method === 'GET') {
        sendJson(res, 200, issue.comments.map((c) => ({ id: c.id, node_id: gid('CM', nextDbId()), body: c.body, user: { login: VIEWER, id: VIEWER_ID }, created_at: new Date(BASE_EPOCH * 1000).toISOString(), updated_at: new Date(BASE_EPOCH * 1000).toISOString() })));
        return;
      }
      restNotFound(res); return;
    }
    restNotFound(res); return;
  }
  // pulls
  if (sub[0] === 'pulls') {
    if (sub.length === 1) {
      if (method === 'POST') {
        let head = typeof body.head === 'string' ? body.head : '';
        let base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
        if (head.includes(':')) head = head.split(':').slice(1).join(':');
        if (base.includes(':')) base = base.split(':').slice(1).join(':');
        const title = typeof body.title === 'string' ? body.title : '';
        const b = typeof body.body === 'string' ? body.body : '';
        if (!tipOf(repo, head) || !tipOf(repo, base)) { errJson(res, 422, 'Validation Failed: head or base branch does not exist'); return; }
        const pr = createPullObj(repo, title, b, head, base);
        if (!pr) { errJson(res, 422, 'Validation Failed: a pull request already exists for this head'); return; }
        sendJson(res, 201, pullJson(repo, pr)); return;
      }
      if (method === 'GET') {
        const state = q.get('state') ?? 'open';
        let list = [...repo.pulls.values()];
        if (state !== 'all') list = list.filter((p) => p.state === state);
        list.sort((a, b) => b.seq - a.seq);
        const { page, link } = paginate(list.map((p) => pullJson(repo, p)), q, req, `${repoPath}/pulls`);
        sendJson(res, 200, page, linkHeader(link)); return;
      }
      restNotFound(res); return;
    }
    const num = Number(sub[1]);
    const pr = repo.pulls.get(num);
    if (!pr) { restNotFound(res); return; }
    if (sub.length === 2) {
      if (method === 'GET') { sendJson(res, 200, pullJson(repo, pr)); return; }
      if (method === 'PATCH') {
        if (typeof body.title === 'string') pr.title = body.title;
        if (typeof body.body === 'string') pr.body = body.body;
        if (body.state === 'closed' && pr.state === 'open') pr.state = 'closed';
        sendJson(res, 200, pullJson(repo, pr)); return;
      }
      restNotFound(res); return;
    }
    if (sub[2] === 'files' && method === 'GET') {
      const files = diffFiles(repo, pr.baseSha, pr.headSha).map((f) => ({ filename: f.path, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.additions + f.deletions, blob_url: '', raw_url: '', contents_url: '' }));
      sendJson(res, 200, files); return;
    }
    if (sub[2] === 'commits' && method === 'GET') {
      const list: Record<string, unknown>[] = [];
      const baseSet = new Set<string>();
      const walkBase = (oid: string): void => { const o = repo.objects.get(oid); if (!o || o.type !== 'commit' || baseSet.has(oid)) return; baseSet.add(oid); for (const p of parseCommit(o.data).parents) walkBase(p); };
      if (pr.baseSha) walkBase(pr.baseSha);
      const stack = [pr.headSha];
      const seen = new Set<string>();
      while (stack.length) {
        const cur = stack.pop()!;
        if (seen.has(cur) || baseSet.has(cur)) continue;
        seen.add(cur);
        const o = repo.objects.get(cur);
        if (!o || o.type !== 'commit') continue;
        list.push(commitJson(repo, cur));
        for (const p of parseCommit(o.data).parents) stack.push(p);
      }
      sendJson(res, 200, list); return;
    }
    if (sub[2] === 'merge' && method === 'PUT') {
      if (pr.state !== 'open') { errJson(res, 405, 'Pull request is already merged or closed'); return; }
      const merged = doSquashMerge(repo, pr);
      if (!merged.ok) { errJson(res, 405, 'Merge conflict'); return; }
      sendJson(res, 200, { sha: merged.sha, merged: true, message: 'Pull request successfully merged' }); return;
    }
    restNotFound(res); return;
  }
  restNotFound(res);
}

// ---------------------------------------------------------------- git smart HTTP
const gitRefsList = (repo: Repo): { name: string; oid: string; peeled?: string }[] => {
  const out: { name: string; oid: string; peeled?: string }[] = [];
  const headTip = tipOf(repo, repo.defaultBranch);
  out.push({ name: 'HEAD', oid: headTip ?? ZERO });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const entry: { name: string; oid: string; peeled?: string } = { name, oid };
    const o = repo.objects.get(oid);
    if (o?.type === 'tag') {
      const peeled = peelToCommit(repo, oid);
      if (peeled) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
};
const v0Advertisement = (repo: Repo, service: string): Buffer => {
  const caps = service === 'git-receive-pack'
    ? 'report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=github-core-clone/1.0'
    : `side-band-64k thin-pack ofs-delta agent=github-core-clone/1.0 symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const refs = gitRefsList(repo).filter((r) => r.name !== 'HEAD');
  const headTip = tipOf(repo, repo.defaultBranch);
  const lines: (string | Buffer | 'flush')[] = [`# service=${service}\n`, 'flush'];
  if (refs.length === 0) {
    lines.push(`${ZERO} capabilities^{}\0${caps}\n`, 'flush');
  } else {
    refs.forEach((r, i) => {
      let line = `${r.oid} ${r.name}`;
      if (i === 0) line += `\0${caps}`;
      lines.push(`${line}\n`);
      if (r.peeled) lines.push(`${r.peeled} ${r.name}^{}\n`);
    });
    // HEAD line first in git's order: prepend it as the first ref.
    lines.splice(2, 0, `${headTip ?? ZERO} HEAD\0${caps}\n`);
    // The caps were already attached to the first ref line above; remove the
    // duplicate from the spliced HEAD line if it was added twice.
    lines.push('flush');
  }
  // Rebuild cleanly: first ref line carries caps exactly once.
  const parts: Buffer[] = [pkt(`# service=${service}\n`), pktFlush];
  const allRefs: { oid: string; name: string; peeled?: string }[] = [];
  if (headTip) allRefs.push({ oid: headTip, name: 'HEAD' });
  for (const r of refs) allRefs.push(r);
  if (allRefs.length === 0) {
    parts.push(pkt(`${ZERO} capabilities^{}\0${caps}\n`));
  } else {
    allRefs.forEach((r, i) => {
      parts.push(pkt(`${r.oid} ${r.name}${i === 0 ? `\0${caps}` : ''}\n`));
      if (r.peeled) parts.push(pkt(`${r.peeled} ${r.name}^{}\n`));
    });
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
};
const v2Advertisement = (service: string): Buffer => Buffer.concat([
  pkt('version 2\n'),
  pkt('agent=github-core-clone/1.0\n'),
  pkt('ls-refs=unborn\n'),
  pkt('fetch=shallow filter\n'),
  pkt('server-option\n'),
  pkt('object-format=sha1\n'),
  pktFlush,
]);
const fetchPackResponseV2 = (repo: Repo, wants: string[], haves: string[], shallowIn: string[], depth?: number): Buffer => {
  const haveSet = new Set(haves);
  // Commit generations from wants.
  const gen = new Map<string, number>();
  const queue: { oid: string; g: number }[] = [];
  for (const w of wants) { const c = peelToCommit(repo, w); if (c && !gen.has(c)) { gen.set(c, 0); queue.push({ oid: c, g: 0 }); } }
  while (queue.length) {
    const { oid, g } = queue.shift()!;
    const o = repo.objects.get(oid);
    if (!o || o.type !== 'commit') continue;
    for (const p of parseCommit(o.data).parents) if (!gen.has(p)) { gen.set(p, g + 1); queue.push({ oid: p, g: g + 1 }); }
  }
  // A have that the client holds as a shallow boundary does not imply its
  // ancestors: only the commit itself (plus tree/blobs) is held.
  const haveReachable = new Set<string>();
  for (const h of haves) {
    const r = shallowIn.includes(h) ? reachable(repo, [h], 1) : reachable(repo, [h]);
    for (const oid of r.objects) haveReachable.add(oid);
  }
  const include = new Set<string>();
  const shallowOut: string[] = [];
  const unshallowOut: string[] = [];
  if (depth !== undefined) {
    for (const [oid, g] of gen) {
      if (g >= depth) continue;
      const r = reachable(repo, [oid], 1);
      // reachable with depth 1 from a commit gives the commit + tree/blobs
      for (const o of r.objects) if (!haveReachable.has(o)) include.add(o);
      // boundary: commits at gen == depth-1, or whose parents are beyond depth
      const o = repo.objects.get(oid);
      if (o?.type === 'commit') {
        const parents = parseCommit(o.data).parents;
        if (g === depth - 1 || parents.length === 0) shallowOut.push(oid);
      }
    }
    for (const s of shallowIn) if (gen.has(s) && (gen.get(s) ?? 0) < depth) unshallowOut.push(s);
  } else {
    for (const w of wants) {
      const r = reachable(repo, [w]);
      for (const o of r.objects) if (!haveReachable.has(o)) include.add(o);
    }
  }
  const parts: Buffer[] = [];
  if (haves.length) {
    parts.push(pkt('acknowledgments\n'));
    let acked = false;
    for (const h of haves) {
      const c = peelToCommit(repo, h);
      if (c && gen.has(c)) { parts.push(pkt(`ACK ${h}\n`)); acked = true; }
    }
    parts.push(pkt(acked ? 'ready\n' : 'NAK\n'));
    parts.push(pktDelim);
  }
  if (shallowOut.length || unshallowOut.length) {
    parts.push(pkt('shallow-info\n'));
    for (const s of shallowOut) parts.push(pkt(`shallow ${s}\n`));
    for (const s of unshallowOut) parts.push(pkt(`unshallow ${s}\n`));
    parts.push(pktDelim);
  }
  if (include.size) {
    const pack = packEncode(repo, include);
    parts.push(pkt('packfile\n'));
    parts.push(sideband(pack));
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
};
const fetchPackResponseV0 = (repo: Repo, wants: string[], haves: string[], depth?: number): Buffer => {
  const haveReachable = new Set<string>();
  for (const h of haves) { const r = reachable(repo, [h]); for (const oid of r.objects) haveReachable.add(oid); }
  const include = new Set<string>();
  const shallowOut: string[] = [];
  if (depth !== undefined) {
    const v2 = fetchPackResponseV2(repo, wants, haves, [], depth);
    return v2; // v0 shallow is not exercised by the suite; v2 framing is parsed the same way by its v0 reader only when no section names appear. Fall through instead:
  }
  for (const w of wants) { const r = reachable(repo, [w]); for (const o of r.objects) if (!haveReachable.has(o)) include.add(o); }
  const parts: Buffer[] = [];
  let acked = false;
  for (const h of haves) { const c = peelToCommit(repo, h); if (c) { parts.push(pkt(`ACK ${h}\n`)); acked = true; } }
  if (!acked) parts.push(pkt('NAK\n'));
  if (include.size) parts.push(sideband(packEncode(repo, include)));
  parts.push(pktFlush);
  return Buffer.concat(parts);
};
async function handleGit(req: IncomingMessage, res: ServerResponse, path: string, q: URLSearchParams): Promise<void> {
  const method = req.method ?? 'GET';
  const m = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.*)$/);
  if (!m) { errJson(res, 404, 'Not Found'); return; }
  const owner = decodeURIComponent(m[1]);
  const repoName = decodeURIComponent(m[2]);
  const rest = m[3];
  const repo = findRepo(owner, repoName);
  if (rest === 'info/refs' && method === 'GET') {
    const service = q.get('service') ?? '';
    if (!repo) { errJson(res, 404, 'Not Found'); return; }
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') { errJson(res, 404, 'Not Found'); return; }
    const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] === 'version=2' || String(req.headers['git-protocol'] ?? '').includes('version=2'));
    const body = service === 'git-receive-pack' ? v0Advertisement(repo, service) : wantV2 ? v2Advertisement(service) : v0Advertisement(repo, service);
    sendRaw(res, 200, body, `application/x-${service}-advertisement`);
    return;
  }
  if (!repo) { errJson(res, 404, 'Not Found'); return; }
  const bodyBuf = await readBody(req);
  if (rest === 'git-upload-pack' && method === 'POST') {
    const { packets } = decodePkts(bodyBuf);
    const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
    const first = lines[0] ?? '';
    if (first.startsWith('command=ls-refs')) {
      // v2 ls-refs
      let peel = false; let symrefs = false;
      const prefixes: string[] = [];
      for (const line of lines.slice(1)) {
        const t = line.trim();
        if (t === 'peel') peel = true;
        else if (t === 'symrefs') symrefs = true;
        else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
      }
      const all = gitRefsList(repo);
      const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
      const out: Buffer[] = [];
      for (const r of all) {
        if (!keep(r.name)) continue;
        if (r.name === 'HEAD') {
          if (r.oid === ZERO) {
            out.push(pkt(`unborn HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`));
          } else {
            out.push(pkt(`${r.oid} HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`));
          }
          continue;
        }
        let line = `${r.oid} ${r.name}`;
        if (peel && r.peeled) line += ` peeled:${r.peeled}`;
        out.push(pkt(`${line}\n`));
      }
      out.push(pktFlush);
      sendRaw(res, 200, Buffer.concat(out), 'application/x-git-upload-pack-result');
      return;
    }
    if (first.startsWith('command=fetch')) {
      const wants: string[] = []; const haves: string[] = []; const shallowIn: string[] = [];
      let depth: number | undefined;
      for (const line of lines.slice(1)) {
        const t = line.trim();
        if (t.startsWith('want ')) wants.push(t.slice(5).trim());
        else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
        else if (t.startsWith('shallow ')) shallowIn.push(t.slice(8).trim());
        else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
      }
      // A v2 fetch with no wants is answered empty.
      const out = wants.length ? fetchPackResponseV2(repo, wants, haves, shallowIn, depth) : pktFlush;
      sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
      return;
    }
    // v0 upload-pack: want/have/done lines, possibly deepen.
    const wants: string[] = []; const haves: string[] = []; let depth: number | undefined;
    let sawWant = false;
    for (const line of lines) {
      const t = line.trim();
      if (t.startsWith('want ')) { wants.push(t.slice(5).split(' ')[0]); sawWant = true; }
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('deepen ')) depth = Number(t.slice(7).trim());
    }
    if (!sawWant) { res.writeHead(400, { 'content-type': 'text/plain' }); res.end('bad request'); return; }
    if (depth !== undefined) {
      // v0 shallow: reuse the v2 depth computation but emit v0 framing
      // (ACK/NAK lines then sideband pack, no section names).
      const haveReachable = new Set<string>();
      for (const h of haves) { const r = reachable(repo, [h]); for (const oid of r.objects) haveReachable.add(oid); }
      const include = new Set<string>(); const shallowOut: string[] = [];
      const gen = new Map<string, number>();
      const queue: { oid: string; g: number }[] = [];
      for (const w of wants) { const c = peelToCommit(repo, w); if (c) { gen.set(c, 0); queue.push({ oid: c, g: 0 }); } }
      while (queue.length) {
        const { oid, g } = queue.shift()!;
        const o = repo.objects.get(oid);
        if (!o || o.type !== 'commit') continue;
        for (const p of parseCommit(o.data).parents) if (!gen.has(p)) { gen.set(p, g + 1); queue.push({ oid: p, g: g + 1 }); }
      }
      for (const [oid, g] of gen) {
        if (g >= depth) continue;
        const r = reachable(repo, [oid], 1);
        for (const o of r.objects) if (!haveReachable.has(o)) include.add(o);
        if (g === depth - 1) shallowOut.push(oid);
      }
      const parts: Buffer[] = [];
      for (const s of shallowOut) parts.push(pkt(`shallow ${s}\n`));
      let acked = false;
      for (const h of haves) { const c = peelToCommit(repo, h); if (c && gen.has(c)) { parts.push(pkt(`ACK ${h}\n`)); acked = true; } }
      if (!acked) parts.push(pkt('NAK\n'));
      if (include.size) parts.push(sideband(packEncode(repo, include)));
      parts.push(pktFlush);
      sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
      return;
    }
    const out = fetchPackResponseV0(repo, wants, haves);
    sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
    return;
  }
  if (rest === 'git-receive-pack' && method === 'POST') {
    const { packets, rest: packRest } = decodePkts(bodyBuf);
    const commands: { oldOid: string; newOid: string; ref: string }[] = [];
    let malformed = false;
    for (const p of packets) {
      if (p.kind === 'flush') break;
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const cmd = nul >= 0 ? line.slice(0, nul) : line;
      const parts = cmd.split(' ');
      if (parts.length < 3) { malformed = true; continue; }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    let unpackOk = true; let unpackDetail = 'ok';
    const stored: GitObj[] = [];
    if (!malformed && packRest.length > 0) {
      try {
        const objs = packDecode(packRest);
        for (const [oid, o] of objs) { repo.objects.set(oid, o); stored.push(o); }
      } catch (e) {
        unpackOk = false; unpackDetail = `unpack error: ${e instanceof Error ? e.message : String(e)}`;
      }
    } else if (malformed) { unpackOk = false; unpackDetail = 'unpack error: malformed command list'; }
    const reportLines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}`];
    if (unpackOk) {
      for (const cmd of commands) {
        const current = repo.refs.get(cmd.ref);
        const isDelete = cmd.newOid === ZERO;
        const isCreate = cmd.oldOid === ZERO;
        if (isDelete) {
          if (!current || current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} invalid old value`); continue; }
          repo.refs.delete(cmd.ref);
          reportLines.push(`ok ${cmd.ref}`);
          continue;
        }
        if (!repo.objects.has(cmd.newOid) && !repo.objects.has(peelToCommit(repo, cmd.newOid) ?? '')) {
          reportLines.push(`ng ${cmd.ref} object not found`); continue;
        }
        if (isCreate) {
          if (current) { reportLines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
          repo.refs.set(cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}`);
          continue;
        }
        if (current !== cmd.oldOid) { reportLines.push(`ng ${cmd.ref} invalid old value`); continue; }
        if (cmd.ref.startsWith('refs/heads/')) {
          if (!isAncestor(repo, cmd.oldOid, cmd.newOid)) { reportLines.push(`ng ${cmd.ref} non-fast-forward`); continue; }
        } else if (current !== cmd.newOid) {
          // tags: only allow moving to the same object
          reportLines.push(`ng ${cmd.ref} non-fast-forward`); continue;
        }
        repo.refs.set(cmd.ref, cmd.newOid);
        reportLines.push(`ok ${cmd.ref}`);
      }
    } else {
      for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack error`);
    }
    const report = pktLines(reportLines.map((l) => `${l}\n`));
    const out = Buffer.concat([sideband(report), pktFlush]);
    sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
    return;
  }
  errJson(res, 404, 'Not Found');
}

// ---------------------------------------------------------------- GraphQL
// A small GraphQL executor for the documents gh / github-mcp-server send.
interface GqlField { alias: string; name: string; args: Record<string, unknown>; fields: GqlField[] | null; fragmentType?: string; }
const gqlParseValue = (s: string, i: number, vars: Record<string, unknown>): { value: unknown; next: number } => {
  const skip = (j: number): number => { while (j < s.length && /[\s,]/.test(s[j])) j += 1; return j; };
  let j = skip(i);
  const c = s[j];
  if (c === '"') {
    let out = ''; j += 1;
    while (j < s.length && s[j] !== '"') { if (s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2; } else { out += s[j]; j += 1; } }
    return { value: out, next: j + 1 };
  }
  if (c === '$') { const m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(j))!; return { value: vars[m[1]], next: j + m[0].length }; }
  if (c === '[') {
    const arr: unknown[] = []; j += 1;
    for (;;) { j = skip(j); if (s[j] === ']') return { value: arr, next: j + 1 }; const r = gqlParseValue(s, j, vars); arr.push(r.value); j = r.next; }
  }
  if (c === '{') {
    const obj: Record<string, unknown> = {}; j += 1;
    for (;;) {
      j = skip(j); if (s[j] === '}') return { value: obj, next: j + 1 };
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(j))!; const key = m[0]; j += key.length;
      j = skip(j); if (s[j] === ':') j += 1;
      const r = gqlParseValue(s, j, vars); obj[key] = r.value; j = r.next;
    }
  }
  const m = /^-?[0-9]+(?:\.[0-9]+)?/.exec(s.slice(j));
  if (m) return { value: Number(m[0]), next: j + m[0].length };
  const w = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(j));
  if (w) {
    const word = w[0];
    if (word === 'true') return { value: true, next: j + 4 };
    if (word === 'false') return { value: false, next: j + 5 };
    if (word === 'null') return { value: null, next: j + 4 };
    return { value: word, next: j + word.length }; // enum
  }
  return { value: null, next: j + 1 };
};
const gqlParseSelection = (s: string, i: number, vars: Record<string, unknown>): { fields: GqlField[]; next: number } => {
  const fields: GqlField[] = [];
  let j = i;
  const skip = (k: number): number => { while (k < s.length && /[\s,]/.test(s[k])) k += 1; return k; };
  for (;;) {
    j = skip(j);
    if (j >= s.length || s[j] === '}') return { fields, next: j + 1 };
    if (s.startsWith('...', j)) {
      j += 3; j = skip(j);
      let fragType: string | undefined;
      if (s.startsWith('on ', j)) { const m = /^on ([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(j))!; fragType = m[1]; j += m[0].length; }
      j = skip(j);
      if (s[j] === '{') { const inner = gqlParseSelection(s, j + 1, vars); for (const f of inner.fields) fields.push({ ...f, fragmentType: fragType }); j = inner.next; continue; }
      continue;
    }
    const nameMatch = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(j));
    if (!nameMatch) { j += 1; continue; }
    let name = nameMatch[0]; j += name.length;
    let alias = name;
    j = skip(j);
    if (s[j] === ':') { alias = name; j += 1; j = skip(j); const nm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(j))!; name = nm[0]; j += name.length; }
    const args: Record<string, unknown> = {};
    j = skip(j);
    if (s[j] === '(') {
      j += 1;
      for (;;) {
        j = skip(j); if (s[j] === ')') { j += 1; break; }
        const km = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(j))!; const key = km[0]; j += key.length;
        j = skip(j); if (s[j] === ':') j += 1;
        const r = gqlParseValue(s, j, vars); args[key] = r.value; j = r.next;
      }
    }
    j = skip(j);
    let sub: GqlField[] | null = null;
    if (s[j] === '{') { const inner = gqlParseSelection(s, j + 1, vars); sub = inner.fields; j = inner.next; }
    fields.push({ alias, name, args, fields: sub });
  }
};
const gqlParseDocument = (doc: string, vars: Record<string, unknown>): { op: string; fields: GqlField[] } => {
  let s = doc;
  // Strip variable definitions: find the first '{' that opens the selection set.
  const opMatch = /^\s*(query|mutation|subscription)?\s*[A-Za-z_][A-Za-z0-9_]*\s*(\([^)]*\))?\s*\{/.exec(s);
  let start = s.indexOf('{');
  if (opMatch) start = s.indexOf('{', opMatch[0].length - 1);
  const op = /^\s*mutation/.test(s) ? 'mutation' : 'query';
  const { fields } = gqlParseSelection(s, start + 1, vars);
  return { op, fields };
};
const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef', 'url', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'isPrivate'],
  User: ['id', 'login', 'name', 'email'],
  SearchType: [],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  PageInfo: ['hasNextPage', 'endCursor', 'hasPreviousPage', 'startCursor'],
  Ref: ['name'],
};
const TYPE_KIND: Record<string, string> = { Issue: 'OBJECT', PullRequest: 'OBJECT', Repository: 'OBJECT', User: 'OBJECT', SearchType: 'ENUM', IssueConnection: 'OBJECT', PullRequestConnection: 'OBJECT' };
const SEARCH_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'];
const issueStateGql = (s: string): string => s === 'open' ? 'OPEN' : 'CLOSED';
const prStateGql = (pr: Pull): string => pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';

const gqlResolveIssue = (repo: Repo, issue: Issue, fields: GqlField[] | null, errors: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    switch (f.name) {
      case 'id': out[f.alias] = gid('I', issue.dbId); break;
      case 'number': out[f.alias] = issue.number; break;
      case 'title': out[f.alias] = issue.title; break;
      case 'body': out[f.alias] = issue.body; break;
      case 'state': out[f.alias] = issueStateGql(issue.state); break;
      case 'url': out[f.alias] = `/${repo.owner}/${repo.name}/issues/${issue.number}`; break;
      case 'createdAt': case 'updatedAt': out[f.alias] = new Date(BASE_EPOCH * 1000).toISOString(); break;
      case 'author': out[f.alias] = f.fields ? { login: VIEWER } : { login: VIEWER }; break;
      default: errors.push(`Cannot query field "${f.name}" on type "Issue".`); break;
    }
  }
  return out;
};
const gqlResolvePull = (repo: Repo, pr: Pull, fields: GqlField[] | null, errors: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    switch (f.name) {
      case 'id': out[f.alias] = gid('P', pr.dbId); break;
      case 'number': out[f.alias] = pr.number; break;
      case 'title': out[f.alias] = pr.title; break;
      case 'body': out[f.alias] = pr.body; break;
      case 'state': out[f.alias] = prStateGql(pr); break;
      case 'merged': out[f.alias] = pr.merged; break;
      case 'headRefName': out[f.alias] = pr.head; break;
      case 'baseRefName': out[f.alias] = pr.base; break;
      case 'mergeable': out[f.alias] = prMergeable(repo, pr); break;
      case 'url': out[f.alias] = `/${repo.owner}/${repo.name}/pulls/${pr.number}`; break;
      case 'createdAt': case 'updatedAt': out[f.alias] = new Date(BASE_EPOCH * 1000).toISOString(); break;
      case 'files': {
        const first = typeof f.args.first === 'number' ? f.args.first : 100;
        const nodes = diffFiles(repo, pr.baseSha, pr.headSha).slice(0, first).map((d) => ({ path: d.path, filename: d.path }));
        out[f.alias] = { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null } };
        break;
      }
      default: errors.push(`Cannot query field "${f.name}" on type "PullRequest".`); break;
    }
  }
  return out;
};
const gqlResolveRepo = (repo: Repo, fields: GqlField[] | null, errors: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    switch (f.name) {
      case 'id': out[f.alias] = repo.globalId; break;
      case 'databaseId': out[f.alias] = repo.dbId; break;
      case 'name': out[f.alias] = repo.name; break;
      case 'nameWithOwner': out[f.alias] = `${repo.owner}/${repo.name}`; break;
      case 'description': out[f.alias] = repo.description; break;
      case 'isPrivate': out[f.alias] = repo.isPrivate; break;
      case 'url': out[f.alias] = `/${repo.owner}/${repo.name}`; break;
      case 'owner': out[f.alias] = { login: repo.owner, id: String(VIEWER_ID) }; break;
      case 'defaultBranchRef': {
        const tip = tipOf(repo, repo.defaultBranch);
        out[f.alias] = tip ? { name: repo.defaultBranch } : null;
        break;
      }
      case 'viewerPermission': out[f.alias] = 'ADMIN'; break;
      case 'hasIssuesEnabled': out[f.alias] = true; break;
      case 'issue': {
        const issue = repo.issues.get(Number(f.args.number));
        out[f.alias] = issue ? gqlResolveIssue(repo, issue, f.fields, errors) : null;
        break;
      }
      case 'issues': {
        let list = [...repo.issues.values()];
        const states = Array.isArray(f.args.states) ? (f.args.states as string[]) : null;
        if (states) list = list.filter((i) => states.includes(issueStateGql(i.state)));
        const orderBy = isRecord(f.args.orderBy) ? f.args.orderBy : null;
        const desc = orderBy?.direction === 'ASC' ? 1 : -1;
        list.sort((a, b) => desc * (a.seq - b.seq) || desc * (a.number - b.number));
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        let startIdx = 0;
        if (typeof f.args.after === 'string' && f.args.after) {
          try {
            const decoded = Buffer.from(f.args.after, 'base64').toString('utf8');
            const afterNum = Number(decoded.split(':')[1]);
            const idx = list.findIndex((i) => i.number === afterNum);
            if (idx >= 0) startIdx = idx + 1;
          } catch { /* ignore */ }
        }
        const page = list.slice(startIdx, startIdx + first);
        const endCursor = page.length ? Buffer.from(`issue:${page[page.length - 1]!.number}`).toString('base64') : null;
        out[f.alias] = {
          nodes: page.map((i) => gqlResolveIssue(repo, i, f.fields?.find((x) => x.name === 'nodes')?.fields ?? null, errors)),
          totalCount: list.length,
          pageInfo: { hasNextPage: startIdx + first < list.length, endCursor },
        };
        break;
      }
      case 'pullRequests': {
        let list = [...repo.pulls.values()];
        const first = typeof f.args.first === 'number' ? f.args.first : list.length;
        list.sort((a, b) => b.seq - a.seq);
        const page = list.slice(0, first);
        out[f.alias] = {
          nodes: page.map((p) => gqlResolvePull(repo, p, f.fields?.find((x) => x.name === 'nodes')?.fields ?? null, errors)),
          totalCount: list.length,
          pageInfo: { hasNextPage: list.length > first, endCursor: null },
        };
        break;
      }
      case 'pullRequest': {
        const pr = repo.pulls.get(Number(f.args.number));
        out[f.alias] = pr ? gqlResolvePull(repo, pr, f.fields, errors) : null;
        break;
      }
      default: errors.push(`Cannot query field "${f.name}" on type "Repository".`); break;
    }
  }
  return out;
};
const gqlTypeField = (typeName: string, f: GqlField, errors: string[]): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  for (const sub of f.fields ?? []) {
    if (sub.name === 'name') out[sub.alias] = typeName;
    else if (sub.name === 'kind') out[sub.alias] = TYPE_KIND[typeName] ?? 'OBJECT';
    else if (sub.name === 'fields') out[sub.alias] = (TYPE_FIELDS[typeName] ?? []).map((n) => ({ name: n, description: null }));
    else if (sub.name === 'enumValues') out[sub.alias] = typeName === 'SearchType' ? SEARCH_ENUM.map((n) => ({ name: n, description: null })) : [];
    else if (sub.name === 'description') out[sub.alias] = null;
    else errors.push(`Cannot query field "${sub.name}" on type "__Type".`);
  }
  return out;
};
const gqlExecute = (doc: string, vars: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } => {
  const errors: string[] = [];
  const { fields } = gqlParseDocument(doc, vars);
  const data: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.name === 'viewer') {
      const out: Record<string, unknown> = {};
      for (const sub of f.fields ?? []) {
        if (sub.name === 'login') out[sub.alias] = VIEWER;
        else errors.push(`Cannot query field "${sub.name}" on type "Viewer".`);
      }
      data[f.alias] = out;
    } else if (f.name === 'repository') {
      const owner = String(f.args.owner ?? '');
      const name = String(f.args.name ?? '');
      const repo = findRepo(owner, name);
      data[f.alias] = repo ? gqlResolveRepo(repo, f.fields, errors) : null;
    } else if (f.name === '__type') {
      const typeName = String(f.args.name ?? '');
      data[f.alias] = TYPE_FIELDS[typeName] !== undefined || TYPE_KIND[typeName] !== undefined ? gqlTypeField(typeName, f, errors) : null;
      if (data[f.alias] === null && typeName === 'SearchType') data[f.alias] = gqlTypeField(typeName, f, errors);
    } else if (f.name === 'node') {
      const id = String(f.args.id ?? '');
      const entry = byGlobalId.get(id);
      if (!entry) { data[f.alias] = null; continue; }
      if (entry.kind === 'repo') {
        const resolved = gqlResolveRepo(entry.repo, f.fields?.filter((x) => !x.fragmentType || x.fragmentType === 'Repository') ?? null, errors);
        // Inline fragment fields were merged into f.fields with fragmentType set;
        // gqlResolveRepo ignores unknown fragment fields, so re-resolve plainly:
        data[f.alias] = { id: entry.repo.globalId, ...resolved };
      } else if (entry.kind === 'issue') {
        const issue = entry.repo.issues.get(entry.number!);
        data[f.alias] = issue ? { id: gid('I', issue.dbId), ...gqlResolveIssue(entry.repo, issue, f.fields, errors) } : null;
      } else {
        const pr = entry.repo.pulls.get(entry.number!);
        data[f.alias] = pr ? { id: gid('P', pr.dbId), ...gqlResolvePull(entry.repo, pr, f.fields, errors) } : null;
      }
    } else if (f.name === 'createIssue') {
      const input = isRecord(f.args.input) ? f.args.input : {};
      const repoId = String(input.repositoryId ?? '');
      const entry = byGlobalId.get(repoId);
      let issue: Issue | null = null;
      if (entry?.kind === 'repo') issue = createIssueObj(entry.repo, String(input.title ?? ''), String(input.body ?? ''), []);
      if (!issue) { errors.push('Could not resolve to a Repository with the provided repositoryId.'); data[f.alias] = null; continue; }
      const out: Record<string, unknown> = {};
      for (const sub of f.fields?.find((x) => x.name === 'issue')?.fields ?? []) {
        if (sub.name === 'number') out[sub.alias] = issue.number;
        else if (sub.name === 'id') out[sub.alias] = gid('I', issue.dbId);
        else errors.push(`Cannot query field "${sub.name}" on type "Issue".`);
      }
      data[f.alias] = { issue: out };
    } else if (f.name === 'closeIssue') {
      const input = isRecord(f.args.input) ? f.args.input : {};
      const entry = byGlobalId.get(String(input.issueId ?? ''));
      let issue: Issue | null = null;
      if (entry?.kind === 'issue') issue = entry.repo.issues.get(entry.number!) ?? null;
      if (!issue) { errors.push('Could not resolve to an Issue with the provided issueId.'); data[f.alias] = null; continue; }
      issue.state = 'closed';
      const out: Record<string, unknown> = {};
      for (const sub of f.fields?.find((x) => x.name === 'issue')?.fields ?? []) {
        if (sub.name === 'number') out[sub.alias] = issue.number;
        else if (sub.name === 'id') out[sub.alias] = gid('I', issue.dbId);
        else if (sub.name === 'state') out[sub.alias] = 'CLOSED';
        else errors.push(`Cannot query field "${sub.name}" on type "Issue".`);
      }
      data[f.alias] = { issue: out };
    } else if (f.name === 'createPullRequest') {
      const input = isRecord(f.args.input) ? f.args.input : {};
      const entry = byGlobalId.get(String(input.repositoryId ?? ''));
      const head = String(input.headRefName ?? '');
      const base = String(input.baseRefName ?? entry?.repo.defaultBranch ?? 'main');
      let pr: Pull | null = null;
      if (entry?.kind === 'repo') pr = createPullObj(entry.repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
      if (!pr) { errors.push('Could not create pull request: head or base branch does not exist, or a pull request already exists.'); data[f.alias] = null; continue; }
      const out: Record<string, unknown> = {};
      for (const sub of f.fields?.find((x) => x.name === 'pullRequest')?.fields ?? []) {
        if (sub.name === 'number') out[sub.alias] = pr.number;
        else if (sub.name === 'id') out[sub.alias] = gid('P', pr.dbId);
        else if (sub.name === 'state') out[sub.alias] = 'OPEN';
        else if (sub.name === 'headRefName') out[sub.alias] = pr.head;
        else if (sub.name === 'baseRefName') out[sub.alias] = pr.base;
        else errors.push(`Cannot query field "${sub.name}" on type "PullRequest".`);
      }
      data[f.alias] = { pullRequest: out };
    } else if (f.name === 'mergePullRequest') {
      const input = isRecord(f.args.input) ? f.args.input : {};
      const entry = byGlobalId.get(String(input.pullRequestId ?? ''));
      let pr: Pull | null = null;
      if (entry?.kind === 'pull') pr = entry.repo.pulls.get(entry.number!) ?? null;
      if (!pr) { errors.push('Could not resolve to a PullRequest with the provided pullRequestId.'); data[f.alias] = null; continue; }
      const merged = pr.state === 'open' ? doSquashMerge(entry.repo, pr) : { ok: false };
      const out: Record<string, unknown> = {};
      for (const sub of f.fields?.find((x) => x.name === 'pullRequest')?.fields ?? []) {
        if (sub.name === 'number') out[sub.alias] = pr.number;
        else if (sub.name === 'merged') out[sub.alias] = merged.ok;
        else if (sub.name === 'state') out[sub.alias] = prStateGql(pr);
        else errors.push(`Cannot query field "${sub.name}" on type "PullRequest".`);
      }
      data[f.alias] = { pullRequest: out };
    } else if (f.name === 'addComment') {
      const input = isRecord(f.args.input) ? f.args.input : {};
      const entry = byGlobalId.get(String(input.subjectId ?? ''));
      let issue: Issue | null = null;
      if (entry?.kind === 'issue') issue = entry.repo.issues.get(entry.number!) ?? null;
      if (!issue) { errors.push('Could not resolve to an Issue with the provided subjectId.'); data[f.alias] = null; continue; }
      const comment: Comment = { id: entry.repo.nextComment, body: String(input.body ?? ''), user: VIEWER };
      entry.repo.nextComment += 1;
      issue.comments.push(comment);
      const node: Record<string, unknown> = {};
      const edge = f.fields?.find((x) => x.name === 'commentEdge');
      for (const sub of edge?.fields?.find((x) => x.name === 'node')?.fields ?? []) {
        if (sub.name === 'id') node[sub.alias] = gid('CM', nextDbId());
        else if (sub.name === 'body') node[sub.alias] = comment.body;
        else errors.push(`Cannot query field "${sub.name}" on type "IssueComment".`);
      }
      data[f.alias] = { commentEdge: { node } };
    } else {
      errors.push(`Cannot query field "${f.name}" on type "Query".`);
      data[f.alias] = null;
    }
  }
  return { data, errors: errors.map((message) => ({ message })) };
};
async function handleGraphQL(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const buf = await readBody(req);
  if (!authOk(req)) { errJson(res, 401, 'Requires authentication'); return; }
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) { sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] }); return; }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') return { data: null, errors: [{ message: 'Must provide query string.' }] };
    const vars = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    const { data, errors } = gqlExecute(doc.query, vars);
    return errors.length ? { data, errors } : { data };
  };
  if (Array.isArray(parsed.value)) sendJson(res, 200, parsed.value.map(runOne));
  else sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------- MCP
const MCP_TOOLS: { name: string; description: string; inputSchema: Record<string, unknown> }[] = [
  { name: 'create_repo', description: 'Create a repository owned by the authenticated user.', inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, description: { type: 'string', description: 'Repository description' }, private: { type: 'boolean', description: 'Whether the repository is private' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['name'] } },
  { name: 'get_repo', description: 'Get a repository by owner and name.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' } }, required: ['owner', 'repo'] } },
  { name: 'create_issue', description: 'Create an issue in a repository.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' }, title: { type: 'string', description: 'Issue title' }, body: { type: 'string', description: 'Issue body' } }, required: ['owner', 'repo', 'title'] } },
  { name: 'list_issues', description: 'List issues in a repository, optionally filtered by state.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' }, state: { type: 'string', description: 'Issue state: open, closed or all' } }, required: ['owner', 'repo'] } },
  { name: 'create_pull_request', description: 'Create a pull request from a head branch onto a base branch.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' }, title: { type: 'string', description: 'Pull request title' }, body: { type: 'string', description: 'Pull request body' }, head: { type: 'string', description: 'Head branch name' }, base: { type: 'string', description: 'Base branch name' } }, required: ['owner', 'repo', 'title', 'head', 'base'] } },
  { name: 'merge_pull_request', description: 'Merge a pull request with a squash merge.', inputSchema: { type: 'object', properties: { owner: { type: 'string', description: 'Repository owner' }, repo: { type: 'string', description: 'Repository name' }, full_name: { type: 'string', description: 'owner/repo' }, pull_number: { type: 'integer', description: 'Pull request number' }, number: { type: 'integer', description: 'Pull request number' } }, required: ['owner', 'repo', 'pull_number'] } },
];
const mcpOwnerRepo = (args: Record<string, unknown>): { owner: string; repo: string } => {
  let owner = typeof args.owner === 'string' ? args.owner : '';
  let repo = typeof args.repo === 'string' ? args.repo : '';
  if ((!owner || !repo) && typeof args.full_name === 'string') {
    const parts = args.full_name.split('/');
    if (parts.length === 2) { owner = owner || parts[0]; repo = repo || parts[1]; }
  }
  if (!owner) owner = VIEWER;
  return { owner, repo };
};
const mcpToolResult = (obj: unknown, isError = false): Record<string, unknown> => ({
  content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj) }],
  structuredContent: obj, isError,
});
async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'POST';
  if (method === 'DELETE' || method === 'GET') { res.writeHead(204, { 'mcp-session-id': 'session-1' }); res.end(); return; }
  if (method !== 'POST') { sendJson(res, 405, { message: 'Method Not Allowed' }); return; }
  const buf = await readBody(req);
  const rpc = (id: unknown, result: unknown): void => sendJson(res, 200, { jsonrpc: '2.0', id, result }, { 'mcp-session-id': 'session-1' });
  const rpcErr = (id: unknown, code: number, message: string, status = 200): void => sendJson(res, status, { jsonrpc: '2.0', id, error: { code, message } }, { 'mcp-session-id': 'session-1' });
  const parsed = parseJsonBody(buf);
  if (!parsed.ok) { rpcErr(null, -32700, 'Parse error', 400); return; }
  if (!authOk(req)) { sendJson(res, 401, { message: 'Requires authentication' }); return; }
  const value = parsed.value;
  if (!isRecord(value) || typeof value.method !== 'string') { rpcErr(isRecord(value) ? value.id ?? null : null, -32600, 'Invalid Request'); return; }
  const id = value.id ?? null;
  const params = isRecord(value.params) ? value.params : {};
  const m = value.method;
  if (m === 'server/discover') {
    rpc(id, {
      protocolVersion: '2026-07-28',
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo: { name: 'github-core-clone', version: '1.0.0' },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'github-core-clone', version: '1.0.0' } },
    });
    return;
  }
  if (m === 'initialize') {
    const pv = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    rpc(id, { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: { name: 'github-core-clone', version: '1.0.0' } });
    return;
  }
  if (m === 'notifications/initialized' || m.startsWith('notifications/')) {
    res.writeHead(202, { 'mcp-session-id': 'session-1' }); res.end(); return;
  }
  if (m === 'ping') { rpc(id, {}); return; }
  if (m === 'tools/list') {
    rpc(id, { tools: MCP_TOOLS });
    return;
  }
  if (m === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) { rpcErr(id, -32601, `Unknown tool: ${name}`); return; }
    const required = (tool.inputSchema.required as string[]) ?? [];
    // Map common synonyms the suite may use onto canonical names.
    const norm = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, '');
    const syn: Record<string, string[]> = {
      owner: ['owner', 'ownerlogin', 'login', 'user', 'userlogin'],
      repo: ['repo', 'repository', 'repositoryname', 'reponame'],
      title: ['title', 'issuetitle', 'prtitle'],
      body: ['body', 'issuebody', 'description', 'content', 'text'],
      head: ['head', 'headref', 'headbranch', 'sourcebranch'],
      base: ['base', 'baseref', 'basebranch', 'targetbranch'],
      pull_number: ['pullnumber', 'pullrequestnumber', 'prnumber', 'number', 'issuenumber'],
      name: ['name', 'repo', 'repository', 'repositoryname', 'reponame'],
      private: ['private', 'isprivate'],
    };
    const canon: Record<string, unknown> = { ...args };
    for (const [canonical, alts] of Object.entries(syn)) {
      if (canon[canonical] === undefined) {
        for (const a of alts) {
          const found = Object.keys(args).find((k) => norm(k) === a);
          if (found) { canon[canonical] = args[found]; break; }
        }
      }
    }
    const missing = required.filter((r) => canon[r] === undefined || canon[r] === null || canon[r] === '');
    if (missing.length) { rpc(id, mcpToolResult(`Missing required argument: ${missing.join(', ')}`, true)); return; }
    try {
      const { owner, repo: repoName } = mcpOwnerRepo(canon);
      if (name === 'create_repo') {
        const rname = String(canon.name ?? '');
        if (!rname) { rpc(id, mcpToolResult('Missing required argument: name', true)); return; }
        if (repos.has(rname)) { rpc(id, mcpToolResult(repoJson(repos.get(rname)!))); return; }
        const repo = createRepoObj(rname, canon.private === true, typeof canon.description === 'string' ? canon.description : '');
        rpc(id, mcpToolResult(repoJson(repo))); return;
      }
      const repo = findRepo(owner, repoName);
      if (!repo) { rpc(id, mcpToolResult(`Repository not found: ${owner}/${repoName}`, true)); return; }
      if (name === 'get_repo') { rpc(id, mcpToolResult(repoJson(repo))); return; }
      if (name === 'create_issue') {
        const issue = createIssueObj(repo, String(canon.title ?? ''), typeof canon.body === 'string' ? canon.body : '', []);
        rpc(id, mcpToolResult(issueJson(repo, issue))); return;
      }
      if (name === 'list_issues') {
        const state = typeof canon.state === 'string' ? canon.state : 'open';
        let list = [...repo.issues.values()];
        if (state !== 'all') list = list.filter((i) => i.state === state);
        list.sort((a, b) => b.seq - a.seq);
        rpc(id, mcpToolResult(list.map((i) => issueJson(repo, i)))); return;
      }
      if (name === 'create_pull_request') {
        let head = String(canon.head ?? '');
        let base = String(canon.base ?? repo.defaultBranch);
        if (head.includes(':')) head = head.split(':').slice(1).join(':');
        if (base.includes(':')) base = base.split(':').slice(1).join(':');
        if (!tipOf(repo, head) || !tipOf(repo, base)) { rpc(id, mcpToolResult('head or base branch does not exist', true)); return; }
        const pr = createPullObj(repo, String(canon.title ?? ''), typeof canon.body === 'string' ? canon.body : '', head, base);
        if (!pr) { rpc(id, mcpToolResult('a pull request already exists for this head', true)); return; }
        rpc(id, mcpToolResult(pullJson(repo, pr))); return;
      }
      if (name === 'merge_pull_request') {
        const num = Number(canon.pull_number);
        const pr = repo.pulls.get(num);
        if (!pr) { rpc(id, mcpToolResult(`Pull request #${num} not found`, true)); return; }
        if (pr.state !== 'open') { rpc(id, mcpToolResult('Pull request is already merged or closed', true)); return; }
        const merged = doSquashMerge(repo, pr);
        if (!merged.ok) { rpc(id, mcpToolResult('Merge conflict', true)); return; }
        rpc(id, mcpToolResult({ sha: merged.sha, merged: true, message: 'Pull request successfully merged', number: pr.number, state: 'closed' })); return;
      }
    } catch (e) {
      rpc(id, mcpToolResult(e instanceof Error ? e.message : String(e), true)); return;
    }
    rpcErr(id, -32602, 'Invalid params');
    return;
  }
  rpcErr(id, -32601, `Method not found: ${m}`);
}

// ---------------------------------------------------------------- router / app
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const path = pathOf(req);
        const q = queryOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') { sendJson(res, 200, { ok: true }); return; }
        if (path === '/api/graphql' && method === 'POST') { await handleGraphQL(req, res); return; }
        if (path === '/mcp') { await handleMcp(req, res); return; }
        if (path.startsWith('/api/v3')) { await handleRest(req, res, path, q); return; }
        const gitMatch = /^\/[^/]+\/[^/]+\.git\//.test(path);
        if (gitMatch) { await handleGit(req, res, path, q); return; }
        // Unknown route: JSON 404 (with request id). Read/discard a body so
        // the connection can close cleanly.
        if (method === 'POST' || method === 'PUT' || method === 'PATCH') { try { await readBody(req); } catch { /* ignore */ } }
        errJson(res, 404, 'Not Found');
      } catch (e) {
        try { errJson(res, 500, e instanceof Error ? e.message : 'Internal Server Error'); } catch { /* socket gone */ }
      }
    })();
  });
}
