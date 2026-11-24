// mend: one patch tool for every AI edit format (SPEC.md is the contract).
//
// Reads a patch in one of four formats — unified diff, SEARCH/REPLACE blocks, V4A, JSON tool calls — finds the
// lines each edit names at the first of three matching tiers (exact, trailing-whitespace-insensitive,
// indentation-insensitive), and writes every change or none. Node 22, standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set; the last lines hand over to runner.ts.
// Run directly, it is the CLI: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: the single line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed with a SPEC.md section 2 code at a path. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at \n, one trailing \r removed each, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Section 3: a safe path is relative, backslash-free, with no empty, `.` or `..` segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

// ---------------------------------------------------------------------------
// The tree: original bytes are read lazily from disk; edits stage their result
// in `now` (null: deleted). Nothing reaches disk until every edit succeeded.
// ---------------------------------------------------------------------------

class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful move edits, in patch order: [oldPath, newPath]. */
  readonly moves: Array<[string, string]> = [];

  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------------------------------------------------------------------------
// Files as lines (section 3): a file's break is CRLF when its first line feed
// follows a carriage return, else LF; `end` says it ends with that break.
// ---------------------------------------------------------------------------

interface FileModel {
  br: string;
  lines: string[];
  end: boolean;
}

function splitFile(text: string): FileModel {
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { br, lines: [], end: false };
  const lines = text.split(br);
  const end = text.endsWith(br);
  if (end) lines.pop();
  return { br, lines, end };
}

function joinFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.end ? m.br : '');
}

// ---------------------------------------------------------------------------
// Matching (section 5): three tiers; an occurrence is a start position where
// every line of O matches. `strict` restricts the run to tier 0.
// ---------------------------------------------------------------------------

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimTrail(a) === trimTrail(b);
  return trimBoth(a) === trimBoth(b);
}

interface Occurrence {
  tier: number;
  positions: number[];
}

/** Every occurrence of O in `lines` at the first tier that has one, or null. */
function findOccurrences(lines: string[], o: string[], strict: boolean, from = 0, onlyEndingAt = -1): Occurrence | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions: number[] = [];
    for (let i = from; i + o.length <= lines.length; i += 1) {
      if (onlyEndingAt >= 0 && i + o.length !== onlyEndingAt) continue;
      let ok = true;
      for (let k = 0; k < o.length; k += 1) {
        if (!lineEq(lines[i + k]!, o[k]!, tier)) {
          ok = false;
          break;
        }
      }
      if (ok) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One body entry of a hunk or chunk: context, old-only or new-only text. */
interface Entry {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this entry in the body. */
  bs: boolean;
}

const oldOf = (entries: Entry[]): string[] => entries.filter((e) => e.kind !== 'new').map((e) => e.text);
const newOf = (entries: Entry[]): string[] => entries.filter((e) => e.kind !== 'old').map((e) => e.text);

/**
 * The lines N writes over a match of O at `pos`: context entries are the file's own matched lines; at tier 2 the
 * other lines are re-indented from O's first line's leading whitespace P to the file's first matched line's F.
 */
function writtenLines(entries: Entry[], fileLines: string[], pos: number, tier: number): string[] {
  const out: string[] = [];
  let oPos = pos;
  let f = '';
  let p = '';
  if (tier === 2) {
    f = /^[ \t]*/.exec(fileLines[pos] ?? '')![0];
    const firstOld = entries.find((e) => e.kind !== 'new');
    p = /^[ \t]*/.exec(firstOld?.text ?? '')![0];
  }
  for (const e of entries) {
    if (e.kind === 'ctx') {
      out.push(fileLines[oPos]!);
      oPos += 1;
    } else if (e.kind === 'old') {
      oPos += 1;
    } else if (tier === 2 && e.text !== '' && e.text.trim() !== '' && e.text.startsWith(p)) {
      out.push(f + e.text.slice(p.length));
    } else {
      out.push(e.text);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Format detection (section 4).
// ---------------------------------------------------------------------------

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Unified diffs (section 6).
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  entries: Entry[];
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path a `---`/`+++` line names: after the four characters, to the first tab, spaces removed, a/ or b/ off. */
function headerPath(line: string): string | null {
  let rest = line.slice(4);
  const tab = rest.indexOf('\t');
  if (tab >= 0) rest = rest.slice(0, tab);
  rest = rest.trim();
  if (rest === '/dev/null') return null;
  if (rest.startsWith('a/') || rest.startsWith('b/')) rest = rest.slice(2);
  return rest;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  const newSection = (): Section => {
    const s: Section = {
      gitOld: null, gitNew: null, pairOld: null, pairNew: null, hasPair: false,
      renameFrom: null, renameTo: null, newFile: false, deletedFile: false, hunks: [],
    };
    sections.push(s);
    cur = s;
    inHeader = true;
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const mid = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (mid < 0) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.gitOld = rest.slice(2, mid);
      s.gitNew = rest.slice(mid + 3);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasPair || cur.hunks.length > 0) newSection();
      cur!.pairOld = headerPath(line);
      cur!.pairNew = headerPath(lines[i + 1]!);
      cur!.hasPair = true;
      inHeader = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ') && cur !== null && inHeader) {
      // A `---` inside a section's header with no `+++` after it.
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const entries: Entry[] = [];
      const fromEmpty: boolean[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const l = lines[j]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (l === '') {
          entries.push({ kind: 'ctx', text: '', bs: false });
          fromEmpty.push(true);
        } else if (l[0] === ' ') {
          entries.push({ kind: 'ctx', text: l.slice(1), bs: false });
          fromEmpty.push(false);
        } else if (l[0] === '-') {
          entries.push({ kind: 'old', text: l.slice(1), bs: false });
          fromEmpty.push(false);
        } else if (l[0] === '+') {
          entries.push({ kind: 'new', text: l.slice(1), bs: false });
          fromEmpty.push(false);
        } else if (l[0] === '\\') {
          const prev = entries[entries.length - 1];
          if (prev !== undefined) prev.bs = true;
        } else break;
        j += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (fromEmpty.length > 0 && fromEmpty[fromEmpty.length - 1]) {
        fromEmpty.pop();
        entries.pop();
      }
      cur.hunks.push({ a: Number(m[1]), entries });
      inHeader = false;
      i = j;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length);
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length);
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i += 1;
  }
  return sections;
}

/** Apply one hunk to the model; `d` is the section's running line delta. Returns the new delta. */
function applyHunk(model: FileModel, hunk: Hunk, d: number, strict: boolean, path: string): number {
  const o = oldOf(hunk.entries);
  const n = newOf(hunk.entries);
  if (o.length === 0) {
    const pos = Math.min(hunk.a + d, model.lines.length);
    model.lines.splice(pos, 0, ...n);
    if (pos === model.lines.length - n.length && n.length > 0) {
      // The insertion is at the end: the final break follows the `\` rule.
      const lastNew = hunk.entries[hunk.entries.length - 1];
      model.end = !(lastNew !== undefined && lastNew.bs);
    }
    return d + n.length;
  }
  const occ = findOccurrences(model.lines, o, strict);
  if (occ === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let pos = occ.positions[0]!;
  for (const p of occ.positions) {
    if (Math.abs(p - target) < Math.abs(pos - target)) pos = p;
  }
  const written = writtenLines(hunk.entries, model.lines, pos, occ.tier);
  const runsToEnd = pos + o.length === model.lines.length;
  model.lines.splice(pos, o.length, ...written);
  if (runsToEnd && n.length > 0) {
    const lastN = hunk.entries.filter((e) => e.kind !== 'old').pop();
    model.end = !(lastN !== undefined && lastN.bs);
  }
  return d + n.length - o.length;
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.hasPair ? s.pairOld : s.renameFrom ?? s.gitOld;
  const newPath = s.hasPair ? s.pairNew : s.renameTo ?? s.gitNew;
  const isCreate = (s.hasPair && s.pairOld === null) || s.newFile;
  const isDelete = (s.hasPair && s.pairNew === null) || s.deletedFile;
  return (tree) => {
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlusBs = false;
      for (const h of s.hunks) {
        for (const e of h.entries) {
          if (e.kind === 'new') {
            plus.push(e.text);
            lastPlusBs = e.bs;
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusBs ? '' : '\n'));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    const src = oldPath!;
    const dst = newPath!;
    if (!safe(src)) throw new Fail('unsafe', src);
    if (dst !== src && !safe(dst)) throw new Fail('unsafe', dst);
    const before = tree.get(src);
    if (before === null) throw new Fail('missing', src);
    if (dst !== src && tree.get(dst) !== null) throw new Fail('exists', dst);
    const model = splitFile(before);
    let d = 0;
    for (const h of s.hunks) d = applyHunk(model, h, d, strict, src);
    const text = joinFile(model);
    if (dst !== src) {
      tree.now.set(src, null);
      tree.now.set(dst, text);
      tree.moves.push([src, dst]);
    } else {
      tree.now.set(src, text);
    }
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (section 7).
// ---------------------------------------------------------------------------

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SRBlock[] {
  const blocks: SRBlock[] = [];
  let prevPath: string | null = null;
  let regionStart = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchLine = i;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let t = searchLine - 1; t >= regionStart; t -= 1) {
      const l = lines[t]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    blocks.push({ path, oldLines: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevPath = path;
    regionStart = rep + 1;
    i = rep + 1;
  }
  return blocks;
}

function searchReplaceEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = splitFile(before);
    const occ = findOccurrences(model.lines, b.oldLines, strict);
    if (occ === null) throw new Fail('no-match', b.path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', b.path);
    const pos = occ.positions[0]!;
    // No context lines here: the old entries only fix the match, every written line comes from a `new` entry.
    const entries: Entry[] = [
      ...b.oldLines.map((t): Entry => ({ kind: 'old', text: t, bs: false })),
      ...b.newLines.map((t): Entry => ({ kind: 'new', text: t, bs: false })),
    ];
    const written = writtenLines(entries, model.lines, pos, occ.tier);
    model.lines.splice(pos, b.oldLines.length, ...written);
    tree.now.set(b.path, joinFile(model));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (section 8).
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  entries: Entry[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  fileLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

const V_ADD = '*** Add File: ';
const V_DEL = '*** Delete File: ';
const V_UPD = '*** Update File: ';
const V_MOVE = '*** Move to: ';

function vSectionStart(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith(V_ADD)) return 'add';
  if (line.startsWith(V_DEL)) return 'delete';
  if (line.startsWith(V_UPD)) return 'update';
  return null;
}

interface RawLine {
  text: string;
  lineNo: number;
}

function parseV4A(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  // Split the lines between Begin and End Patch into sections at their header lines.
  interface Raw {
    kind: 'add' | 'delete' | 'update';
    path: string;
    lineNo: number;
    body: RawLine[];
  }
  const raws: Raw[] = [];
  let cur: Raw | null = null;
  for (let i = first + 1; i < last; i += 1) {
    const line = lines[i]!;
    const kind = vSectionStart(line);
    if (kind !== null) {
      const pre = kind === 'add' ? V_ADD : kind === 'delete' ? V_DEL : V_UPD;
      cur = { kind, path: line.slice(pre.length).trim(), lineNo: i + 1, body: [] };
      raws.push(cur);
    } else if (cur !== null) {
      cur.body.push({ text: line, lineNo: i + 1 });
    } else if (!blank(line)) {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }

  const sections: VSection[] = [];
  for (const raw of raws) {
    // Blank lines at the end of a section are not part of it (a whitespace-only line is blank).
    while (raw.body.length > 0 && blank(raw.body[raw.body.length - 1]!.text)) raw.body.pop();
    if (raw.kind === 'add') {
      const fileLines: string[] = [];
      for (const { text, lineNo } of raw.body) {
        if (text === '') fileLines.push('');
        else if (text.startsWith('+')) fileLines.push(text.slice(1));
        else throw new Exit2(`error: parse ${lineNo}`);
      }
      sections.push({ kind: 'add', path: raw.path, lineNo: raw.lineNo, fileLines, moveTo: null, chunks: [] });
    } else if (raw.kind === 'delete') {
      for (const { text, lineNo } of raw.body) {
        if (!blank(text)) throw new Exit2(`error: parse ${lineNo}`);
      }
      sections.push({ kind: 'delete', path: raw.path, lineNo: raw.lineNo, fileLines: [], moveTo: null, chunks: [] });
    } else {
      let idx = 0;
      while (idx < raw.body.length && raw.body[idx]!.text === '') idx += 1;
      let moveTo: string | null = null;
      if (idx < raw.body.length && raw.body[idx]!.text.startsWith(V_MOVE)) {
        moveTo = raw.body[idx]!.text.slice(V_MOVE.length).trim();
        idx += 1;
      }
      const chunks: VChunk[] = [];
      let chunk: VChunk | null = null;
      for (; idx < raw.body.length; idx += 1) {
        const { text, lineNo } = raw.body[idx]!;
        if (text.startsWith('@@')) {
          chunk = { anchor: text.slice(2).trim() || null, eof: false, entries: [] };
          chunks.push(chunk);
        } else if (!text.startsWith(' ') && text.trimEnd() === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, entries: [] };
            chunks.push(chunk);
          } else {
            chunk.eof = true;
          }
          chunk = null;
        } else if (text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+') {
          if (chunk === null) {
            if (chunks.length > 0) throw new Exit2(`error: parse ${lineNo}`);
            chunk = { anchor: null, eof: false, entries: [] };
            chunks.push(chunk);
          }
          if (text === '') chunk.entries.push({ kind: 'ctx', text: '', bs: false });
          else chunk.entries.push({ kind: text[0] === ' ' ? 'ctx' : text[0] === '-' ? 'old' : 'new', text: text.slice(1), bs: false });
        } else if (blank(text)) {
          if (chunk !== null) chunk.entries.push({ kind: 'ctx', text: '', bs: false });
        } else {
          throw new Exit2(`error: parse ${lineNo}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${raw.lineNo}`);
      sections.push({ kind: 'update', path: raw.path, lineNo: raw.lineNo, fileLines: [], moveTo, chunks });
    }
  }
  return sections;
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, s.fileLines.length === 0 ? '' : s.fileLines.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = splitFile(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let found = -1;
        for (const tier of strict ? [0] : [0, 1, 2]) {
          for (let i = cursor; i < model.lines.length; i += 1) {
            if (lineEq(model.lines[i]!, chunk.anchor, tier)) {
              found = i;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', s.path);
        cursor = found + 1;
      }
      const o = oldOf(chunk.entries);
      const n = newOf(chunk.entries);
      if (o.length === 0) {
        const at = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(at, 0, ...n);
        cursor = at + n.length;
      } else {
        const occ = findOccurrences(model.lines, o, strict, cursor, chunk.eof ? model.lines.length : -1);
        if (occ === null) throw new Fail('no-match', s.path);
        const at = occ.positions[0]!;
        const written = writtenLines(chunk.entries, model.lines, at, occ.tier);
        model.lines.splice(at, o.length, ...written);
        cursor = at + written.length;
      }
    }
    const text = joinFile(model);
    if (s.moveTo !== null) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, text);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, text);
    }
  };
}

// ---------------------------------------------------------------------------
// JSON edits (section 9).
// ---------------------------------------------------------------------------

function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = existing(tree);
      const model = splitFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// The run (sections 1, 2 and 10).
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines).map((s) => unifiedEdit(s, strict));
    else if (kind === 'search-replace') edits = parseSearchReplace(lines).map((b) => searchReplaceEdit(b, strict));
    else edits = parseV4A(lines).map((s) => v4aEdit(s, strict));
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // Changed paths, in byte order; a successful move whose endpoints flipped state reports as one R line.
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p)!);
  const byPath = new Map<string, string>();
  const consumed = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    if (tree.original(oldP) !== null && tree.now.get(oldP) === null && tree.original(newP) === null && tree.now.get(newP) !== null) {
      byPath.set(newP, `R ${oldP} -> ${newP}`);
      consumed.add(oldP);
      consumed.add(newP);
    }
  }
  for (const p of changed) {
    if (consumed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    byPath.set(p, `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
  }
  const rows = [...byPath.entries()]
    .sort((x, y) => Buffer.compare(Buffer.from(x[0]), Buffer.from(y[0])))
    .map(([, line]) => line);
  if (!check) {
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
