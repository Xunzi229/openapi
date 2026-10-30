/** 动态函数。以后加函数，往 functions 里再放一项即可。 */
export interface DynamicFn {
  name: string;
  label: string;
  hint: string;
  presets: Array<{ label: string; arg: string }>;
  run: (arg: string, now: Date) => string;
}

const functions: DynamicFn[] = [
  {
    name: "now",
    label: "当前时间",
    hint: "格式或偏移，如 -1d yyyy-MM-dd",
    presets: [
      { label: "日期", arg: "yyyy-MM-dd" },
      { label: "日期时间", arg: "yyyy-MM-dd HH:mm:ss" },
      { label: "时间", arg: "HH:mm:ss" },
      { label: "紧凑", arg: "yyyyMMddHHmmss" },
      { label: "时间戳", arg: "timestamp" },
      { label: "毫秒", arg: "millis" },
      { label: "昨天", arg: "-1d yyyy-MM-dd" },
      { label: "明天", arg: "+1d yyyy-MM-dd" },
    ],
    run: runNow,
  },
];

export function listFns(): readonly DynamicFn[] {
  return functions;
}

export function parseCall(text: string): { name: string; arg: string } | null {
  const match = text.trim().match(/^\$([A-Za-z][A-Za-z0-9_]*)(?::([\s\S]*))?$/);
  if (!match) {
    return null;
  }
  const name = match[1].toLowerCase();
  if (!functions.some((fn) => fn.name === name)) {
    return null;
  }
  return { name, arg: (match[2] ?? "").trim() };
}

export function isCall(text: string): boolean {
  return parseCall(text) !== null;
}

export function runCall(text: string, now = new Date()): string | null {
  const call = parseCall(text);
  if (!call) {
    return null;
  }
  return functions.find((fn) => fn.name === call.name)?.run(call.arg, now) ?? null;
}

function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

function formatDate(date: Date, format: string): string {
  if (format === "timestamp") {
    return String(Math.floor(date.getTime() / 1000));
  }
  if (format === "millis") {
    return String(date.getTime());
  }
  if (format === "iso") {
    return date.toISOString();
  }
  const token: Record<string, string> = {
    yyyy: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    dd: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
    SSS: pad(date.getMilliseconds(), 3),
  };
  return format.replace(/yyyy|SSS|MM|dd|HH|mm|ss/g, (key) => token[key] ?? key);
}

function shift(date: Date, offset: string): Date {
  const match = offset.match(/^([+-])(\d+)([dhms])$/);
  if (!match) {
    return date;
  }
  const next = new Date(date.getTime());
  const amount = Number(match[2]) * (match[1] === "-" ? -1 : 1);
  if (match[3] === "d") {
    next.setDate(next.getDate() + amount);
  } else if (match[3] === "h") {
    next.setHours(next.getHours() + amount);
  } else if (match[3] === "m") {
    next.setMinutes(next.getMinutes() + amount);
  } else {
    next.setSeconds(next.getSeconds() + amount);
  }
  return next;
}

function runNow(arg: string, now: Date): string {
  const text = arg.trim();
  const offset = text.match(/^([+-]\d+[dhms])(?:\s+|\|)?([\s\S]*)$/);
  const date = offset ? shift(now, offset[1]) : now;
  const format = (offset ? offset[2] : text).trim() || "yyyy-MM-dd HH:mm:ss";
  return formatDate(date, format);
}
