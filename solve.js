// Site Sprint — a fast, from-scratch reimplementation of makefun-site 1.0.0.
// run(input) returns the same answer as the house reference for every input:
// the same output tree, byte for byte. No imports, no I/O, no clock, no
// randomness: the answer is a function of the input alone.
//
// Speed comes from: a single-pass Markdown renderer (no token objects, lines
// classified once by character code, plain text escaped in bulk); a
// hand-written front-matter scanner that never splits the body; an ASCII fast
// path plus a per-case cache for slugify; a template interpreter that resolves
// paths directly; and sound memoisation of includes whose render is constant
// for the whole case (all names they read, transitively, are site/tags/recent
// and they are rendered with no loop scope in effect).

/** The report file every build writes. */
export const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

/** The most characters a slug keeps before a collision suffix. */
const SLUG_MAX = 64;

const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most
 * SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when
 * nothing is left. `cache` is a per-case Map; NFKD is the identity on pure
 * ASCII and ASCII holds no combining marks, so ASCII skips normalisation.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) >= 128) { ascii = false; break; }
  }
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = 0;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === 0) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(MARK_RE, '');
    for (const ch of plain) {
      const code = ch.codePointAt(0);
      let keep = null;
      if (code >= 65 && code <= 90) keep = String.fromCodePoint(code + 32);
      else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = ch;
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) out += '-';
      gap = false;
      out += keep;
    }
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether the code unit is JavaScript whitespace (\s). */
function isWS(c) {
  return (
    c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || c === 32 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWS(text.charCodeAt(i))) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE = /^([a-z_]+):(?: (.*))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME = /^[a-z0-9-]+$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG = /^[^"[\]]+$/;
const BLANK_RE = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * One front-matter line (1-based `n`), or its refusal reason, or null when the
 * line is blank or a comment. `data` is filled in place.
 */
function fmLine(line, n, data) {
  if (BLANK_RE.test(line) || line.startsWith('#')) return null;
  const m = LINE.exec(line);
  if (!m) return `line ${n} is not "key: value"`;
  const key = m[1];
  const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
  if (!KEYS.includes(key)) return `unknown key "${key}"`;
  if (Object.hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = valueOf(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. The closing "---"
 * line is found first (a source with none is refused before any of its lines
 * is read); the body is taken as one slice after that line.
 */
function parseFrontMatter(text) {
  if (text[0] !== '-' || text[1] !== '-' || text[2] !== '-' || (text.length > 3 && text[3] !== '\n')) return { error: 'no front matter' };
  let closeStart = -1; // start of the closing "---" line
  let closeEnd = -1; // just past the closing line (and its "\n", when there is one)
  let pos = 4; // start of the second line (line index 1)
  while (pos < text.length) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    if (text.slice(pos, end) === '---') {
      closeStart = pos;
      closeEnd = end === text.length ? text.length : end + 1;
      break;
    }
    pos = end + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  pos = 4;
  let lineNo = 1;
  while (pos < closeStart) {
    const end = text.indexOf('\n', pos);
    const err = fmLine(text.slice(pos, end), lineNo + 1, data);
    if (err !== null) return { error: err };
    pos = end + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Whether the rest of `line` from `j` is only spaces and tabs. */
function onlySpaceTab(line, j) {
  for (; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `c` is a fence language character (A-Z, a-z, 0-9, _, +, -). */
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Whether `line` closes a fence: three backticks, then spaces or tabs only. */
function isFenceClose(line) {
  return line.charCodeAt(0) === 96 && line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96 && onlySpaceTab(line, 3);
}

/** Block kinds, as classify() reports them. */
const BK_BLANK = 0;
const BK_FENCE = 1;
const BK_HEADING = 2;
const BK_HR = 3;
const BK_QUOTE = 4;
const BK_LIST = 5;
const BK_PARA = 6;

/**
 * One scratch record for classify()'s payload (lang / depth+text /
 * ordered+start+text). Reused across calls: read its fields synchronously
 * after each call, before classifying the next line.
 */
const CLS = { kind: BK_PARA, lang: '', depth: 0, text: '', ordered: false, start: 1 };

/**
 * A line's block kind, in one scan of its leading characters: blank, fence
 * open (CLS.lang), heading (CLS.depth, CLS.text), thematic break, blockquote,
 * list item (CLS.ordered, CLS.start, CLS.text) or paragraph text.
 */
function classify(line) {
  const n = line.length;
  const c0 = line.charCodeAt(0);
  if (c0 === 32 || c0 === 9) {
    for (let j = 1; j < n; j++) {
      const c = line.charCodeAt(j);
      if (c !== 32 && c !== 9) return BK_PARA;
    }
    return BK_BLANK;
  }
  if (Number.isNaN(c0)) return BK_BLANK; // an empty line
  if (c0 === 35) { // '#'
    let depth = 1;
    while (depth < 6 && line.charCodeAt(depth) === 35) depth++;
    let j = depth;
    if (line.charCodeAt(j) !== 32 && line.charCodeAt(j) !== 9) return BK_PARA;
    while (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9) j++;
    let end = n;
    while (end > j && (line.charCodeAt(end - 1) === 32 || line.charCodeAt(end - 1) === 9)) end--;
    if (end === j) return BK_PARA;
    CLS.depth = depth;
    CLS.text = line.slice(j, end);
    return BK_HEADING;
  }
  if (c0 === 96) { // '`'
    if (line.charCodeAt(1) === 96 && line.charCodeAt(2) === 96) {
      let j = 3;
      while (j < n && isLangChar(line.charCodeAt(j))) j++;
      if (onlySpaceTab(line, j)) {
        CLS.lang = line.slice(3, j);
        return BK_FENCE;
      }
    }
    return BK_PARA;
  }
  if (c0 === 45) { // '-'
    if (line.charCodeAt(1) === 45 && line.charCodeAt(2) === 45 && onlySpaceTab(line, 3)) return BK_HR;
    if (line.charCodeAt(1) === 32) {
      CLS.ordered = false;
      CLS.start = 1;
      CLS.text = line.slice(2);
      return BK_LIST;
    }
    return BK_PARA;
  }
  if (c0 === 42) { // '*'
    if (line.charCodeAt(1) === 42 && line.charCodeAt(2) === 42 && onlySpaceTab(line, 3)) return BK_HR;
    if (line.charCodeAt(1) === 32) {
      CLS.ordered = false;
      CLS.start = 1;
      CLS.text = line.slice(2);
      return BK_LIST;
    }
    return BK_PARA;
  }
  if (c0 === 62) return BK_QUOTE; // '>'
  if (c0 >= 48 && c0 <= 57) { // a digit: maybe an ordered list
    let j = 1;
    while (j < 9 && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
    if (line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
      CLS.ordered = true;
      CLS.start = Number(line.slice(0, j));
      CLS.text = line.slice(j + 2);
      return BK_LIST;
    }
  }
  return BK_PARA;
}

/** Whether `line` continues a list item: two or more spaces, then a non-space. */
function isContinued(line) {
  let j = 0;
  while (line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isWS(line.charCodeAt(j));
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const n = s.length;
  const wlen = what.length;
  for (let j = from; j <= n - wlen; j++) {
    if (s[j] === '\\' && j + 1 < n && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const WS_RE = /\s/;
const SPECIAL_RE = /[\\`*[]/;

/** The first index from `from` holding one of \ ` * [, or -1. */
function nextSpecial(s, from) {
  let best = s.length;
  let j = s.indexOf('\\', from);
  if (j !== -1 && j < best) best = j;
  j = s.indexOf('`', from);
  if (j !== -1 && j < best) best = j;
  j = s.indexOf('*', from);
  if (j !== -1 && j < best) best = j;
  j = s.indexOf('[', from);
  if (j !== -1 && j < best) best = j;
  return best === s.length ? -1 : best;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain text
 * between constructs is escaped in bulk; the scan jumps from one special
 * character to the next instead of walking every character.
 */
function inline(s, env) {
  // Fast path: no escapable, code-span, emphasis or link opener at all —
  // the whole string is plain text, escaped in bulk.
  if (!SPECIAL_RE.test(s)) return escapeHtml(s);
  let out = '';
  let p = 0; // start of the pending plain-text run
  let i = nextSpecial(s, 0);
  while (i !== -1) {
    const c = s[i];
    if (c === '\\') { // backslash
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        if (i > p) out += escapeHtml(s.slice(p, i));
        out += escapeHtml(s[i + 1]);
        p = i + 2;
        i = nextSpecial(s, p);
        continue;
      }
      i = nextSpecial(s, i + 1);
      continue;
    }
    if (c === '`') { // backtick
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > p) out += escapeHtml(s.slice(p, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        p = j + 1;
        i = nextSpecial(s, p);
        continue;
      }
      i = nextSpecial(s, i + 1);
      continue;
    }
    if (c === '*') { // strong or emphasis
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > p) out += escapeHtml(s.slice(p, i));
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          p = j + 2;
          i = nextSpecial(s, p);
          continue;
        }
        i = nextSpecial(s, i + 2);
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > p) out += escapeHtml(s.slice(p, i));
        out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
        p = j + 1;
        i = nextSpecial(s, p);
        continue;
      }
      i = nextSpecial(s, i + 1);
      continue;
    }
    // '[': a link, or itself when the target is missing or holds whitespace
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_RE.test(target)) {
      if (i > p) out += escapeHtml(s.slice(p, i));
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
      p = m + 1;
      i = nextSpecial(s, p);
      continue;
    }
    i = nextSpecial(s, i + 1);
  }
  if (p < s.length) out += escapeHtml(s.slice(p));
  return out;
}

/** `parts` joined by "\n" (a single part as itself, no array join). */
const joinNL = (parts) => (parts.length === 1 ? parts[0] : parts.join('\n'));

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level,
 * id and its inline HTML), its excerpt (the first paragraph's inline HTML,
 * or "") and its word count (runs of non-whitespace; a word never spans a
 * line, so the lines' counts add up to the body's). `env.link(target)`
 * resolves a link's href; `slugCache` is the case's slug cache. The lines are
 * walked lazily off the string, never split into an array.
 */
function renderMarkdown(src, env, slugCache) {
  let html = '';
  const toc = [];
  let excerpt = null;
  const ids = new Set();
  let words = 0;
  let pos = 0;
  const len = src.length;
  let line = '';
  let hasLine = false;
  let kind = BK_PARA; // the current line's kind, classified as it is loaded
  const advance = () => {
    if (pos >= len) {
      hasLine = false;
      line = '';
      kind = BK_PARA;
      return;
    }
    const end = src.indexOf('\n', pos);
    if (end === -1) {
      line = src.slice(pos);
      pos = len;
    } else {
      line = src.slice(pos, end);
      pos = end + 1;
    }
    hasLine = true;
    kind = classify(line);
    let inWord = false;
    for (let j = 0; j < line.length; j++) {
      if (isWS(line.charCodeAt(j))) inWord = false;
      else if (!inWord) {
        inWord = true;
        words++;
      }
    }
  };
  advance();
  while (hasLine) {
    if (kind === BK_BLANK) {
      advance();
      continue;
    }
    if (kind === BK_FENCE) {
      const lang = CLS.lang;
      advance();
      let code = `<pre><code${lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`}>`;
      while (hasLine && !isFenceClose(line)) {
        code += `${escapeHtml(line)}\n`;
        advance();
      }
      advance();
      html += `${code}</code></pre>\n`;
      continue;
    }
    if (kind === BK_HEADING) {
      const depth = CLS.depth;
      const text = CLS.text;
      const id = uniqueSlug(slugify(text, slugCache), ids);
      const h = inline(text, env);
      html += `<h${depth} id="${id}">${h}</h${depth}>\n`;
      if (depth === 2 || depth === 3) toc.push({ level: depth, id, html: h });
      advance();
      continue;
    }
    if (kind === BK_HR) {
      html += '<hr>\n';
      advance();
      continue;
    }
    if (kind === BK_QUOTE) { // '>'
      const body = [];
      while (hasLine && kind === BK_QUOTE) {
        body.push(trimLine(line.startsWith('> ') ? line.slice(2) : line.slice(1)));
        advance();
      }
      const kept = body.filter((l) => l !== '');
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(joinNL(kept), env)}</p>\n</blockquote>\n`;
      continue;
    }
    if (kind === BK_LIST) {
      const ordered = CLS.ordered;
      const start = CLS.start;
      const items = [[trimLine(CLS.text)]];
      advance();
      while (hasLine) {
        if (kind === BK_LIST && CLS.ordered === ordered) {
          items.push([trimLine(CLS.text)]);
          advance();
        } else if (isContinued(line)) {
          items[items.length - 1].push(trimLine(line));
          advance();
        } else break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += ordered && start !== 1 ? `<ol start="${start}">\n` : `<${tag}>\n`;
      for (const item of items) html += `<li>${inline(joinNL(item), env)}</li>\n`;
      html += `</${tag}>\n`;
      continue;
    }
    const parts = [trimLine(line)];
    advance();
    while (hasLine) {
      if (kind === BK_BLANK || kind === BK_FENCE || kind === BK_HEADING || kind === BK_HR) break;
      parts.push(trimLine(line));
      advance();
    }
    const h = inline(joinNL(parts), env);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Whether `s` is only spaces and tabs. */
function isSpaceTabOnly(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = isSpaceTabOnly(src.slice(lineStart, open)) && isSpaceTabOnly(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * Per-template facts for the memo: the names a template reads directly (not
 * through includes), with for-loop bindings honoured, and the templates it
 * includes. Free names and include heights are then closed over includes by
 * fixpoint, so cycles stay sound (a cycle pushes the height to the cap and
 * the template is never memoised).
 */
function analyzeTemplates(templates) {
  const directFree = new Map(); // name -> Set of first names read directly
  const includes = new Map(); // name -> [included names]
  const walk = (nodes, bound, free, inc) => {
    for (const nd of nodes) {
      if (nd.kind === 'var' || nd.kind === 'raw') {
        if (!bound.has(nd.path[0])) free.add(nd.path[0]);
      } else if (nd.kind === 'if') {
        if (!bound.has(nd.path[0])) free.add(nd.path[0]);
        walk(nd.then, bound, free, inc);
        if (nd.else !== null) walk(nd.else, bound, free, inc);
      } else if (nd.kind === 'for') {
        if (!bound.has(nd.path[0])) free.add(nd.path[0]);
        const b2 = new Set(bound);
        b2.add(nd.name);
        b2.add('loop');
        walk(nd.body, b2, free, inc);
      } else if (nd.kind === 'include') inc.push(nd.name);
    }
  };
  for (const [name, nodes] of templates) {
    const free = new Set();
    const inc = [];
    walk(nodes, new Set(), free, inc);
    directFree.set(name, free);
    includes.set(name, inc);
  }
  const free = new Map();
  for (const name of templates.keys()) free.set(name, new Set(directFree.get(name)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, inc] of includes) {
      const f = free.get(name);
      for (const u of inc) {
        const uf = free.get(u);
        if (uf === undefined) continue;
        for (const x of uf) {
          if (!f.has(x)) {
            f.add(x);
            changed = true;
          }
        }
      }
    }
  }
  const height = new Map();
  for (const name of templates.keys()) height.set(name, 0);
  changed = true;
  while (changed) {
    changed = false;
    for (const [name, inc] of includes) {
      let h = 0;
      for (const u of inc) {
        if (!height.has(u)) continue;
        const uh = height.get(u) + 1;
        if (uh > h) h = uh;
      }
      if (h > 99) h = 99;
      if (h !== height.get(name)) {
        height.set(name, h);
        changed = true;
      }
    }
  }
  const memoOk = new Set();
  for (const [name, f] of free) {
    let ok = true;
    for (const x of f) {
      if (x !== 'site' && x !== 'tags' && x !== 'recent') { ok = false; break; }
    }
    if (ok) memoOk.add(name);
  }
  return { memoOk, memoH: height };
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }). `ctx` holds the parsed
 * templates, the HTML escape and the include depth, plus the per-case memo
 * for includes whose render is constant for the whole case.
 */
function renderNodes(nodes, scope, ctx, depth) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.kind) {
      case 'text':
        out += nd.text;
        break;
      case 'var':
        out += escapeHtml(textOf(lookup(scope, nd.path)));
        break;
      case 'raw':
        out += textOf(lookup(scope, nd.path));
        break;
      case 'if': {
        const v = truthy(lookup(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) out += renderNodes(branch, scope, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(scope, nd.path);
        if (!Array.isArray(xs)) break;
        const len = xs.length;
        if (!nd._active) {
          // Fast path: one scratch scope per for-node, mutated per element.
          // Rendering is synchronous, so no iteration can observe another's
          // values — except when an include cycle re-enters this same node,
          // which the _active guard sends to fresh objects instead.
          nd._active = true;
          let vars = nd._vars;
          if (vars === undefined) {
            nd._loop = { index: 0, first: false, last: false, length: 0 };
            vars = { loop: nd._loop };
            nd._vars = vars;
            nd._scope = { vars, parent: null };
          }
          const loop = nd._loop;
          const sc = nd._scope;
          sc.parent = scope;
          loop.length = len;
          for (let k = 0; k < len; k++) {
            vars[nd.name] = xs[k];
            loop.index = k + 1;
            loop.first = k === 0;
            loop.last = k === len - 1;
            out += renderNodes(nd.body, sc, ctx, depth);
          }
          nd._active = false;
        } else {
          for (let k = 0; k < len; k++) {
            const vars = { [nd.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
            out += renderNodes(nd.body, { vars, parent: scope }, ctx, depth);
          }
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(nd.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        // Sound memo: only with no loop scope in effect, only when every
        // name the template reads (transitively) is site/tags/recent, and
        // only when no include inside it can hit the depth cap at either
        // the depth it was rendered at or the depth it is reused at.
        if (scope.parent === null && ctx.memoOk.has(nd.name) && depth + ctx.memoH.get(nd.name) <= INCLUDE_DEPTH) {
          let hit = ctx.memo.get(nd.name);
          if (hit === undefined) {
            hit = renderNodes(t, scope, ctx, depth + 1);
            ctx.memo.set(nd.name, hit);
          }
          out += hit;
        } else {
          out += renderNodes(t, scope, ctx, depth + 1);
        }
        break;
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel, cache) {
  const key = `${dir}\n${rel}`;
  if (cache.has(key)) return cache.get(key);
  const parts = dir === '' ? [] : dir.split('/');
  let ok = true;
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) {
        ok = false;
        break;
      }
      parts.pop();
    } else parts.push(seg);
  }
  const out = ok ? parts.join('/') : null;
  cache.set(key, out);
  return out;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(b, s) {
  if (s.words === undefined) s.words = wordsOf(s.body);
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(b, s) {
  const card = s.post ? b.cards.get(s) : cardOf(b, s);
  return {
    ...card,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A source's tags, each slug once, in its own order. */
function ownTags(b, s) {
  const seen = new Set();
  const out = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugify(name, b.slugCache);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(name);
    }
  }
  return out;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const info = analyzeTemplates(templates);
  const ctx = { templates, memo: new Map(), memoOk: info.memoOk, memoH: info.memoH };

  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
    slugCache,
    resolveCache: new Map(),
  };

  // 1. The sources, in code-unit order of their paths, line ends made "\n".
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel, b.resolveCache);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(b, p)) {
      const slug = slugify(name, slugCache);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of b.sources) {
    if (!s.post) s.tagRefs = ownTags(b, s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  b.cards = new Map(b.posts.map((p) => [p, cardOf(b, p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    return nodes === undefined ? null : renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0);
  };
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(b, s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pageCount = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return b.output;
}
