// main.ts is mend, the CLI SPEC.md specifies (MIT). Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1-6, 9 and 10: the command line, output and exit codes, safe paths,
// format detection, line matching at three tiers (section 5), unified diffs (section 6), JSON
// edits (section 9) and the all-or-nothing write (section 10, including R lines for moves).
// SEARCH/REPLACE (section 7) and V4A (section 8) parsers are stubs in this revision.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file's lines under its own line break. `final` says the text ends with that break. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    parts.pop();
    final = true;
  }
  return { lines: parts, br, final };
}

function serializeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** move target -> original source path (chains collapsed), for R lines. */
  readonly movedFrom = new Map<string, string>();
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
  recordMove(oldP: string, newP: string): void {
    const origin = this.movedFrom.get(oldP) ?? oldP;
    this.movedFrom.delete(oldP);
    if (origin !== newP) this.movedFrom.set(newP, origin);
    else this.movedFrom.delete(newP);
  }
}

type Edit = (tree: Tree) => void;

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

// ---- Section 5: matching lines ----

function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** First tier (0, then 1, then 2; only 0 when strict) at which O occurs, with its positions. */
function findOccurrences(fileLines: string[], O: string[], strict: boolean): { tier: number; positions: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos: number[] = [];
    for (let i = 0; i + O.length <= fileLines.length; i++) {
      let ok = true;
      for (let j = 0; j < O.length; j++) {
        if (normLine(fileLines[i + j]!, t) !== normLine(O[j]!, t)) {
          ok = false;
          break;
        }
      }
      if (ok) pos.push(i);
    }
    if (pos.length > 0) return { tier: t, positions: pos };
  }
  return null;
}

/** O and N of one hunk/chunk/block; nCtx[k] is the O index of N[k] when it is a context line, else -1. */
interface Parts {
  O: string[];
  N: string[];
  nCtx: number[];
}

function buildParts(items: { kind: ' ' | '-' | '+'; text: string }[]): Parts {
  const O: string[] = [];
  const N: string[] = [];
  const nCtx: number[] = [];
  for (const b of items) {
    if (b.kind === ' ') {
      nCtx.push(O.length);
      O.push(b.text);
      N.push(b.text);
    } else if (b.kind === '-') {
      O.push(b.text);
    } else {
      nCtx.push(-1);
      N.push(b.text);
    }
  }
  return { O, N, nCtx };
}

/** Replace O at position i by N: context lines as the file's own lines, tier-2 re-indent otherwise. */
function applyReplace(fileLines: string[], i: number, tier: number, parts: Parts): string[] {
  const rep: string[] = [];
  const F = leadWs(fileLines[i] ?? '');
  const P = leadWs(parts.O[0] ?? '');
  for (let k = 0; k < parts.N.length; k++) {
    const oi = parts.nCtx[k]!;
    if (oi >= 0) {
      rep.push(fileLines[i + oi]!);
      continue;
    }
    let line = parts.N[k]!;
    if (tier === 2 && line.trim() !== '' && line.startsWith(P)) line = F + line.slice(P.length);
    rep.push(line);
  }
  return [...fileLines.slice(0, i), ...rep, ...fileLines.slice(i + parts.O.length)];
}

// ---- Section 9: JSON edits (as the kit's starter) ----

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
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
      const before = exists(tree);
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
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
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

// ---- Section 6: unified diffs ----

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}
interface UniHunk {
  A: number;
  body: BodyLine[];
}
interface UniSection {
  gitOld: string;
  gitNew: string;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  create: boolean;
  del: boolean;
  hunks: UniHunk[];
}

function stripPrefix(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Path from a `--- ` / `+++ ` header line: after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function hunkNoEol(body: BodyLine[]): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    if (body[k]!.kind === ' ' || body[k]!.kind === '+') last = k;
  }
  if (last < 0) return false;
  return body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

function applyHunks(before: string, hunks: UniHunk[], strict: boolean, path: string): string {
  let model = parseFile(before);
  let d = 0;
  for (const h of hunks) {
    const items = h.body.filter((b) => b.kind !== '\\').map((b) => ({ kind: b.kind as ' ' | '-' | '+', text: b.text }));
    const parts = buildParts(items);
    const noeol = hunkNoEol(h.body);
    if (parts.O.length === 0) {
      const oldLen = model.lines.length;
      const at = Math.max(0, Math.min(h.A + d, oldLen));
      model.lines = [...model.lines.slice(0, at), ...parts.N, ...model.lines.slice(at)];
      if (at === oldLen) model.final = !noeol;
      d += parts.N.length;
      continue;
    }
    const occ = findOccurrences(model.lines, parts.O, strict);
    if (occ === null) throw new Fail('no-match', path);
    const target = h.A - 1 + d;
    let best = occ.positions[0]!;
    for (const p of occ.positions) {
      if (Math.abs(p - target) < Math.abs(best - target)) best = p;
    }
    const matchedToEnd = best + parts.O.length === model.lines.length;
    model.lines = applyReplace(model.lines, best, occ.tier, parts);
    if (matchedToEnd) model.final = !noeol;
    d += parts.N.length - parts.O.length;
  }
  return serializeFile(model);
}

function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.pairOld ?? sec.renameFrom ?? sec.gitOld;
    const newP = sec.pairNew ?? sec.renameTo ?? sec.gitNew;
    const oldNull = oldP === '/dev/null';
    const newNull = newP === '/dev/null';
    if (oldNull || sec.create) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const contentLines: string[] = [];
      for (const h of sec.hunks) {
        for (const b of h.body) if (b.kind === '+') contentLines.push(b.text);
      }
      let noeol = false;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
        const b = sec.hunks[hi]!.body;
        for (let k = b.length - 1; k >= 0; k--) {
          if (b[k]!.kind === '+') {
            noeol = b[k + 1] !== undefined && b[k + 1]!.kind === '\\';
            break outer;
          }
        }
      }
      tree.now.set(newP, contentLines.length === 0 ? '' : noeol ? contentLines.join('\n') : contentLines.join('\n') + '\n');
      return;
    }
    if (newNull || sec.del) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const result = applyHunks(before, sec.hunks, strict, oldP);
      tree.now.set(newP, result);
      tree.now.set(oldP, null);
      tree.recordMove(oldP, newP);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, strict, oldP));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let seenHunk = false;
  let hunk: UniHunk | null = null;

  const endHunk = (): void => {
    if (hunk !== null && cur !== null) {
      while (hunk.body.length > 0) {
        const last = hunk.body[hunk.body.length - 1]!;
        if (last.kind === ' ' && last.text === '') hunk.body.pop();
        else break;
      }
      cur.hunks.push(hunk);
    }
    hunk = null;
  };
  const newSection = (gOld: string, gNew: string): void => {
    endHunk();
    cur = { gitOld: gOld, gitNew: gNew, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, create: false, del: false, hunks: [] };
    sections.push(cur);
    seenHunk = false;
  };

  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    // A body line, unless it is a `--- ` line followed by a `+++ ` line: that pair ends the
    // body and starts a new section even though it starts with `-` (section 6).
    if (hunk !== null && !(line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push(line === '' ? { kind: ' ', text: '' } : { kind: line[0] as BodyLine['kind'], text: line.slice(1) });
        i++;
        continue;
      }
    }
    if (hunk !== null) endHunk();
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      newSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || seenHunk) newSection('', '');
      if (cur !== null) {
        if (cur.pairOld === null) cur.pairOld = stripPrefix(headerPath(line));
        if (cur.pairNew === null) cur.pairNew = stripPrefix(headerPath(lines[i + 1]!));
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !seenHunk) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: Number(m[1]), body: [] };
      seenHunk = true;
      i++;
      continue;
    }
    if (cur !== null && !seenHunk) {
      if (line.startsWith('+++ ')) {
        if (cur.pairNew === null) cur.pairNew = stripPrefix(headerPath(line));
      } else if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice(12).trim();
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice(10).trim();
      } else if (line.startsWith('new file mode')) {
        cur.create = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.del = true;
      }
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored
    }
    i++;
  }
  endHunk();
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- Section 7: SEARCH/REPLACE blocks ----

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const occ = findOccurrences(model.lines, oldLines, strict);
    if (occ === null) throw new Fail('no-match', path);
    if (occ.positions.length > 1) throw new Fail('ambiguous', path);
    const parts: Parts = { O: oldLines, N: newLines, nCtx: newLines.map(() => -1) };
    model.lines = applyReplace(model.lines, occ.positions[0]!, occ.tier, parts);
    tree.now.set(path, serializeFile(model));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let prevEnd = 0;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let sep = -1;
    for (let j = i + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        sep = j;
        break;
      }
    }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let end = -1;
    for (let k = sep + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
    }
    if (end < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let path: string | null = null;
    for (let q = searchLine - 1; q >= prevEnd; q--) {
      const t = lines[q]!;
      if (blank(t)) continue;
      if (t.trim().startsWith('```')) continue;
      path = t.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchLine + 1}`);
      path = prevPath;
    }
    edits.push(srEdit(path, lines.slice(searchLine + 1, sep), lines.slice(sep + 1, end), strict));
    prevPath = path;
    prevEnd = end + 1;
    i = end + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 8: V4A patches ----

interface VChunk {
  anchor: string | null;
  body: { kind: ' ' | '-' | '+'; text: string }[];
  eof: boolean;
}

function v4aAddEdit(path: string, contentLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, contentLines.length === 0 ? '' : contentLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const model = parseFile(before);
    const tiers = strict ? [0] : [0, 1, 2];
    let cursor = 0;
    for (const ch of chunks) {
      const parts = buildParts(ch.body);
      if (ch.anchor !== null) {
        let found = -1;
        for (const t of tiers) {
          for (let k = cursor; k < model.lines.length; k++) {
            if (normLine(model.lines[k]!, t) === normLine(ch.anchor!, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new Fail('no-match', path);
        cursor = found + 1;
      }
      if (parts.O.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        model.lines = [...model.lines.slice(0, at), ...parts.N, ...model.lines.slice(at)];
        cursor = at + parts.N.length;
        continue;
      }
      let occ: { tier: number; pos: number } | null = null;
      for (const t of tiers) {
        let found = -1;
        for (let p = cursor; p + parts.O.length <= model.lines.length; p++) {
          if (ch.eof && p + parts.O.length !== model.lines.length) continue;
          let ok = true;
          for (let j = 0; j < parts.O.length; j++) {
            if (normLine(model.lines[p + j]!, t) !== normLine(parts.O[j]!, t)) {
              ok = false;
              break;
            }
          }
          if (ok) {
            found = p;
            break;
          }
        }
        if (found >= 0) {
          occ = { tier: t, pos: found };
          break;
        }
      }
      if (occ === null) throw new Fail('no-match', path);
      model.lines = applyReplace(model.lines, occ.pos, occ.tier, parts);
      cursor = occ.pos + parts.N.length;
    }
    const result = serializeFile(model);
    if (moveTo !== null) {
      tree.now.set(moveTo, result);
      tree.now.set(path, null);
      tree.recordMove(path, moveTo);
    } else {
      tree.now.set(path, result);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    const startLine = i;
    const raw: { text: string; num: number }[] = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      const content: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) content.push(r.text.slice(1));
        else if (r.text === '') content.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aAddEdit(path, content));
    } else if (kind === 'delete') {
      for (const r of raw) {
        if (!blank(r.text)) throw new Exit2(`error: parse ${r.num}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      let moveTo: string | null = null;
      let idx = 0;
      if (idx < raw.length && raw[idx]!.text.startsWith('*** Move to: ')) {
        moveTo = raw[idx]!.text.slice(13).trim();
        idx++;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let started = false;
      for (; idx < raw.length; idx++) {
        const r = raw[idx]!;
        const t = r.text;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false };
          chunks.push(cur);
          started = true;
          continue;
        }
        if (t === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${r.num}`);
          cur.eof = true;
          cur = null;
          continue;
        }
        if (t === '' || t[0] === ' ' || t[0] === '-' || t[0] === '+') {
          if (cur === null) {
            if (started) throw new Exit2(`error: parse ${r.num}`);
            cur = { anchor: null, body: [], eof: false };
            chunks.push(cur);
            started = true;
          }
          cur.body.push(t === '' ? { kind: ' ', text: '' } : { kind: t[0] as ' ' | '-' | '+', text: t.slice(1) });
          continue;
        }
        throw new Exit2(`error: parse ${r.num}`);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${startLine + 1}`);
      edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- Section 1, 2, 10: invocation, output, atomicity ----

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
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.movedFrom);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.movedFrom.clear();
      for (const [k, v] of beforeMoves) tree.movedFrom.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  const suppressedD = new Set<string>();
  for (const [p, origin] of tree.movedFrom) {
    const cur = tree.now.get(p);
    if (cur !== undefined && cur !== null && tree.original(p) === null && tree.get(origin) === null && tree.original(origin) !== null) {
      rows.push({ key: p, text: `R ${origin} -> ${p}` });
      suppressedD.add(origin);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null && suppressedD.has(p)) continue;
    if (now !== null && tree.movedFrom.has(p) && rows.some((r) => r.text === `R ${tree.movedFrom.get(p)} -> ${p}`)) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of tree.now.keys()) {
      const now = tree.now.get(p)!;
      if (tree.original(p) === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
