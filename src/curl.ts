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

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/g, " "));
  } catch {
    return text;
  }
}

/* 变量 */

export const VARIABLE_PATTERN = /\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function substitute(content: string, variables: VariableItem[]): string {
  const map = new Map(variables.map((item) => [item.name, item.value]));
  return content.replace(VARIABLE_PATTERN, (whole, name: string) => (map.has(name) ? (map.get(name) ?? "") : whole));
}

export function variableNames(content: string): string[] {
  const names: string[] = [];
  for (const match of content.matchAll(VARIABLE_PATTERN)) {
    names.push(match[1]);
  }
  return names;
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

/* 高亮 */

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function markVariables(escaped: string, defined: Set<string>): string {
  return escaped.replace(VARIABLE_PATTERN, (whole, name: string) => {
    const cls = defined.has(name) ? "sh-var" : "sh-var-missing";
    return `<span class="${cls}">${whole}</span>`;
  });
}

export function highlightShell(source: string, defined: Set<string>): string {
  if (!source) {
    return '<span class="sh-placeholder">这一条用例，通常是一条完整的 curl</span>\n';
  }
  const emit = (text: string) => markVariables(escapeHtml(text), defined);
  let html = "";
  let index = 0;
  while (index < source.length) {
    const ch = source[index];
    if (ch === "'" || ch === '"') {
      const end = endOfQuote(source, index);
      html += `<span class="sh-str">${emit(source.slice(index, end))}</span>`;
      index = end;
      continue;
    }
    if (ch === "#") {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      html += `<span class="sh-comment">${escapeHtml(source.slice(index, end))}</span>`;
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
      html += cls ? `<span class="${cls}">${emit(word)}</span>` : emit(word);
      continue;
    }
    html += escapeHtml(ch);
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
