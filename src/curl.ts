import { isCall, runCall } from "./fns";
import type { LinkItem, VariableItem } from "./types";

export interface Token {
  raw: string;
  value: string;
  quoted: boolean;
}

const VALUE_FLAGS = new Set([
  "-X", "--request", "-H", "--header", "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "--json", "-u", "--user", "-A", "--user-agent", "-b", "--cookie", "-c", "--cookie-jar", "-e", "--referer",
  "-o", "--output", "-F", "--form", "--form-string", "-T", "--upload-file", "--url", "-w", "--write-out",
  "-m", "--max-time", "--connect-timeout", "-x", "--proxy", "-K", "--config", "--retry", "-D", "--dump-header",
  "-E", "--cert", "--cacert", "--key", "--resolve", "--interface", "--limit-rate", "--max-redirs", "-r", "--range",
  "--retry-delay", "--retry-max-time", "--proxy-user", "-U", "--unix-socket", "--abstract-unix-socket",
  "--aws-sigv4", "--oauth2-bearer", "--tls-max", "--ciphers", "--local-port", "--dns-servers",
]);

const DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json"]);

/* 分词 */

export function tokenize(source: string): Token[] | null {
  const tokens: Token[] = [];
  let raw = "";
  let value = "";
  let quoted = false;
  let started = false;
  let index = 0;
  const push = () => {
    if (started) {
      tokens.push({ raw, value, quoted });
    }
    raw = "";
    value = "";
    quoted = false;
    started = false;
  };
  while (index < source.length) {
    const ch = source[index];
    if (ch === "'") {
      const end = source.indexOf("'", index + 1);
      if (end === -1) {
        return null;
      }
      raw += source.slice(index, end + 1);
      value += source.slice(index + 1, end);
      quoted = true;
      started = true;
      index = end + 1;
      continue;
    }
    if (ch === '"') {
      let cursor = index + 1;
      let inner = "";
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor];
        if (current === "\\" && cursor + 1 < source.length) {
          const next = source[cursor + 1];
          inner += next === "\n" ? "" : next;
          cursor += 2;
          continue;
        }
        if (current === '"') {
          closed = true;
          break;
        }
        inner += current;
        cursor += 1;
      }
      if (!closed) {
        return null;
      }
      raw += source.slice(index, cursor + 1);
      value += inner;
      quoted = true;
      started = true;
      index = cursor + 1;
      continue;
    }
    if (ch === "\\") {
      const next = source[index + 1];
      if (next === "\n" || next === undefined) {
        index += 2;
        continue;
      }
      if (next === "\r" && source[index + 2] === "\n") {
        index += 3;
        continue;
      }
      raw += ch + next;
      value += next;
      started = true;
      index += 2;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      index += 1;
      continue;
    }
    raw += ch;
    value += ch;
    started = true;
    index += 1;
  }
  push();
  return tokens;
}

function splitLeadingComments(source: string): { comments: string[]; body: string } {
  const lines = source.split("\n");
  const comments: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index].trim();
    if (line === "" || line.startsWith("#")) {
      if (line) {
        comments.push(lines[index].trimEnd());
      }
      index += 1;
      continue;
    }
    break;
  }
  return { comments, body: lines.slice(index).join("\n") };
}

/* 格式化 */

export function formatCurl(source: string): string | null {
  const { comments, body } = splitLeadingComments(source);
  const tokens = tokenize(body);
  if (!tokens || tokens.length === 0) {
    return null;
  }
  if (tokens.some((token) => !token.quoted && /^(\||&&|;|>|<|\|\|)$/.test(token.value))) {
    return null;
  }
  const first = tokens[0];
  if (first.value !== "curl") {
    return null;
  }
  const lines: string[] = [];
  let current = "curl";
  let index = 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.value.startsWith("-") && !token.quoted) {
      if (current === "curl") {
        current = `curl ${token.raw}`;
      } else {
        lines.push(current);
        current = token.raw;
      }
      const flag = token.value.split("=")[0];
      if (VALUE_FLAGS.has(flag) && !token.value.includes("=") && index + 1 < tokens.length) {
        const value = tokens[index + 1];
        current += ` ${DATA_FLAGS.has(flag) ? prettyData(value) : value.raw}`;
        index += 2;
        continue;
      }
      index += 1;
      continue;
    }
    current += ` ${token.raw}`;
    index += 1;
  }
  lines.push(current);
  const text = lines.join(" \\\n  ");
  return [...comments, text].join("\n");
}

function prettyData(token: Token): string {
  const trimmed = token.value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return token.raw;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const pretty = JSON.stringify(parsed, null, 2);
    if (pretty.includes("'")) {
      return token.raw;
    }
    return `'${pretty}'`;
  } catch {
    return token.raw;
  }
}

/* 结构 */

export interface CurlStructure {
  method: string;
  url: string;
  query: Array<[string, string]>;
  headers: Array<[string, string]>;
  body: string;
  bodyJson: string | null;
}

export function parseStructure(source: string): CurlStructure | { error: string } {
  const { body } = splitLeadingComments(source);
  const tokens = tokenize(body);
  if (!tokens) {
    return { error: "引号没有闭合" };
  }
  const start = tokens.findIndex((token) => token.value === "curl");
  if (start === -1) {
    return { error: "不是 curl 命令" };
  }
  let method = "";
  let url = "";
  const headers: Array<[string, string]> = [];
  const data: string[] = [];
  let index = start + 1;
  while (index < tokens.length) {
    const token = tokens[index];
    const value = token.value;
    if (!token.quoted && /^(\||&&|;|\|\|)$/.test(value)) {
      break;
    }
    if (value.startsWith("-") && !token.quoted) {
      let flag = value;
      let inline: string | null = null;
      const eq = value.indexOf("=");
      if (value.startsWith("--") && eq > 0) {
        flag = value.slice(0, eq);
        inline = value.slice(eq + 1);
      }
      const takesValue = VALUE_FLAGS.has(flag);
      const next = inline ?? (takesValue && index + 1 < tokens.length ? tokens[index + 1].value : "");
      if (flag === "-X" || flag === "--request") {
        method = next.toUpperCase();
      } else if (flag === "-H" || flag === "--header") {
        const colon = next.indexOf(":");
        headers.push(colon === -1 ? [next, ""] : [next.slice(0, colon).trim(), next.slice(colon + 1).trim()]);
      } else if (DATA_FLAGS.has(flag)) {
        data.push(next);
      } else if (flag === "--url") {
        url = next;
      } else if (flag === "-I" || flag === "--head") {
        method = method || "HEAD";
      } else if (flag === "-G" || flag === "--get") {
        method = "GET";
      }
      index += takesValue && inline === null ? 2 : 1;
      continue;
    }
    if (!url) {
      url = value;
    }
    index += 1;
  }
  if (!url) {
    return { error: "没有找到请求地址" };
  }
  if (!method) {
    method = data.length > 0 ? "POST" : "GET";
  }
  const query: Array<[string, string]> = [];
  const mark = url.indexOf("?");
  if (mark !== -1) {
    for (const pair of url.slice(mark + 1).split("&")) {
      if (!pair) {
        continue;
      }
      const eq = pair.indexOf("=");
      const key = eq === -1 ? pair : pair.slice(0, eq);
      const val = eq === -1 ? "" : pair.slice(eq + 1);
      query.push([safeDecode(key), safeDecode(val)]);
    }
  }
  const bodyText = data.join("&");
  let bodyJson: string | null = null;
  const trimmed = bodyText.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      bodyJson = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      bodyJson = null;
    }
  }
  return { method, url, query, headers, body: bodyText, bodyJson };
}

export function pathOf(url: string): string {
  const scheme = url.indexOf("://");
  const rest = scheme === -1 ? url : url.slice(scheme + 3);
  const slash = rest.indexOf("/");
  const path = slash === -1 ? "/" : rest.slice(slash);
  const cut = path.split(/[?#]/, 1)[0] ?? "/";
  return cut || "/";
}

function samePath(left: string, right: string): boolean {
  const trim = (path: string) => (path.length > 1 ? path.replace(/\/+$/, "") : path);
  return trim(left) === trim(right);
}

/** 只改请求地址里的路径，主机和查询参数保留。对不上的 curl 原样返回。 */
export function replaceCurlPath(source: string, fromPath: string, toPath: string): string {
  const parsed = parseStructure(source);
  if ("error" in parsed) {
    return source;
  }
  const path = pathOf(parsed.url);
  if (!samePath(path, fromPath)) {
    return source;
  }
  const mark = parsed.url.search(/[?#]/);
  const head = mark === -1 ? parsed.url : parsed.url.slice(0, mark);
  const tail = mark === -1 ? "" : parsed.url.slice(mark);
  if (!head.endsWith(path)) {
    return source;
  }
  const nextUrl = head.slice(0, head.length - path.length) + toPath + tail;
  const index = source.indexOf(parsed.url);
  if (index === -1) {
    return source;
  }
  return source.slice(0, index) + nextUrl + source.slice(index + parsed.url.length);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/* 变量 */

export const VARIABLE_PATTERN = /\{\{\s*(\$[A-Za-z][A-Za-z0-9_]*(?::[^{}]*)?|[A-Za-z0-9_.-]+)\s*\}\}/g;

export interface VariableToken {
  start: number;
  end: number;
  text: string;
  name: string;
}

export function variableTokens(content: string): VariableToken[] {
  const pattern = new RegExp(VARIABLE_PATTERN.source, "g");
  const tokens: VariableToken[] = [];
  for (const match of content.matchAll(pattern)) {
    const start = match.index ?? 0;
    const text = match[0];
    tokens.push({ start, end: start + text.length, text, name: match[1] ?? "" });
  }
  return tokens;
}

export function substitute(content: string, variables: VariableItem[], now = new Date()): string {
  const map = new Map(variables.map((item) => [item.name, item.value]));
  const pattern = new RegExp(VARIABLE_PATTERN.source, "g");
  return content.replace(pattern, (whole, name: string) => {
    const direct = runCall(name, now);
    if (direct !== null) {
      return direct;
    }
    if (!map.has(name)) {
      return whole;
    }
    const value = map.get(name) ?? "";
    return runCall(value.trim(), now) ?? value;
  });
}

/** 把系统里相同文本换成 {{name}}。已经在 {{变量}} 里的不再改。 */
/** 选区落在已有 {{变量}} 内部时不能再包一层。正好选中整个变量则不算嵌套。 */
export function variableOverlap(content: string, start: number, end: number): "none" | "inside" | "exact" {
  if (end <= start) {
    return "none";
  }
  let exact = false;
  for (const token of variableTokens(content)) {
    if (end <= token.start || start >= token.end) {
      continue;
    }
    if (start === token.start && end === token.end) {
      exact = true;
      continue;
    }
    return "inside";
  }
  return exact ? "exact" : "none";
}

/** 光标或选区在某个 {{变量}} 内部时，返回这整段。点在变量上、光标落在边界时用 hitName 接住。 */
export function enclosingVariable(
  content: string,
  start: number,
  end: number,
  hitName = "",
): { start: number; end: number; text: string; name: string } | null {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const caret = from === to;
  let nearest: { start: number; end: number; text: string; name: string } | null = null;
  let nearestDist = Number.POSITIVE_INFINITY;
  for (const token of variableTokens(content)) {
    const tokenStart = token.start;
    const tokenEnd = token.end;
    if (caret && from > tokenStart && from < tokenEnd) {
      return token;
    }
    if (!caret && from >= tokenStart && to <= tokenEnd) {
      return token;
    }
    if (!caret || !hitName || token.name !== hitName) {
      continue;
    }
    const dist = from < tokenStart ? tokenStart - from : from > tokenEnd ? from - tokenEnd : 0;
    if (dist < nearestDist) {
      nearest = token;
      nearestDist = dist;
    }
  }
  if (caret && hitName && nearest && nearestDist <= 1) {
    return nearest;
  }
  return null;
}

export function replaceTextWithVariable(content: string, selected: string, name: string): { content: string; count: number } {
  if (!selected || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return { content, count: 0 };
  }
  const token = `{{${name}}}`;
  let count = 0;
  let next = "";
  let index = 0;
  while (index < content.length) {
    if (content.startsWith("{{", index)) {
      const end = content.indexOf("}}", index + 2);
      if (end !== -1) {
        next += content.slice(index, end + 2);
        index = end + 2;
        continue;
      }
    }
    if (content.startsWith(selected, index)) {
      next += token;
      index += selected.length;
      count += 1;
      continue;
    }
    next += content[index];
    index += 1;
  }
  return { content: next, count };
}

export function renameVariable(content: string, fromName: string, toName: string): { content: string; count: number } {
  if (!fromName || !/^[A-Za-z0-9_.-]+$/.test(toName) || fromName.toLowerCase() === toName.toLowerCase()) {
    return { content, count: 0 };
  }
  let count = 0;
  const next = content.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (whole, name: string) => {
    if (name.toLowerCase() !== fromName.toLowerCase()) {
      return whole;
    }
    count += 1;
    return `{{${toName}}}`;
  });
  return { content: next, count };
}

export function variableNames(content: string): string[] {
  return variableTokens(content).map((token) => token.name);
}

/* 主机 */

export const HOST_PATTERN = /https?:\/\/[^/\s'"]+/g;

export function hostOf(content: string): string {
  HOST_PATTERN.lastIndex = 0;
  const match = HOST_PATTERN.exec(content);
  return match ? match[0] : "";
}

export function hostsIn(contents: string[]): string[] {
  const seen = new Set<string>();
  for (const content of contents) {
    for (const match of content.matchAll(HOST_PATTERN)) {
      seen.add(match[0]);
    }
  }
  return [...seen];
}

export function normalizeHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return "";
  }
  return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
}

export function swapHost(content: string, host: string): string {
  const target = normalizeHost(host);
  return content.replace(HOST_PATTERN, target);
}

export function envFor(content: string, links: LinkItem[]): LinkItem | undefined {
  const host = hostOf(content);
  if (!host) {
    return undefined;
  }
  return links.find((link) => link.kind === "env" && link.host && normalizeHost(link.host) === host);
}

/* 标题与时间 */

export function caseTitle(content: string, index: number): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("#")) {
      continue;
    }
    const title = trimmed.replace(/^#+\s*/, "").trim();
    if (title) {
      return title;
    }
  }
  return `用例 ${index + 1}`;
}

export function hasTitle(content: string): boolean {
  return content.split("\n").some((line) => /^\s*#+\s*\S/.test(line));
}

export function ago(timestamp: number): string {
  if (!timestamp) {
    return "";
  }
  const diff = Date.now() - timestamp;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) {
    return "刚刚";
  }
  if (diff < hour) {
    return `${Math.floor(diff / minute)} 分钟前`;
  }
  if (diff < day) {
    return `${Math.floor(diff / hour)} 小时前`;
  }
  if (diff < 30 * day) {
    return `${Math.floor(diff / day)} 天前`;
  }
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function fullTime(timestamp: number): string {
  if (!timestamp) {
    return "";
  }
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/* 一条用例里的多条 curl */

export interface CurlCommand {
  line: number;
  text: string;
}

export function curlCommands(source: string): CurlCommand[] {
  const lines = source.split("\n");
  const commands: CurlCommand[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!/^\s*curl(\s|$)/i.test(lines[index])) {
      index += 1;
      continue;
    }
    const start = index;
    const chunk: string[] = [];
    let quote: "'" | '"' | null = null;
    let continued = false;
    while (index < lines.length) {
      const line = lines[index];
      chunk.push(line);
      const state = scanCurlLine(line, quote);
      quote = state.quote;
      continued = state.continued;
      index += 1;
      if (!quote && !continued) {
        break;
      }
    }
    commands.push({ line: start, text: chunk.join("\n") });
  }
  return commands;
}

function scanCurlLine(line: string, quote: "'" | '"' | null): { quote: "'" | '"' | null; continued: boolean } {
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (quote) {
      if (quote === '"' && ch === "\\") {
        index += 1;
        continue;
      }
      if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "\\" && index === line.length - 1) {
      return { quote, continued: true };
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }
  return { quote, continued: false };
}

/* 高亮 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markVariables(escaped: string, defined: Set<string>): string {
  return escaped.replace(VARIABLE_PATTERN, (whole, name: string) => {
    const cls = defined.has(name) || isCall(name) ? "sh-var" : "sh-var-missing";
    return `<span class="${cls}" data-name="${name}">${whole}</span>`;
  });
}

export function highlightShell(
  source: string,
  defined: Set<string>,
  selection?: { start: number; end: number } | null,
): string {
  if (!source) {
    return '<span class="sh-placeholder">这一条用例，通常是一条完整的 curl</span>\n';
  }
  const emit = (text: string) => markVariables(escapeHtml(text), defined);
  const selStart = selection && selection.end > selection.start ? selection.start : -1;
  const selEnd = selection && selection.end > selection.start ? selection.end : -1;
  const emitRange = (start: number, end: number): string => {
    if (end <= start) {
      return "";
    }
    if (selStart < 0 || end <= selStart || start >= selEnd) {
      return emit(source.slice(start, end));
    }
    const left = Math.max(start, selStart);
    const right = Math.min(end, selEnd);
    let html = "";
    if (left > start) {
      html += emit(source.slice(start, left));
    }
    html += `<span class="shell-selection">${emit(source.slice(left, right))}</span>`;
    if (right < end) {
      html += emit(source.slice(right, end));
    }
    return html;
  };
  let html = "";
  let index = 0;
  let lineStart = true;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "'" || ch === '"') {
      const end = endOfQuote(source, index);
      html += `<span class="sh-str">${emitRange(index, end)}</span>`;
      index = end;
      continue;
    }
    if (ch === "#") {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      html += `<span class="sh-comment">${emitRange(index, end)}</span>`;
      index = end;
      continue;
    }
    if (!/\s/.test(ch)) {
      const start = index;
      while (index < source.length && !/\s/.test(source[index]) && source[index] !== "'" && source[index] !== '"') {
        index += 1;
      }
      const word = source.slice(start, index);
      const cls = word === "curl" || word === "ab" ? "sh-cmd" : word.startsWith("-") ? "sh-flag" : "";
      if (lineStart && word.toLowerCase() === "curl") {
        html += '<span class="curl-mark">\u200b</span>';
      }
      lineStart = false;
      const body = emitRange(start, index);
      html += cls ? `<span class="${cls}">${body}</span>` : body;
      continue;
    }
    if (ch === "\n") {
      lineStart = true;
    }
    html += emitRange(index, index + 1);
    index += 1;
  }
  return html.endsWith("\n") ? html : `${html}\n`;
}

function endOfQuote(source: string, start: number): number {
  const quote = source[start];
  let index = start + 1;
  while (index < source.length) {
    if (quote === '"' && source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === quote) {
      return index + 1;
    }
    index += 1;
  }
  return source.length;
}

/* 模糊匹配 */

export function fuzzyScore(text: string, pattern: string): number {
  const haystack = text.toLowerCase();
  const needle = pattern.toLowerCase();
  if (!needle) {
    return 1;
  }
  const direct = haystack.indexOf(needle);
  if (direct !== -1) {
    return 1000 - direct;
  }
  let score = 0;
  let cursor = 0;
  let streak = 0;
  for (const ch of needle) {
    const found = haystack.indexOf(ch, cursor);
    if (found === -1) {
      return 0;
    }
    streak = found === cursor ? streak + 1 : 0;
    score += 1 + streak * 2;
    cursor = found + 1;
  }
  return score;
}

/* 搜索语法 */

export interface Query {
  method: string;
  path: string;
  sys: string;
  title: string;
  text: string;
  empty: boolean;
}

export function parseQuery(raw: string): Query {
  const query: Query = { method: "", path: "", sys: "", title: "", text: "", empty: true };
  const free: string[] = [];
  for (const part of raw.trim().split(/\s+/).filter(Boolean)) {
    const lower = part.toLowerCase();
    if (lower.startsWith("path:")) {
      query.path = lower.slice(5);
    } else if (lower.startsWith("sys:")) {
      query.sys = lower.slice(4);
    } else if (lower.startsWith("#")) {
      query.title = lower.slice(1);
    } else if (/^(get|post|put|patch|delete|head|options|curl):$/.test(lower)) {
      query.method = lower.slice(0, -1);
    } else {
      free.push(lower);
    }
  }
  query.text = free.join(" ");
  query.empty = !(query.method || query.path || query.sys || query.title || query.text);
  return query;
}
