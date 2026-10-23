import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Library, RunResult, SystemItem, YapiProject } from "./types";

export function loadLibrary(): Promise<Library> {
  return invoke("load_library");
}

export function saveLibrary(library: Library): Promise<void> {
  return invoke("save_library", { library });
}

export function importMarkdown(dir: string): Promise<Library> {
  return invoke("import_markdown", { dir });
}

export function parseCurl(text: string): Promise<{ method: string; path: string; content: string }> {
  return invoke("parse_curl", { text });
}

export function dataDirPath(): Promise<string> {
  return invoke("data_dir_path");
}

export function openDataDir(): Promise<void> {
  return invoke("open_data_dir");
}

export function runCommand(runId: string, command: string): Promise<RunResult> {
  return invoke("run_command", { runId, command });
}

export function stopCommand(runId: string): Promise<boolean> {
  return invoke("stop_command", { runId });
}

export function importYapi(base: string, token: string, host: string): Promise<YapiProject> {
  return invoke("import_yapi", { base, token, host });
}

export function exportSystemMarkdown(path: string, system: SystemItem): Promise<void> {
  return invoke("export_system_markdown", { path, system });
}

export function backupLibrary(path: string): Promise<void> {
  return invoke("backup_library", { path });
}

export function restoreLibrary(path: string): Promise<Library> {
  return invoke("restore_library", { path });
}

export function onMenu(handler: (id: string) => void): void {
  void listen<string>("menu", (event) => handler(event.payload));
}

export async function pickDirectory(): Promise<string | null> {
  const selected = await open({ directory: true, multiple: false, title: "选择接口文档目录" });
  return typeof selected === "string" ? selected : null;
}

export async function pickJsonFile(): Promise<string | null> {
  const selected = await open({
    directory: false,
    multiple: false,
    title: "选择备份文件",
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  return typeof selected === "string" ? selected : null;
}

export async function pickSavePath(defaultName: string, extension: string): Promise<string | null> {
  const selected = await save({
    defaultPath: defaultName,
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  return typeof selected === "string" ? selected : null;
}

export function openLink(url: string): Promise<void> {
  return openUrl(url);
}

export function confirmDelete(text: string): Promise<boolean> {
  return ask({ title: "确认删除", text, confirm: "删除", cancel: "取消", danger: true });
}

export function confirmAction(text: string, title = "确认"): Promise<boolean> {
  return ask({ title, text, confirm: "继续", cancel: "取消" });
}

export function showMessage(text: string, title = "OpenApi"): Promise<void> {
  return ask({ title, text, confirm: "知道了", cancel: "" }).then(() => undefined);
}

interface AskOptions {
  title: string;
  text: string;
  confirm: string;
  cancel?: string;
  danger?: boolean;
}

let askResolve: ((ok: boolean) => void) | null = null;

function ask(options: AskOptions): Promise<boolean> {
  const root = document.querySelector("#ask") as HTMLElement;
  const title = document.querySelector("#ask-title") as HTMLElement;
  const text = document.querySelector("#ask-text") as HTMLElement;
  const ok = document.querySelector("#ask-ok") as HTMLButtonElement;
  const cancel = document.querySelector("#ask-cancel") as HTMLButtonElement;
  if (askResolve) {
    askResolve(false);
  }
  title.textContent = options.title;
  text.textContent = options.text;
  ok.textContent = options.confirm;
  ok.className = options.danger ? "danger" : "primary";
  cancel.hidden = !options.cancel;
  cancel.textContent = options.cancel ?? "取消";
  root.hidden = false;
  ok.focus();
  return new Promise((resolve) => {
    askResolve = resolve;
  });
}

export function finishAsk(ok: boolean) {
  const root = document.querySelector("#ask") as HTMLElement | null;
  if (root) {
    root.hidden = true;
  }
  const resolve = askResolve;
  askResolve = null;
  resolve?.(ok);
}

export async function copyText(text: string): Promise<void> {
  try {
    await writeText(text);
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
}
