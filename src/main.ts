import {
  backupLibrary,
  confirmAction,
  confirmDelete,
  copyText,
  dataDirPath,
  exportSystemMarkdown,
  finishAsk,
  importMarkdown,
  importYapi,
  loadLibrary,
  onMenu,
  openDataDir,
  openLink,
  parseCurl,
  pickDirectory,
  pickJsonFile,
  pickSavePath,
  restoreLibrary,
  runCommand,
  saveLibrary,
  showMessage,
  stopCommand,
} from "./api";
import {
  ago,
  caseTitle,
  envFor,
  formatCurl,
  fullTime,
  fuzzyScore,
  hasTitle,
  highlightShell,
  hostOf,
  hostsIn,
  normalizeHost,
  parseQuery,
  parseStructure,
  substitute,
  swapHost,
  type Query,
} from "./curl";
import type { ApiItem, CaseItem, Library, LinkItem, RunResult, SystemItem, VariableItem } from "./types";

const DOMAIN_ORDER = ["计划", "供应链", "采购", "风控", "商品", "PMS", "实验", "算法", "集成测试", "其他"];
const DEFAULT_CURL_BG = "#17211d";
const DEFAULT_FONT_SIZE = 16;
const RECENT_LIMIT = 5;

type Theme = "system" | "light" | "dark";

interface RunState {
  runId: string;
  running: boolean;
  result?: RunResult;
  error?: string;
}

let library: Library = { systems: [] };
let selectedId = "";
const openApiIds = new Set<string>();
const closedApiIds = new Set<string>();
let query: Query = parseQuery("");
let saveTimer = 0;
let toastTimer = 0;
let epoch = 0;
let editingRow = "";
let sidebarCursor = "";
let configOpen = false;
let noteEditingId = "";
const structureOpen = new Set<string>();
const formatBackup = new Map<string, string>();
const runs = new Map<string, RunState>();
const revealed = new Set<string>();

const systemList = document.querySelector("#system-list") as HTMLElement;
const detail = document.querySelector("#detail") as HTMLElement;
const brandCount = document.querySelector("#brand-count") as HTMLElement;
const search = document.querySelector("#search") as HTMLInputElement;
const crumbDomain = document.querySelector("#crumb-domain") as HTMLElement;
const crumbName = document.querySelector("#crumb-name") as HTMLElement;
const crumbCount = document.querySelector("#crumb-count") as HTMLElement;
const saveDot = document.querySelector("#save-dot") as HTMLElement;
const toast = document.querySelector("#toast") as HTMLElement;

function uid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
}

function button(label: string, className: string, onClick: (event: MouseEvent) => void, title = ""): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  if (title) {
    node.title = title;
  }
  node.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick(event);
  });
  return node;
}

/* 提示与保存状态 */

function notify(text: string, sticky = false) {
  window.clearTimeout(toastTimer);
  toast.textContent = text;
  toast.hidden = false;
  toast.classList.toggle("error", sticky);
  toast.classList.remove("fade");
  if (sticky) {
    return;
  }
  toastTimer = window.setTimeout(() => {
    toast.classList.add("fade");
    toastTimer = window.setTimeout(() => {
      toast.hidden = true;
    }, 260);
  }, 2000);
}

function hideToast() {
  window.clearTimeout(toastTimer);
  toast.hidden = true;
}

function setSaveState(state: "saved" | "saving" | "error", title?: string) {
  saveDot.className = `save-dot ${state}`;
  saveDot.title = title ?? (state === "saved" ? "已保存" : state === "saving" ? "保存中" : "保存失败");
}

function scheduleSave() {
  setSaveState("saving");
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    void flush();
  }, 400);
}

async function flush() {
  window.clearTimeout(saveTimer);
  const seq = epoch;
  const snapshot: Library = JSON.parse(JSON.stringify(library)) as Library;
  try {
    await saveLibrary(snapshot);
    if (seq === epoch) {
      setSaveState("saved");
      if (toast.classList.contains("error")) {
        hideToast();
      }
    }
  } catch (error) {
    if (seq === epoch) {
      setSaveState("error", `保存失败：${String(error)}`);
      notify(`保存失败：${String(error)}`, true);
    }
  }
}

function touchApi(api: ApiItem) {
  api.updatedAt = Date.now();
}

function touchCase(api: ApiItem, item: CaseItem) {
  item.updatedAt = Date.now();
  touchApi(api);
}

/* 本机记录 */

function readList(key: string): string[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function writeList(key: string, list: string[]) {
  localStorage.setItem(key, JSON.stringify(list));
}

function pushRecent(id: string) {
  writeList("recent-system-ids", [id, ...readList("recent-system-ids").filter((item) => item !== id)].slice(0, RECENT_LIMIT));
}

function readCollapsed(): Set<string> {
  return new Set(readList("collapsed-domains"));
}

function toggleCollapsed(domain: string) {
  const collapsed = readCollapsed();
  if (collapsed.has(domain)) {
    collapsed.delete(domain);
  } else {
    collapsed.add(domain);
  }
  writeList("collapsed-domains", [...collapsed]);
}

function selectSystem(id: string) {
  selectedId = id;
  if (id) {
    localStorage.setItem("selected-system-id", id);
    pushRecent(id);
  } else {
    localStorage.removeItem("selected-system-id");
  }
}

function selectedSystem(): SystemItem | undefined {
  return library.systems.find((system) => system.id === selectedId);
}

/* 搜索 */

function rank(domain: string): number {
  const index = DOMAIN_ORDER.indexOf(domain);
  return index === -1 ? DOMAIN_ORDER.length : index;
}

function searching(): boolean {
  return !query.empty;
}

function apiMatches(api: ApiItem): boolean {
  if (query.empty) {
    return false;
  }
  if (query.method && api.method.toLowerCase() !== query.method) {
    return false;
  }
  if (query.path && !api.path.toLowerCase().includes(query.path)) {
    return false;
  }
  if (query.title && !api.cases.some((item, index) => caseTitle(item.content, index).toLowerCase().includes(query.title))) {
    return false;
  }
  if (query.text) {
    const text = [api.method, api.path, api.note, ...api.cases.map((item) => item.content)].join("\n").toLowerCase();
    if (!text.includes(query.text)) {
      return false;
    }
  }
  return Boolean(query.method || query.path || query.title || query.text);
}

function systemTextMatches(system: SystemItem): boolean {
  if (query.empty || query.method || query.path || query.title) {
    return false;
  }
  if (!query.text) {
    return false;
  }
  return [system.name, system.domain, system.note].join("\n").toLowerCase().includes(query.text);
}

function matches(system: SystemItem): boolean {
  if (query.empty) {
    return true;
  }
  if (query.sys && !system.name.toLowerCase().includes(query.sys)) {
    return false;
  }
  if (!(query.method || query.path || query.title || query.text)) {
    return true;
  }
  return systemTextMatches(system) || system.apis.some(apiMatches);
}

function orderedSystems(systems: SystemItem[]): SystemItem[] {
  const domains = [...new Set(systems.map((system) => system.domain || "其他"))].sort(
    (left, right) => rank(left) - rank(right) || left.localeCompare(right, "zh"),
  );
  const ordered: SystemItem[] = [];
  for (const domain of domains) {
    ordered.push(...systems.filter((system) => (system.domain || "其他") === domain));
  }
  return ordered;
}

function sortedApis(system: SystemItem): ApiItem[] {
  return [...system.apis].sort((left, right) => Number(right.starred) - Number(left.starred));
}

function visibleApis(system: SystemItem): ApiItem[] {
  const apis = sortedApis(system);
  if (!searching()) {
    return apis;
  }
  const hits = apis.filter(apiMatches);
  if (hits.length > 0) {
    return hits;
  }
  return systemTextMatches(system) || (query.sys && !(query.method || query.path || query.title || query.text)) ? apis : [];
}

function syncSelection() {
  if (!searching()) {
    return;
  }
  const visible = orderedSystems(library.systems.filter(matches));
  if (visible.length === 0 || visible.some((system) => system.id === selectedId)) {
    return;
  }
  selectSystem(visible[0].id);
}

function knownDomains(): string[] {
  const extras = [...new Set(library.systems.map((system) => (system.domain || "其他").trim()).filter((domain) => domain && !DOMAIN_ORDER.includes(domain)))];
  extras.sort((left, right) => left.localeCompare(right, "zh"));
  return [...DOMAIN_ORDER, ...extras];
}

let pickedDomain = "";

function paintDomainPicks() {
  const box = document.querySelector("#domain-picks") as HTMLElement;
  box.replaceChildren();
  for (const domain of knownDomains()) {
    box.append(
      button(domain, pickedDomain === domain ? "on" : "", () => {
        pickedDomain = pickedDomain === domain ? "" : domain;
        (document.querySelector("#system-form input[name=domain]") as HTMLInputElement).value = "";
        paintDomainPicks();
      }),
    );
  }
}

function openSystemDialog() {
  closePops();
  const form = document.querySelector("#system-form") as HTMLFormElement;
  form.reset();
  pickedDomain = "";
  paintDomainPicks();
  (document.querySelector("#system-dialog") as HTMLElement).hidden = false;
  (form.elements.namedItem("name") as HTMLInputElement).focus();
}

function closeSystemDialog() {
  (document.querySelector("#system-dialog") as HTMLElement).hidden = true;
}

function submitSystem(form: HTMLFormElement) {
  const data = new FormData(form);
  const name = String(data.get("name") ?? "").trim();
  if (!name) {
    return;
  }
  const typed = String(data.get("domain") ?? "").trim();
  query = parseQuery("");
  search.value = "";
  resetOpenState();
  const existing = library.systems.find((system) => system.name === name);
  if (existing) {
    selectSystem(existing.id);
    closeSystemDialog();
    notify("已有这个系统");
    render();
    return;
  }
  const system: SystemItem = {
    id: uid(),
    name,
    domain: typed || pickedDomain || domainOf(name),
    note: "",
    links: [],
    variables: [],
    apis: [],
  };
  library.systems.push(system);
  selectSystem(system.id);
  closeSystemDialog();
  scheduleSave();
  render();
}

function domainOf(name: string): string {
  if (name.includes("集成测试")) {
    return "集成测试";
  }
  const rules: Array<[boolean, string]> = [
    [name.startsWith("plan-"), "计划"],
    [name.startsWith("scm-"), "供应链"],
    [name.startsWith("ddmc-") || name === "greatwall", "采购"],
    [name.startsWith("risk-control"), "风控"],
    [name.startsWith("sku-"), "商品"],
    [name.startsWith("pms-"), "PMS"],
    [name.startsWith("abtest"), "实验"],
    [name.startsWith("algo-"), "算法"],
  ];
  return rules.find(([hit]) => hit)?.[1] ?? "其他";
}

/* 展开状态 */

function isApiOpen(api: ApiItem): boolean {
  if (closedApiIds.has(api.id)) {
    return false;
  }
  return openApiIds.has(api.id) || apiMatches(api);
}

function showApi(apiId: string) {
  closedApiIds.delete(apiId);
  openApiIds.add(apiId);
}

function hideApi(apiId: string) {
  openApiIds.delete(apiId);
  closedApiIds.add(apiId);
}

function resetOpenState() {
  openApiIds.clear();
  closedApiIds.clear();
  editingRow = "";
}

function expandAll() {
  const system = selectedSystem();
  if (!system) {
    return;
  }
  closedApiIds.clear();
  for (const api of system.apis) {
    openApiIds.add(api.id);
  }
  renderDetail();
}

function collapseAll() {
  const system = selectedSystem();
  if (!system) {
    return;
  }
  openApiIds.clear();
  for (const api of system.apis) {
    closedApiIds.add(api.id);
  }
  renderDetail();
}

function scrollToApi(apiId: string) {
  document.querySelector(`[data-api="${apiId}"]`)?.scrollIntoView({ block: "start" });
}

function jumpToApi(systemId: string, apiId: string) {
  selectSystem(systemId);
  showApi(apiId);
  render();
  scrollToApi(apiId);
  focusApiRow(apiId);
}

/* 渲染 */

function render() {
  syncSelection();
  renderSidebar();
  renderDetail();
}

function renderSidebar() {
  systemList.replaceChildren();
  brandCount.textContent = `${library.systems.length} 个系统`;
  const visible = orderedSystems(library.systems.filter(matches));
  if (visible.length === 0) {
    systemList.append(el("p", "domain", library.systems.length === 0 ? "还没有系统" : "没有匹配的系统"));
    return;
  }

  const collapsed = readCollapsed();

  if (!searching()) {
    const recent = readList("recent-system-ids")
      .map((id) => library.systems.find((system) => system.id === id))
      .filter((system): system is SystemItem => Boolean(system));
    if (recent.length > 0) {
      const group = domainGroup("最近", recent.length, collapsed.has("最近"));
      if (!collapsed.has("最近")) {
        for (const system of recent) {
          group.append(systemButton(system));
        }
      }
      systemList.append(group);
    }
    const starred = library.systems.flatMap((system) => system.apis.filter((api) => api.starred).map((api) => ({ system, api })));
    if (starred.length > 0) {
      const group = domainGroup("收藏", starred.length, collapsed.has("收藏"));
      if (!collapsed.has("收藏")) {
        for (const { system, api } of starred) {
          group.append(apiHit(system, api, true));
        }
      }
      systemList.append(group);
    }
  }

  const domains = [...new Set(visible.map((system) => system.domain || "其他"))];
  for (const domain of domains) {
    const members = visible.filter((item) => (item.domain || "其他") === domain);
    const folded = !searching() && collapsed.has(domain);
    const group = domainGroup(domain, members.length, folded);
    if (!folded) {
      for (const system of members) {
        group.append(systemButton(system));
        if (searching()) {
          for (const api of system.apis.filter(apiMatches)) {
            group.append(apiHit(system, api, false));
          }
        }
      }
    }
    systemList.append(group);
  }
}

function domainGroup(domain: string, count: number, folded: boolean): HTMLElement {
  const group = el("section", folded ? "group folded" : "group");
  const title = el("button", "domain");
  title.type = "button";
  title.append(el("i"), el("span", "", domain), el("em", "", String(count)));
  title.addEventListener("click", () => {
    toggleCollapsed(domain);
    renderSidebar();
  });
  group.append(title);
  return group;
}

function systemButton(system: SystemItem): HTMLButtonElement {
  const node = el("button", system.id === selectedId ? "system active" : "system");
  node.type = "button";
  node.dataset.key = `sys:${system.id}`;
  node.classList.toggle("kb", node.dataset.key === sidebarCursor);
  node.append(el("span", "", system.name || "未命名"), el("em", "", String(system.apis.length)));
  node.addEventListener("click", () => {
    selectSystem(system.id);
    resetOpenState();
    render();
  });
  return node;
}

function apiHit(system: SystemItem, api: ApiItem, withSystem: boolean): HTMLButtonElement {
  const hit = el("button", "api-hit");
  hit.type = "button";
  hit.dataset.key = `api:${system.id}:${api.id}`;
  hit.classList.toggle("kb", hit.dataset.key === sidebarCursor);
  hit.title = `${api.method} ${api.path}`;
  hit.append(el("b", "", api.method.toLowerCase()), el("span", "", api.path));
  if (withSystem) {
    hit.append(el("small", "", system.name));
  }
  hit.addEventListener("click", () => jumpToApi(system.id, api.id));
  return hit;
}

/* 搜索框里的上下键 */

function moveSidebarCursor(delta: number) {
  const items = [...systemList.querySelectorAll<HTMLElement>("[data-key]")];
  if (items.length === 0) {
    return;
  }
  const index = items.findIndex((item) => item.dataset.key === sidebarCursor);
  const next = items[Math.min(items.length - 1, Math.max(0, index + delta))];
  sidebarCursor = next.dataset.key ?? "";
  const [kind, systemId, apiId] = sidebarCursor.split(":");
  selectSystem(systemId);
  if (kind === "api") {
    showApi(apiId);
  }
  render();
  systemList.querySelector(".kb")?.scrollIntoView({ block: "nearest" });
  if (kind === "api") {
    scrollToApi(apiId);
  } else {
    detail.scrollTop = 0;
  }
}

function enterSidebarCursor() {
  const [kind, , apiId] = sidebarCursor.split(":");
  if (kind === "api") {
    focusApiRow(apiId);
    return;
  }
  (detail.querySelector("[data-api-row]") as HTMLElement | null)?.focus({ preventScroll: true });
}

function onSearchKey(event: KeyboardEvent) {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    moveSidebarCursor(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (!sidebarCursor) {
      moveSidebarCursor(1);
    }
    enterSidebarCursor();
  } else if (event.key === "Escape") {
    search.value = "";
    search.dispatchEvent(new Event("input"));
    search.blur();
  }
}

function renderCrumb(system: SystemItem | undefined) {
  if (!system) {
    crumbDomain.textContent = "";
    crumbName.textContent = "OpenApi";
    crumbCount.textContent = "";
    return;
  }
  crumbDomain.textContent = system.domain || "其他";
  crumbName.textContent = system.name || "未命名";
  crumbCount.textContent = `${system.apis.length} 个接口`;
}

function setConfigOpen(open: boolean) {
  configOpen = open && Boolean(selectedSystem());
  applyConfigChrome();
}

function applyConfigChrome() {
  const panel = document.querySelector("#config") as HTMLElement | null;
  const toggle = document.querySelector("#config-toggle");
  if (panel) {
    panel.hidden = !configOpen;
  }
  toggle?.classList.toggle("on", configOpen);
}

function renderConfig(system: SystemItem | undefined) {
  const panel = document.querySelector("#config") as HTMLElement;
  if (!system) {
    configOpen = false;
    panel.replaceChildren();
    applyConfigChrome();
    return;
  }
  const body = panel.querySelector(".config-box");
  const scrollTop = body?.scrollTop ?? 0;
  const box = el("div", "config-box");
  const head = el("div", "config-head");
  head.append(el("strong", "", "环境与变量"), button("关闭", "ghost", () => setConfigOpen(false)));
  box.append(head, renderLinkCard(system, "env"), renderLinkCard(system, "doc"), renderVariableCard(system));
  panel.replaceChildren(box);
  box.scrollTop = scrollTop;
  applyConfigChrome();
}

function renderDetail() {
  const scrollTop = detail.scrollTop;
  detail.replaceChildren();
  const system = selectedSystem();
  renderCrumb(system);
  renderConfig(system);
  if (!system) {
    detail.append(renderEmpty());
    return;
  }
  detail.append(renderSystemHead(system), renderNote(system), renderApiHead(system), renderCurlAdd(system));
  for (const api of visibleApis(system)) {
    detail.append(renderApi(system, api));
  }
  detail.scrollTop = scrollTop;
}

function renderEmpty(): HTMLElement {
  const empty = el("div", "empty");
  const row = el("div", "row");
  row.append(
    button("导入 Markdown", "primary", () => void onImport()),
    button("新建系统", "secondary", () => openSystemDialog()),
  );
  empty.append(
    el("h2", "", "OpenApi"),
    el("p", "", "按系统整理接口，每条 curl 一个框。从左侧选择系统，或者先导入一份 Markdown 目录。"),
    row,
  );
  return empty;
}

/* 系统头 */

function renderSystemHead(system: SystemItem): HTMLElement {
  const head = el("div", "system-head");

  const name = el("input", "name");
  name.value = system.name;
  name.placeholder = "系统名";
  let lastName = system.name;
  name.addEventListener("input", () => {
    const next = name.value.trim();
    if (!next) {
      return;
    }
    system.name = next;
    lastName = next;
    scheduleSave();
  });
  name.addEventListener("blur", () => {
    if (!name.value.trim()) {
      name.value = lastName;
      system.name = lastName;
      notify("系统名不能为空");
    }
    renderSidebar();
    renderCrumb(system);
  });
  name.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      name.blur();
    }
  });

  const custom = el("input", "custom-domain");
  custom.placeholder = "业务域";
  const isCustom = !DOMAIN_ORDER.includes(system.domain || "其他");
  custom.value = isCustom ? system.domain : "";
  custom.hidden = !isCustom;
  const select = menuField(
    [...DOMAIN_ORDER.map((domain) => ({ value: domain, label: domain })), { value: "__custom__", label: "自定义" }],
    isCustom ? "__custom__" : system.domain || "其他",
    (value) => {
      if (value === "__custom__") {
        custom.hidden = false;
        custom.focus();
        return;
      }
      custom.hidden = true;
      system.domain = value;
      scheduleSave();
      renderSidebar();
      renderCrumb(system);
    },
  );
  custom.addEventListener("input", () => {
    system.domain = custom.value.trim();
    scheduleSave();
  });
  custom.addEventListener("blur", () => {
    if (!system.domain) {
      system.domain = "其他";
      select.setValue("其他");
      custom.hidden = true;
      scheduleSave();
    }
    renderSidebar();
    renderCrumb(system);
  });

  const moreWrap = el("div", "pop-wrap");
  const pop = el("div", "pop");
  pop.hidden = true;
  const yapiItem = button("从 YApi 导入…", "item", () => {
    pop.hidden = true;
    openYapiDialog(system);
  });
  const exportItem = button("导出为 Markdown…", "item", () => {
    pop.hidden = true;
    void exportSystem(system);
  });
  const remove = button("删除这个系统", "item danger", () => {
    pop.hidden = true;
    void confirmDelete(`删除系统 ${system.name}？`).then((ok) => {
      if (!ok) {
        return;
      }
      library.systems = library.systems.filter((item) => item.id !== system.id);
      selectSystem("");
      scheduleSave();
      render();
    });
  });
  pop.append(yapiItem, exportItem, remove);
  const more = button("⋯", "icon", () => {
    closePops(pop);
    pop.hidden = !pop.hidden;
  }, "更多");
  moreWrap.append(more, pop);

  head.append(name, select, custom, moreWrap);
  return head;
}

function renderNote(system: SystemItem): HTMLElement {
  if (noteEditingId !== system.id) {
    const text = system.note.trim();
    const preview = el("button", text ? "note-preview" : "note-preview empty", text || "添加说明");
    preview.type = "button";
    preview.addEventListener("click", () => {
      noteEditingId = system.id;
      renderDetail();
    });
    return preview;
  }
  const note = el("textarea", "note");
  note.placeholder = "系统说明";
  note.value = system.note;
  note.addEventListener("input", () => {
    system.note = note.value;
    scheduleSave();
  });
  note.addEventListener("blur", () => {
    if (noteEditingId !== system.id) {
      return;
    }
    noteEditingId = "";
    renderDetail();
  });
  note.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      note.blur();
    }
  });
  requestAnimationFrame(() => note.focus());
  return note;
}

/* 环境与链接 */

function candidateHosts(system: SystemItem): string[] {
  return hostsIn(system.apis.flatMap((api) => api.cases.map((item) => item.content)));
}

function renderLinkCard(system: SystemItem, kind: "env" | "doc"): HTMLElement {
  const card = el("section", "card");
  const head = el("div", "card-head");
  head.append(el("h3", "", kind === "env" ? "环境" : "链接"));
  card.append(head);
  const list = el("div", "rows");
  const rows = system.links.filter((link) => link.kind === kind);
  for (const link of rows) {
    list.append(editingRow === link.id ? renderLinkEditor(system, link, kind) : renderLinkRow(system, link, kind));
  }
  const newKey = `new-${kind}:${system.id}`;
  if (editingRow === newKey) {
    const draft: LinkItem = { id: uid(), label: "", url: "", kind, host: "", note: "" };
    list.append(renderLinkEditor(system, draft, kind, true));
  } else {
    const add = button(kind === "env" ? "+ 添加环境" : "+ 添加链接", "add-row", () => {
      editingRow = newKey;
      renderDetail();
      focusFirstInput(newKey);
    });
    list.append(add);
  }
  card.append(list);
  return card;
}

function renderLinkRow(system: SystemItem, link: LinkItem, kind: "env" | "doc"): HTMLElement {
  const row = el("div", "row-item");
  row.dataset.row = link.id;
  row.draggable = true;
  row.append(el("span", "handle", "⋮⋮"));
  row.append(el("b", "", link.label || "未命名"));
  if (kind === "env") {
    const current = currentEnvId(system) === link.id;
    row.classList.add("env");
    row.classList.toggle("current", current);
    row.title = current ? "再点一次，只用全局变量" : "选择这个环境";
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button, input, a")) {
        return;
      }
      setCurrentEnv(system, current ? "" : link.id);
      renderDetail();
    });
  }
  if (kind === "env") {
    const host = el("code", "", link.host || "");
    if (!link.host) {
      const hint = candidateHosts(system).find((item) => link.label && item.toLowerCase().includes(link.label.toLowerCase()));
      if (hint) {
        host.append(
          button(`用 ${hint}？`, "suggest", () => {
            link.host = hint;
            scheduleSave();
            renderDetail();
          }),
        );
      } else {
        host.textContent = "未填主机";
        host.classList.add("muted");
      }
    }
    row.append(host);
  } else {
    const url = el("code", "", link.url);
    url.title = link.url;
    row.append(url);
  }
  row.append(el("span", "note-text", link.note));
  const actions = el("span", "row-actions");
  if (link.url) {
    actions.append(button("打开", "ghost", () => void openLink(link.url).catch((error: unknown) => notify(`打不开链接：${String(error)}`, true))));
  }
  if (kind === "env" && link.host) {
    actions.append(button("复制主机", "ghost", () => void copyText(normalizeHost(link.host)).then(() => notify("已复制主机"))));
  }
  if (kind === "doc" && link.url) {
    actions.append(button("复制地址", "ghost", () => void copyText(link.url).then(() => notify("已复制地址"))));
  }
  actions.append(
    button("编辑", "ghost", () => {
      editingRow = link.id;
      renderDetail();
      focusFirstInput(link.id);
    }),
    button("删除", "ghost remove", () => {
      const owned = kind === "env" ? system.variables.filter((item) => item.envId === link.id).length : 0;
      const extra = owned > 0 ? `，以及它的 ${owned} 个变量` : "";
      void confirmDelete(`删除${kind === "env" ? "环境" : "链接"} ${link.label || "未命名"}${extra}？`).then((ok) => {
        if (!ok) {
          return;
        }
        system.links = system.links.filter((item) => item.id !== link.id);
        if (kind === "env") {
          system.variables = system.variables.filter((item) => item.envId !== link.id);
          if (currentEnvId(system) === link.id) {
            setCurrentEnv(system, "");
          }
        }
        scheduleSave();
        renderDetail();
      });
    }),
  );
  row.append(actions);
  attachDrag(row, link.id, () => system.links, (next) => {
    system.links = next;
  });
  return row;
}

function renderLinkEditor(system: SystemItem, link: LinkItem, kind: "env" | "doc", isNew = false): HTMLElement {
  const row = el("form", "row-item editing");
  row.dataset.row = isNew ? `new-${kind}:${system.id}` : link.id;
  const label = el("input");
  label.placeholder = kind === "env" ? "名称，如 TE" : "名称，如 yapi";
  label.value = link.label;
  const host = el("input");
  host.placeholder = "主机，如 https://scm-po.te.ddmc.com";
  host.value = link.host;
  const url = el("input");
  url.placeholder = kind === "env" ? "发布页地址，可空" : "https://";
  url.value = link.url;
  const note = el("input");
  note.placeholder = "备注，可空";
  note.value = link.note;
  if (kind === "env") {
    const listId = `hosts-${system.id}`;
    const datalist = el("datalist");
    datalist.id = listId;
    for (const candidate of candidateHosts(system)) {
      const option = el("option");
      option.value = candidate;
      datalist.append(option);
    }
    host.setAttribute("list", listId);
    row.append(label, host, url, note, datalist);
  } else {
    row.append(label, url, note);
  }
  const actions = el("span", "row-actions");
  const save = el("button", "primary", "保存");
  save.type = "submit";
  const cancel = button("取消", "ghost", () => {
    editingRow = "";
    renderDetail();
  });
  actions.append(save, cancel);
  row.append(actions);
  row.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextLabel = label.value.trim();
    const nextUrl = url.value.trim();
    const nextHost = host.value.trim();
    if (!nextLabel) {
      label.focus();
      return;
    }
    if (kind === "doc" && !nextUrl) {
      url.focus();
      return;
    }
    link.label = nextLabel;
    link.url = nextUrl;
    link.host = kind === "env" ? nextHost : "";
    link.note = note.value.trim();
    if (isNew) {
      system.links.push(link);
    }
    editingRow = "";
    scheduleSave();
    renderDetail();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      editingRow = "";
      renderDetail();
    }
  });
  return row;
}

function focusFirstInput(rowKey: string) {
  const input = document.querySelector(`[data-row="${rowKey}"] input`) as HTMLInputElement | null;
  input?.focus();
}

function attachDrag<T extends { id: string }>(row: HTMLElement, id: string, read: () => T[], write: (next: T[]) => void) {
  row.addEventListener("dragstart", (event) => {
    event.dataTransfer?.setData("text/plain", id);
    row.classList.add("dragging");
  });
  row.addEventListener("dragend", () => row.classList.remove("dragging"));
  row.addEventListener("dragover", (event) => {
    event.preventDefault();
    row.classList.add("drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("drop-target");
    const sourceId = event.dataTransfer?.getData("text/plain");
    if (!sourceId || sourceId === id) {
      return;
    }
    const list = read();
    const from = list.findIndex((item) => item.id === sourceId);
    const to = list.findIndex((item) => item.id === id);
    if (from === -1 || to === -1) {
      return;
    }
    const next = [...list];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    write(next);
    scheduleSave();
    renderDetail();
  });
}

/* 变量：全局一份，每个环境再一份。同名时当前环境覆盖全局。 */

function currentEnvId(system: SystemItem): string {
  const saved = localStorage.getItem(`current-env:${system.id}`) ?? "";
  return system.links.some((link) => link.kind === "env" && link.id === saved) ? saved : "";
}

function setCurrentEnv(system: SystemItem, envId: string) {
  if (envId) {
    localStorage.setItem(`current-env:${system.id}`, envId);
  } else {
    localStorage.removeItem(`current-env:${system.id}`);
  }
}

function variablesFor(system: SystemItem, envId = currentEnvId(system)): VariableItem[] {
  const merged = new Map<string, VariableItem>();
  for (const variable of system.variables) {
    if (!variable.envId) {
      merged.set(variable.name, variable);
    }
  }
  if (envId) {
    for (const variable of system.variables) {
      if (variable.envId === envId) {
        merged.set(variable.name, variable);
      }
    }
  }
  return [...merged.values()];
}

function writeScope(system: SystemItem, envId: string, next: VariableItem[]) {
  const result: VariableItem[] = [];
  let inserted = false;
  for (const item of system.variables) {
    if ((item.envId || "") !== envId) {
      result.push(item);
      continue;
    }
    if (!inserted) {
      result.push(...next);
      inserted = true;
    }
  }
  if (!inserted) {
    result.push(...next);
  }
  system.variables = result;
}

function renderVariableCard(system: SystemItem): HTMLElement {
  const card = el("section", "card");
  const head = el("div", "card-head");
  head.append(el("h3", "", "变量"));
  card.append(head);
  const list = el("div", "rows");
  list.append(renderVariableScope(system, "", "全局"));
  const current = system.links.find((link) => link.kind === "env" && link.id === currentEnvId(system));
  if (current) {
    list.append(renderVariableScope(system, current.id, current.label || "未命名"));
  }
  card.append(list);
  return card;
}

function renderVariableScope(system: SystemItem, envId: string, label: string): HTMLElement {
  const fragment = el("div", "scope");
  fragment.append(el("div", envId ? "scope-label env" : "scope-label", label));
  for (const variable of system.variables.filter((item) => (item.envId || "") === envId)) {
    fragment.append(editingRow === variable.id ? renderVariableEditor(system, variable) : renderVariableRow(system, variable));
  }
  const newKey = `new-var:${system.id}:${envId}`;
  if (editingRow === newKey) {
    fragment.append(renderVariableEditor(system, { id: uid(), name: "", value: "", secret: false, envId }, true));
  } else {
    fragment.append(
      button("+ 添加变量", "add-row", () => {
        editingRow = newKey;
        renderDetail();
        focusFirstInput(newKey);
      }),
    );
  }
  return fragment;
}

function renderVariableRow(system: SystemItem, variable: VariableItem): HTMLElement {
  const row = el("div", "row-item");
  row.dataset.row = variable.id;
  row.draggable = true;
  row.append(el("span", "handle", "⋮⋮"));
  row.append(el("b", "", `{{${variable.name}}}`));
  const shown = variable.secret && !revealed.has(variable.id) ? "••••••••" : variable.value;
  const value = el("code", "", shown);
  value.title = variable.secret ? "" : variable.value;
  row.append(value);
  const uses = system.apis.reduce((sum, api) => sum + api.cases.filter((item) => item.content.includes(`{{${variable.name}}}`)).length, 0);
  if (uses > 0) {
    const usage = el("span", "note-text", String(uses));
    usage.title = `${uses} 处使用`;
    row.append(usage);
  }
  const actions = el("span", "row-actions");
  if (variable.secret) {
    actions.append(
      button(revealed.has(variable.id) ? "隐藏" : "显示", "ghost", () => {
        if (revealed.has(variable.id)) {
          revealed.delete(variable.id);
        } else {
          revealed.add(variable.id);
        }
        renderDetail();
      }),
    );
  }
  actions.append(
    button("复制值", "ghost", () => void copyText(variable.value).then(() => notify("已复制"))),
    button("编辑", "ghost", () => {
      editingRow = variable.id;
      renderDetail();
      focusFirstInput(variable.id);
    }),
    button("删除", "ghost remove", () => {
      void confirmDelete(`删除变量 {{${variable.name}}}？用例里的引用不会改。`).then((ok) => {
        if (!ok) {
          return;
        }
        system.variables = system.variables.filter((item) => item.id !== variable.id);
        scheduleSave();
        renderDetail();
      });
    }),
  );
  row.append(actions);
  const scope = variable.envId || "";
  attachDrag(
    row,
    variable.id,
    () => system.variables.filter((item) => (item.envId || "") === scope),
    (next) => writeScope(system, scope, next),
  );
  return row;
}

function renderVariableEditor(system: SystemItem, variable: VariableItem, isNew = false): HTMLElement {
  const row = el("form", "row-item editing");
  row.dataset.row = isNew ? `new-var:${system.id}:${variable.envId || ""}` : variable.id;
  const name = el("input");
  name.placeholder = "名称，如 token";
  name.value = variable.name;
  const value = el("input");
  value.placeholder = "值";
  value.value = variable.value;
  let scopeValue = system.links.some((link) => link.id === variable.envId) ? variable.envId : "";
  const scope = menuField(
    [
      { value: "", label: "全局" },
      ...system.links.filter((link) => link.kind === "env").map((link) => ({ value: link.id, label: link.label || "未命名" })),
    ],
    scopeValue,
    (value) => {
      scopeValue = value;
    },
  );
  const secretLabel = el("label", "check");
  const secret = el("input");
  secret.type = "checkbox";
  secret.checked = variable.secret;
  secretLabel.append(secret, document.createTextNode("敏感"));
  const actions = el("span", "row-actions");
  const save = el("button", "primary", "保存");
  save.type = "submit";
  actions.append(
    save,
    button("取消", "ghost", () => {
      editingRow = "";
      renderDetail();
    }),
  );
  row.append(name, value, scope, secretLabel, actions);
  row.addEventListener("submit", (event) => {
    event.preventDefault();
    const nextName = name.value.trim().replace(/[^A-Za-z0-9_.-]/g, "");
    if (!nextName) {
      name.focus();
      return;
    }
    const nextEnv = scopeValue;
    if (system.variables.some((item) => item.name === nextName && (item.envId || "") === nextEnv && item.id !== variable.id)) {
      notify(`这里已有变量 {{${nextName}}}`);
      name.focus();
      return;
    }
    variable.name = nextName;
    variable.value = value.value;
    variable.secret = secret.checked;
    variable.envId = nextEnv;
    if (isNew) {
      system.variables.push(variable);
    }
    editingRow = "";
    scheduleSave();
    renderDetail();
  });
  row.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      editingRow = "";
      renderDetail();
    }
  });
  return row;
}

function definedVariables(system: SystemItem): Set<string> {
  return new Set(variablesFor(system).map((item) => item.name));
}

function makeVariable(system: SystemItem, selected: string, name: string) {
  const cleanName = name.trim().replace(/[^A-Za-z0-9_.-]/g, "");
  if (!cleanName || !selected) {
    return;
  }
  const envId = currentEnvId(system);
  if (system.variables.some((item) => item.name === cleanName && (item.envId || "") === envId)) {
    notify(`已有变量 {{${cleanName}}}`);
    return;
  }
  let count = 0;
  for (const api of system.apis) {
    for (const item of api.cases) {
      count += item.content.split(selected).length - 1;
    }
  }
  const scopeName = system.links.find((link) => link.id === envId)?.label;
  void confirmAction(`将把 ${count} 处相同文本替换为 {{${cleanName}}}，并加到${scopeName ? `环境 ${scopeName}` : "全局变量"}。继续？`, "设为变量").then((ok) => {
    if (!ok) {
      return;
    }
    for (const api of system.apis) {
      for (const item of api.cases) {
        if (item.content.includes(selected)) {
          item.content = item.content.split(selected).join(`{{${cleanName}}}`);
          touchCase(api, item);
        }
      }
    }
    system.variables.push({
      id: uid(),
      name: cleanName,
      value: selected,
      secret: /token|cookie|secret|password|auth/i.test(cleanName),
      envId,
    });
    scheduleSave();
    renderDetail();
    notify(`已替换 ${count} 处`);
  });
}

/* 接口列表 */

function renderApiHead(system: SystemItem): HTMLElement {
  const head = el("div", "api-head");
  const shown = visibleApis(system).length;
  head.append(
    el("h3", "", searching() && shown !== system.apis.length ? `接口 ${shown} / ${system.apis.length}` : `接口 ${system.apis.length}`),
    el("div", "spacer"),
    button("全部展开", "ghost", expandAll),
    button("全部收起", "ghost", collapseAll),
  );
  return head;
}

function renderCurlAdd(system: SystemItem): HTMLElement {
  const form = el("form", "curl-add");
  const input = el("textarea", "curl-add-input");
  input.spellcheck = false;
  input.rows = 1;
  input.placeholder = "粘贴一条 curl，⌘↵ 添加";
  const actions = el("div", "actions");
  const submit = el("button", "primary", "添加接口");
  submit.type = "submit";
  actions.append(submit, el("span", "hint", "已有相同方法和路径时，加为该接口的新用例"));
  form.append(input, actions);

  const fit = () => {
    if (!form.classList.contains("expanded")) {
      input.style.height = "";
      return;
    }
    input.style.height = "auto";
    input.style.height = `${Math.max(input.scrollHeight, 180)}px`;
  };
  input.addEventListener("focus", () => {
    form.classList.add("expanded");
    fit();
  });
  input.addEventListener("blur", () => {
    if (input.value.trim()) {
      return;
    }
    input.value = "";
    form.classList.remove("expanded");
    input.style.height = "";
  });
  input.addEventListener("input", fit);
  input.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    void parseCurl(text)
      .then((parsed) => {
        const found = system.apis.find((api) => api.method === parsed.method && api.path === parsed.path);
        const api: ApiItem = found ?? {
          id: uid(),
          method: parsed.method,
          path: parsed.path,
          note: "",
          starred: false,
          updatedAt: Date.now(),
          cases: [],
        };
        if (!found) {
          system.apis.push(api);
        }
        const same = api.cases.find((item) => item.content === parsed.content);
        const caseItem: CaseItem = same ?? { id: uid(), content: parsed.content, updatedAt: Date.now() };
        if (!same) {
          api.cases.push(caseItem);
          touchApi(api);
        }
        showApi(api.id);
        scheduleSave();
        render();
        scrollToApi(api.id);
        focusCase(caseItem.id);
        notify(
          same
            ? `${parsed.method} ${parsed.path} 里已经有这条用例`
            : found
              ? `已加到 ${parsed.method} ${parsed.path}`
              : `已添加 ${parsed.method} ${parsed.path}`,
        );
      })
      .catch((error: unknown) => notify(String(error), true));
  });
  return form;
}

function normalizedKey(api: ApiItem): string {
  return `${api.method} ${api.path.toLowerCase().replace(/\/+$/, "")}`;
}

function mergeCandidate(system: SystemItem, api: ApiItem): ApiItem | undefined {
  const key = normalizedKey(api);
  const index = system.apis.indexOf(api);
  return system.apis.find((other, otherIndex) => other.id !== api.id && otherIndex < index && normalizedKey(other) === key);
}

function renderApi(system: SystemItem, api: ApiItem): HTMLElement {
  const open = isApiOpen(api);
  const article = el("article", open ? "api open" : "api");
  article.dataset.api = api.id;

  const row = el("div", "api-row");
  row.tabIndex = 0;
  row.dataset.apiRow = api.id;
  const star = button(api.starred ? "★" : "☆", api.starred ? "star on" : "star", () => {
    api.starred = !api.starred;
    touchApi(api);
    scheduleSave();
    render();
  }, api.starred ? "取消收藏" : "收藏");
  const badge = el("span", `method method-${api.method.toLowerCase()}`, api.method);
  const path = el("code", "", api.path);
  path.addEventListener("mousedown", (event) => event.stopPropagation());
  path.addEventListener("click", (event) => event.stopPropagation());
  const count = el("em", "", `${api.cases.length} 条用例`);
  row.append(star, badge, path, count);

  const target = mergeCandidate(system, api);
  if (target) {
    row.append(
      button("可合并", "ghost warn", () => {
        void confirmAction(`把这条接口的 ${api.cases.length} 条用例并入 ${target.method} ${target.path}？`, "合并接口").then((ok) => {
          if (!ok) {
            return;
          }
          for (const item of api.cases) {
            if (!target.cases.some((existing) => existing.content === item.content)) {
              target.cases.push(item);
            }
          }
          touchApi(target);
          system.apis = system.apis.filter((item) => item.id !== api.id);
          showApi(target.id);
          scheduleSave();
          render();
        });
      }, `与 ${target.method} ${target.path} 只差大小写或末尾斜杠`),
    );
  }
  row.append(
    button("复制全部", "ghost", () => {
      const text = api.cases.map((item) => substitute(item.content, variablesFor(system)).trim()).filter(Boolean).join("\n\n");
      void copyText(text).then(() => notify(`已复制 ${api.cases.length} 条用例`));
    }, "复制这个接口下的全部用例"),
    button("移动到…", "ghost", () => moveApi(system, api)),
    button("删除接口", "ghost danger", () => {
      void confirmDelete(`删除 ${api.method} ${api.path}？`).then((ok) => {
        if (!ok) {
          return;
        }
        system.apis = system.apis.filter((item) => item.id !== api.id);
        scheduleSave();
        render();
      });
    }),
  );
  row.addEventListener("click", () => {
    if (isApiOpen(api)) {
      hideApi(api.id);
    } else {
      showApi(api.id);
    }
    renderDetail();
    focusApiRow(api.id);
  });
  row.addEventListener("keydown", (event) => onApiRowKey(event, api));
  article.append(row);

  if (open || api.note) {
    const note = el("input", "api-note");
    note.placeholder = "接口备注，如 幂等、需要 x-tenant 头";
    note.value = api.note;
    note.addEventListener("input", () => {
      api.note = note.value;
      touchApi(api);
      scheduleSave();
    });
    note.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        note.blur();
      }
    });
    article.append(note);
  }

  if (open) {
    const body = el("div", "api-body");
    api.cases.forEach((item, index) => body.append(renderCase(system, api, item, index)));
    const actions = el("div", "case-actions");
    actions.append(
      button("添加用例", "secondary", () => {
        const item: CaseItem = { id: uid(), content: "", updatedAt: Date.now() };
        api.cases.push(item);
        touchApi(api);
        showApi(api.id);
        renderDetail();
        focusCase(item.id);
      }),
    );
    body.append(actions);
    article.append(body);
  }
  return article;
}

function focusApiRow(apiId: string) {
  (detail.querySelector(`[data-api-row="${apiId}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
}

function onApiRowKey(event: KeyboardEvent, api: ApiItem) {
  const rows = [...detail.querySelectorAll<HTMLElement>("[data-api-row]")];
  const index = rows.findIndex((row) => row.dataset.apiRow === api.id);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    next?.focus();
    next?.scrollIntoView({ block: "nearest" });
    return;
  }
  if (event.key === "ArrowRight" && !isApiOpen(api)) {
    event.preventDefault();
    showApi(api.id);
    renderDetail();
    focusApiRow(api.id);
    return;
  }
  if (event.key === "ArrowLeft" && isApiOpen(api)) {
    event.preventDefault();
    hideApi(api.id);
    renderDetail();
    focusApiRow(api.id);
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    if (!isApiOpen(api)) {
      showApi(api.id);
      renderDetail();
    }
    const first = api.cases[0];
    if (first) {
      focusCase(first.id);
    } else {
      focusApiRow(api.id);
    }
    return;
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && !window.getSelection()?.toString()) {
    event.preventDefault();
    void copyText(api.path).then(() => notify("已复制路径"));
  }
}

/* 用例框 */

function renderCase(system: SystemItem, api: ApiItem, item: CaseItem, index: number): HTMLElement {
  const box = el("div", "case");
  box.dataset.caseBox = item.id;
  const head = el("div", "case-head");
  const title = el("span", "title", caseTitle(item.content, index));
  const env = el("span", "env");
  const updated = el("span", "updated");
  const paintMeta = () => {
    const matched = envFor(item.content, system.links);
    const host = hostOf(item.content);
    env.replaceChildren();
    if (matched) {
      env.append(el("i", "dot"), document.createTextNode(matched.label));
      env.title = normalizeHost(matched.host);
    } else if (host) {
      env.textContent = host.replace(/^https?:\/\//, "");
      env.title = host;
    }
    updated.textContent = ago(item.updatedAt);
    updated.title = fullTime(item.updatedAt);
  };
  paintMeta();

  const spacer = el("span", "spacer");
  const copy = button("复制", "", () => {
    void copyText(substitute(item.content, variablesFor(system))).then(() => {
      copy.textContent = "已复制";
      window.setTimeout(() => {
        copy.textContent = "复制";
      }, 1200);
    });
  });

  const envs = system.links.filter((link) => link.kind === "env");
  const copiedFor = (target: LinkItem) => {
    const replaced = substitute(item.content, variablesFor(system, target.id));
    return target.host ? swapHost(replaced, target.host) : replaced;
  };
  let copyTo: HTMLElement | null = null;
  if (envs.length === 1) {
    copyTo = button(`复制到 ${envs[0].label}`, "", () => {
      void copyText(copiedFor(envs[0])).then(() => notify(`已按 ${envs[0].label} 复制`));
    });
  } else if (envs.length > 1) {
    const wrap = el("span", "pop-wrap");
    const pop = el("div", "pop");
    pop.hidden = true;
    for (const target of envs) {
      const hostText = target.host ? normalizeHost(target.host).replace(/^https?:\/\//, "") : "用这个环境的变量";
      pop.append(
        button(`${target.label}  ${hostText}`, "item mono", () => {
          pop.hidden = true;
          void copyText(copiedFor(target)).then(() => notify(`已按 ${target.label} 复制`));
        }),
      );
    }
    wrap.append(
      button("复制到…", "", (event) => openPop(event.currentTarget as HTMLElement, pop)),
      pop,
    );
    copyTo = wrap;
  }

  const run = button(runs.get(item.id)?.running ? "停止" : "运行", "", () => void runCase(system, item));
  const format = button(formatBackup.has(item.id) ? "还原" : "格式化", "", () => {
    if (formatBackup.has(item.id)) {
      item.content = formatBackup.get(item.id) ?? item.content;
      formatBackup.delete(item.id);
    } else {
      const formatted = formatCurl(item.content);
      if (formatted === null) {
        notify("这条命令不是单条 curl，或引号没闭合，没有格式化");
        return;
      }
      if (formatted === item.content) {
        notify("已经是格式化的样子");
        return;
      }
      formatBackup.set(item.id, item.content);
      item.content = formatted;
    }
    touchCase(api, item);
    scheduleSave();
    renderDetail();
  });
  const structure = button(structureOpen.has(item.id) ? "隐藏结构" : "显示结构", "", () => {
    if (structureOpen.has(item.id)) {
      structureOpen.delete(item.id);
    } else {
      structureOpen.add(item.id);
    }
    renderDetail();
  });
  const duplicate = button("再写一条", "", () => {
    const copyItem: CaseItem = { id: uid(), content: item.content, updatedAt: Date.now() };
    api.cases.splice(index + 1, 0, copyItem);
    touchApi(api);
    showApi(api.id);
    scheduleSave();
    renderDetail();
    focusCase(copyItem.id);
  });
  const move = button("移动到…", "", () => moveCase(api, item));
  const remove = button("删除", "remove", () => {
    void confirmDelete("删除这条用例？").then((ok) => {
      if (!ok) {
        return;
      }
      api.cases = api.cases.filter((caseItem) => caseItem.id !== item.id);
      touchApi(api);
      scheduleSave();
      renderDetail();
    });
  });
  const moreWrap = el("span", "pop-wrap");
  const morePop = el("div", "pop");
  morePop.hidden = true;
  for (const node of [format, structure, duplicate, move, remove]) {
    node.classList.add("item");
    node.addEventListener("click", () => {
      morePop.hidden = true;
    });
    morePop.append(node);
  }
  moreWrap.append(
    button("⋯", "", (event) => openPop(event.currentTarget as HTMLElement, morePop), "更多"),
    morePop,
  );
  head.append(title, env, spacer, updated, copy);
  if (copyTo) {
    head.append(copyTo);
  }
  head.append(run, moreWrap);

  const wrap = el("div", structureOpen.has(item.id) ? "shell-wrap with-structure" : "shell-wrap");
  const view = el("div", "shell-view");
  const highlight = el("pre", "shell-highlight");
  const area = el("textarea", "shell-input");
  area.dataset.case = item.id;
  area.spellcheck = false;
  area.value = item.content;
  const paint = () => {
    highlight.innerHTML = highlightShell(area.value, definedVariables(system));
  };
  area.addEventListener("input", () => {
    item.content = area.value;
    formatBackup.delete(item.id);
    format.textContent = "格式化";
    touchCase(api, item);
    title.textContent = caseTitle(item.content, index);
    paintMeta();
    paint();
    scheduleSave();
  });
  area.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      focusApiRow(api.id);
    }
  });
  paint();

  const varBar = el("div", "var-bar");
  varBar.hidden = true;
  const varName = el("input");
  varName.placeholder = "变量名，如 token";
  const varOk = button("设为变量", "primary", () => {
    const selected = area.value.slice(area.selectionStart, area.selectionEnd);
    makeVariable(system, selected, varName.value);
  });
  varName.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      varOk.click();
    }
    if (event.key === "Escape") {
      varBar.hidden = true;
      area.focus();
    }
  });
  const varHint = el("span", "hint");
  varBar.append(varHint, varName, varOk);
  const checkSelection = () => {
    const selected = area.value.slice(area.selectionStart, area.selectionEnd);
    const usable = selected.length >= 3 && !selected.includes("\n");
    varBar.hidden = !usable;
    if (usable) {
      varHint.textContent = `选中「${selected.length > 24 ? `${selected.slice(0, 24)}…` : selected}」`;
    }
  };
  area.addEventListener("select", checkSelection);
  area.addEventListener("mouseup", checkSelection);
  area.addEventListener("keyup", checkSelection);
  area.addEventListener("blur", () => {
    window.setTimeout(() => {
      if (document.activeElement === area || varBar.contains(document.activeElement)) {
        return;
      }
      varBar.hidden = true;
      if (area.value.trim() || !api.cases.some((caseItem) => caseItem.id === item.id)) {
        return;
      }
      const focusId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.case ?? "" : "";
      api.cases = api.cases.filter((caseItem) => caseItem.id !== item.id);
      touchApi(api);
      scheduleSave();
      renderDetail();
      if (focusId) {
        focusCase(focusId);
      }
    }, 150);
  });

  view.append(highlight, area);
  wrap.append(view);
  if (structureOpen.has(item.id)) {
    wrap.append(renderStructure(substitute(item.content, variablesFor(system))));
  }
  box.append(head, varBar, wrap, renderRunPanel(item));
  return box;
}

function renderStructure(content: string): HTMLElement {
  const panel = el("div", "structure");
  const parsed = parseStructure(content);
  if ("error" in parsed) {
    panel.append(el("p", "error", parsed.error));
    return panel;
  }
  const line = el("div", "line");
  line.append(el("span", `method method-${parsed.method.toLowerCase()}`, parsed.method), el("code", "", parsed.url));
  panel.append(line);
  if (parsed.query.length > 0) {
    panel.append(el("h4", "", "查询参数"), pairsTable(parsed.query));
  }
  if (parsed.headers.length > 0) {
    panel.append(el("h4", "", "请求头"), pairsTable(parsed.headers));
  }
  if (parsed.body) {
    panel.append(el("h4", "", parsed.bodyJson ? "请求体 JSON" : "请求体"));
    panel.append(el("pre", "", parsed.bodyJson ?? parsed.body));
  }
  return panel;
}

function pairsTable(pairs: Array<[string, string]>): HTMLElement {
  const table = el("table");
  for (const [key, value] of pairs) {
    const tr = el("tr");
    tr.append(el("th", "", key), el("td", "", value));
    table.append(tr);
  }
  return table;
}

function focusCase(caseId: string) {
  const area = detail.querySelector(`[data-case="${caseId}"]`) as HTMLTextAreaElement | null;
  area?.focus();
}

/* 运行 */

async function runCase(system: SystemItem, item: CaseItem) {
  const current = runs.get(item.id);
  if (current?.running) {
    void stopCommand(current.runId);
    return;
  }
  const command = substitute(item.content, variablesFor(system)).trim();
  if (!command) {
    notify("用例是空的");
    return;
  }
  const runId = uid();
  runs.set(item.id, { runId, running: true });
  paintRunPanel(item);
  try {
    const result = await runCommand(runId, command);
    runs.set(item.id, { runId, running: false, result });
  } catch (error) {
    runs.set(item.id, { runId, running: false, error: String(error) });
  }
  paintRunPanel(item);
}

function paintRunPanel(item: CaseItem) {
  const existing = detail.querySelector(`[data-result="${item.id}"]`);
  const next = renderRunPanel(item);
  if (existing) {
    existing.replaceWith(next);
  }
  const box = detail.querySelector(`[data-case-box="${item.id}"]`);
  const headButtons = box?.querySelectorAll<HTMLButtonElement>(".case-head button") ?? [];
  for (const node of headButtons) {
    if (node.textContent === "运行" || node.textContent === "停止") {
      node.textContent = runs.get(item.id)?.running ? "停止" : "运行";
    }
  }
}

function renderRunPanel(item: CaseItem): HTMLElement {
  const panel = el("div", "run-panel");
  panel.dataset.result = item.id;
  const state = runs.get(item.id);
  if (!state) {
    panel.hidden = true;
    return panel;
  }
  const head = el("div", "run-head");
  if (state.running) {
    head.append(el("span", "status running", "运行中…"));
    panel.append(head);
    return panel;
  }
  if (state.error) {
    head.append(el("span", "status bad", state.error));
    panel.append(head);
    return panel;
  }
  const result = state.result;
  if (!result) {
    panel.hidden = true;
    return panel;
  }
  const ok = result.code === 0;
  head.append(
    el("span", `status ${ok ? "good" : "bad"}`, result.timedOut ? "超时" : result.killed ? "已停止" : `退出码 ${result.code ?? "?"}`),
    el("span", "meta", `${result.millis} ms`),
    el("span", "meta", `${formatBytes(result.stdout.length)}`),
    el("span", "spacer"),
  );
  let pretty = result.stdout;
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      pretty = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      pretty = result.stdout;
    }
  }
  head.append(
    button("复制结果", "ghost", () => void copyText(pretty).then(() => notify("已复制结果"))),
    button("清空", "ghost", () => {
      runs.delete(item.id);
      paintRunPanel(item);
    }),
  );
  panel.append(head);
  panel.append(el("pre", "stdout", pretty || "(无输出)"));
  if (result.stderr.trim()) {
    const details = el("details");
    details.append(el("summary", "", "stderr"), el("pre", "stderr", result.stderr));
    panel.append(details);
  }
  return panel;
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/* 移动 */

interface PickItem {
  key: string;
  label: string;
  detail: string;
  method?: string;
  onPick: () => void;
}

function moveCase(api: ApiItem, item: CaseItem) {
  const items: PickItem[] = [];
  for (const targetSystem of library.systems) {
    for (const target of targetSystem.apis) {
      if (target.id === api.id) {
        continue;
      }
      items.push({
        key: target.id,
        label: `${target.path}`,
        detail: targetSystem.name,
        method: target.method,
        onPick: () => {
          api.cases = api.cases.filter((caseItem) => caseItem.id !== item.id);
          target.cases.push(item);
          touchApi(api);
          touchCase(target, item);
          scheduleSave();
          jumpToApi(targetSystem.id, target.id);
          notify(`已移动到 ${target.method} ${target.path}`);
        },
      });
    }
  }
  openPicker("把这条用例移动到哪个接口", items);
}

function moveApi(system: SystemItem, api: ApiItem) {
  const items: PickItem[] = library.systems
    .filter((target) => target.id !== system.id)
    .map((target) => ({
      key: target.id,
      label: target.name,
      detail: target.domain,
      onPick: () => {
        system.apis = system.apis.filter((item) => item.id !== api.id);
        const existing = target.apis.find((item) => item.method === api.method && item.path === api.path);
        if (existing) {
          for (const item of api.cases) {
            if (!existing.cases.some((caseItem) => caseItem.content === item.content)) {
              existing.cases.push(item);
            }
          }
          touchApi(existing);
          scheduleSave();
          jumpToApi(target.id, existing.id);
          notify(`已并入 ${target.name} 的 ${existing.method} ${existing.path}`);
          return;
        }
        target.apis.push(api);
        touchApi(api);
        scheduleSave();
        jumpToApi(target.id, api.id);
        notify(`已移动到 ${target.name}`);
      },
    }));
  openPicker("把这条接口移动到哪个系统", items);
}

/* 命令面板 */

const palette = document.querySelector("#palette") as HTMLElement;
const paletteInput = document.querySelector("#palette-input") as HTMLInputElement;
const paletteList = document.querySelector("#palette-list") as HTMLElement;
let paletteItems: PickItem[] = [];
let paletteIndex = 0;
let paletteRecentKey = "";

function jumpItems(): PickItem[] {
  const items: PickItem[] = [];
  for (const system of library.systems) {
    items.push({
      key: `s:${system.id}`,
      label: system.name,
      detail: system.domain || "其他",
      onPick: () => {
        selectSystem(system.id);
        resetOpenState();
        render();
      },
    });
    for (const api of system.apis) {
      const titles = api.cases.map((item, index) => (hasTitle(item.content) ? caseTitle(item.content, index) : "")).filter(Boolean);
      items.push({
        key: `a:${api.id}`,
        label: api.path,
        detail: [system.name, ...titles].join(" · "),
        method: api.method,
        onPick: () => jumpToApi(system.id, api.id),
      });
    }
  }
  return items;
}

function openPalette() {
  paletteRecentKey = "palette-recent";
  openPicker("", jumpItems());
}

function openPicker(placeholder: string, items: PickItem[]) {
  if (placeholder) {
    paletteRecentKey = "";
  }
  closePops();
  paletteItems = items;
  paletteInput.placeholder = placeholder || "输入系统名、路径或用例标题，支持 post: path: sys: # 前缀";
  paletteInput.value = "";
  paletteIndex = 0;
  palette.hidden = false;
  paintPalette();
  paletteInput.focus();
}

function closePalette() {
  palette.hidden = true;
  paletteItems = [];
}

function filteredPalette(): PickItem[] {
  const parsed = parseQuery(paletteInput.value);
  const recent = paletteRecentKey ? readList(paletteRecentKey) : [];
  const scored = paletteItems
    .map((item) => {
      if (parsed.method && (item.method ?? "").toLowerCase() !== parsed.method) {
        return { item, score: 0 };
      }
      if (parsed.sys && !item.detail.toLowerCase().includes(parsed.sys) && !item.label.toLowerCase().includes(parsed.sys)) {
        return { item, score: 0 };
      }
      if (parsed.path && !item.label.toLowerCase().includes(parsed.path)) {
        return { item, score: 0 };
      }
      if (parsed.title && !item.detail.toLowerCase().includes(parsed.title)) {
        return { item, score: 0 };
      }
      const text = `${item.method ?? ""} ${item.label} ${item.detail}`;
      const score = parsed.text ? fuzzyScore(text, parsed.text) : 1;
      const recentBoost = recent.includes(item.key) ? 5000 - recent.indexOf(item.key) : 0;
      return { item, score: score > 0 ? score + recentBoost : 0 };
    })
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);
  return scored.slice(0, 20).map((entry) => entry.item);
}

function paintPalette() {
  paletteList.replaceChildren();
  const items = filteredPalette();
  if (paletteIndex >= items.length) {
    paletteIndex = Math.max(0, items.length - 1);
  }
  if (items.length === 0) {
    paletteList.append(el("li", "empty", "没有匹配"));
    return;
  }
  items.forEach((item, index) => {
    const li = el("li", index === paletteIndex ? "active" : "");
    if (item.method) {
      li.append(el("span", `method method-${item.method.toLowerCase()}`, item.method));
    }
    li.append(el("span", "label", item.label), el("span", "detail", item.detail));
    li.addEventListener("mousemove", () => {
      if (paletteIndex !== index) {
        paletteIndex = index;
        paintPalette();
      }
    });
    li.addEventListener("click", () => pickPalette(item));
    paletteList.append(li);
  });
  paletteList.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
}

function pickPalette(item: PickItem) {
  if (paletteRecentKey) {
    writeList(paletteRecentKey, [item.key, ...readList(paletteRecentKey).filter((key) => key !== item.key)].slice(0, 10));
  }
  closePalette();
  item.onPick();
}

function initPalette() {
  paletteInput.addEventListener("input", () => {
    paletteIndex = 0;
    paintPalette();
  });
  paletteInput.addEventListener("keydown", (event) => {
    const items = filteredPalette();
    if (event.key === "ArrowDown") {
      event.preventDefault();
      paletteIndex = Math.min(items.length - 1, paletteIndex + 1);
      paintPalette();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      paletteIndex = Math.max(0, paletteIndex - 1);
      paintPalette();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[paletteIndex];
      if (item) {
        pickPalette(item);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    }
  });
  palette.addEventListener("click", (event) => {
    if (event.target === palette) {
      closePalette();
    }
  });

  yapiForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitYapi();
  });
  document.querySelector("#yapi-cancel")?.addEventListener("click", closeYapiDialog);
  yapiDialog.addEventListener("click", (event) => {
    if (event.target === yapiDialog) {
      closeYapiDialog();
    }
  });
  yapiDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeYapiDialog();
    }
  });
}

/* 导入导出 */

async function onImport() {
  await flush();
  const dir = await pickDirectory();
  if (!dir) {
    return;
  }
  notify("正在导入", true);
  try {
    epoch += 1;
    library = await importMarkdown(dir);
    if (!library.systems.some((system) => system.id === selectedId)) {
      selectSystem(library.systems[0]?.id ?? "");
    }
    resetOpenState();
    hideToast();
    notify(`导入完成，当前 ${library.systems.length} 个系统`);
    setSaveState("saved");
    render();
  } catch (error) {
    notify(`导入失败：${String(error)}`, true);
  }
}

/* YApi 导入 */

const yapiDialog = document.querySelector("#yapi") as HTMLElement;
const yapiForm = document.querySelector("#yapi-form") as HTMLFormElement;
const yapiTarget = document.querySelector("#yapi-target") as HTMLElement;
let yapiSystemId = "";

interface YapiConfig {
  base: string;
  token: string;
  host: string;
}

function yapiConfig(system: SystemItem): YapiConfig {
  const saved = JSON.parse(localStorage.getItem(`yapi-${system.id}`) ?? "null") as YapiConfig | null;
  const link = system.links.find((item) => /yapi/i.test(item.url));
  let base = saved?.base ?? localStorage.getItem("yapi-base") ?? "";
  if (!base && link) {
    try {
      base = new URL(link.url).origin;
    } catch {
      base = "";
    }
  }
  return { base, token: saved?.token ?? "", host: saved?.host ?? "" };
}

function openYapiDialog(system: SystemItem) {
  closePops();
  yapiSystemId = system.id;
  yapiTarget.textContent = system.name || "未命名";
  const config = yapiConfig(system);
  (yapiForm.elements.namedItem("base") as HTMLInputElement).value = config.base;
  (yapiForm.elements.namedItem("token") as HTMLInputElement).value = config.token;
  (yapiForm.elements.namedItem("host") as HTMLInputElement).value = config.host;
  yapiDialog.hidden = false;
  (yapiForm.elements.namedItem(config.base ? "token" : "base") as HTMLInputElement).focus();
}

function closeYapiDialog() {
  yapiDialog.hidden = true;
  yapiSystemId = "";
}

async function submitYapi() {
  const system = library.systems.find((item) => item.id === yapiSystemId);
  if (!system) {
    closeYapiDialog();
    return;
  }
  const data = new FormData(yapiForm);
  const config: YapiConfig = {
    base: String(data.get("base") ?? "").trim(),
    token: String(data.get("token") ?? "").trim(),
    host: String(data.get("host") ?? "").trim(),
  };
  const submit = document.querySelector("#yapi-submit") as HTMLButtonElement;
  submit.disabled = true;
  submit.textContent = "正在拉取…";
  try {
    const project = await importYapi(config.base, config.token, config.host);
    localStorage.setItem(`yapi-${system.id}`, JSON.stringify(config));
    localStorage.setItem("yapi-base", config.base);
    const { added, skipped, envs } = mergeYapi(system, project);
    closeYapiDialog();
    scheduleSave();
    render();
    notify(`YApi「${project.name}」：新增 ${added} 个接口，跳过已有 ${skipped} 个${envs ? `，补充 ${envs} 个环境` : ""}`);
  } catch (error) {
    notify(`YApi 导入失败：${String(error)}`, true);
  } finally {
    submit.disabled = false;
    submit.textContent = "导入";
  }
}

function mergeYapi(system: SystemItem, project: { envs: LinkItem[]; apis: ApiItem[] }) {
  const existing = new Set(system.apis.map(normalizedKey));
  const fresh = new Map<string, ApiItem>();
  let added = 0;
  let skipped = 0;
  for (const api of project.apis) {
    const key = normalizedKey(api);
    if (existing.has(key)) {
      skipped += 1;
      continue;
    }
    const twin = fresh.get(key);
    if (twin) {
      twin.cases.push(...api.cases.filter((item) => !twin.cases.some((other) => other.content === item.content)));
      continue;
    }
    fresh.set(key, api);
    system.apis.push(api);
    added += 1;
  }
  let envs = 0;
  for (const env of project.envs) {
    const hostKey = normalizeHost(env.host);
    const duplicate = system.links.some(
      (link) => link.kind === "env" && (link.label === env.label || (link.host && normalizeHost(link.host) === hostKey)),
    );
    if (!duplicate) {
      system.links.push(env);
      envs += 1;
    }
  }
  return { added, skipped, envs };
}

async function exportSystem(system: SystemItem) {
  const path = await pickSavePath(`${system.name || "system"}.md`, "md");
  if (!path) {
    return;
  }
  try {
    await exportSystemMarkdown(path, JSON.parse(JSON.stringify(system)) as SystemItem);
    notify(`已导出到 ${path}`);
  } catch (error) {
    notify(`导出失败：${String(error)}`, true);
  }
}

async function backupAll() {
  await flush();
  const stamp = new Date().toISOString().slice(0, 10);
  const path = await pickSavePath(`openapibook-${stamp}.json`, "json");
  if (!path) {
    return;
  }
  try {
    await backupLibrary(path);
    notify(`已备份到 ${path}`);
  } catch (error) {
    notify(`备份失败：${String(error)}`, true);
  }
}

async function restoreAll() {
  const path = await pickJsonFile();
  if (!path) {
    return;
  }
  const ok = await confirmAction("恢复会用备份覆盖当前全部数据。当前数据会先自动备份到 backups/。继续？", "从备份恢复");
  if (!ok) {
    return;
  }
  try {
    epoch += 1;
    library = await restoreLibrary(path);
    selectSystem(library.systems[0]?.id ?? "");
    resetOpenState();
    setSaveState("saved");
    render();
    notify(`已恢复，当前 ${library.systems.length} 个系统`);
  } catch (error) {
    notify(`恢复失败：${String(error)}`, true);
  }
}

/* 弹层 */

interface MenuField extends HTMLElement {
  setValue: (value: string) => void;
}

function menuField(options: Array<{ value: string; label: string }>, value: string, onPick: (value: string) => void): MenuField {
  const wrap = el("span", "pop-wrap menu-field") as MenuField;
  const trigger = button("", "menu-trigger", (event) => openPop(event.currentTarget as HTMLElement, pop));
  const pop = el("div", "pop menu-pop");
  pop.hidden = true;
  let current = value;
  const items = options.map((option) => {
    const item = button(option.label, "item", () => {
      pop.hidden = true;
      if (option.value === current) {
        return;
      }
      current = option.value;
      paint();
      onPick(option.value);
    });
    pop.append(item);
    return item;
  });
  const paint = () => {
    trigger.textContent = options.find((option) => option.value === current)?.label ?? "";
    items.forEach((item, index) => item.classList.toggle("on", options[index].value === current));
  };
  wrap.setValue = (next) => {
    current = next;
    paint();
  };
  paint();
  wrap.append(trigger, pop);
  return wrap;
}

function closePops(except?: HTMLElement) {
  document.querySelectorAll<HTMLElement>(".pop").forEach((pop) => {
    if (pop !== except) {
      pop.hidden = true;
    }
  });
}

function openPop(anchor: HTMLElement, pop: HTMLElement) {
  closePops(pop);
  const opening = pop.hidden;
  pop.hidden = !opening;
  if (!opening) {
    return;
  }
  pop.style.position = "fixed";
  pop.style.right = "auto";
  pop.style.zIndex = "60";
  const rect = anchor.getBoundingClientRect();
  const margin = 8;
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  const left = Math.max(margin, Math.min(rect.right - width, window.innerWidth - width - margin));
  let top = rect.bottom + 6;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - 6);
  }
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

/* 外观与 curl 样式 */

const colorInput = document.querySelector("#curl-bg") as HTMLInputElement;
const sizeInput = document.querySelector("#curl-size") as HTMLInputElement;
const systemDark = window.matchMedia("(prefers-color-scheme: dark)");

function isLightColor(color: string): boolean {
  const hex = color.trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return false;
  }
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  return (red * 299 + green * 587 + blue * 114) / 1000 > 160;
}

function clampSize(value: number): number {
  return Number.isFinite(value) ? Math.min(32, Math.max(12, Math.round(value))) : DEFAULT_FONT_SIZE;
}

function applyCurlStyle(background: string, fontSize: number) {
  const root = document.documentElement;
  root.style.setProperty("--curl-bg", background);
  root.style.setProperty("--curl-font-size", `${fontSize}px`);
  root.classList.toggle("curl-light", isLightColor(background));
  colorInput.value = background;
  sizeInput.value = String(fontSize);
  localStorage.setItem("curl-bg", background);
  localStorage.setItem("curl-font-size", String(fontSize));
}

function currentSize(): number {
  return clampSize(Number(sizeInput.value));
}

function applyTheme(theme: Theme) {
  const effective = theme === "system" ? (systemDark.matches ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = effective;
  localStorage.setItem("theme", theme);
  document.querySelectorAll<HTMLButtonElement>("#theme button").forEach((node) => {
    node.classList.toggle("active", node.dataset.theme === theme);
  });
}

function storedTheme(): Theme {
  const value = localStorage.getItem("theme");
  return value === "light" || value === "dark" ? value : "system";
}

function initAppearance() {
  applyTheme(storedTheme());
  systemDark.addEventListener("change", () => {
    if (storedTheme() === "system") {
      applyTheme("system");
    }
  });
  document.querySelectorAll<HTMLButtonElement>("#theme button").forEach((node) => {
    node.addEventListener("click", () => applyTheme((node.dataset.theme as Theme) ?? "system"));
  });

  applyCurlStyle(localStorage.getItem("curl-bg") || DEFAULT_CURL_BG, clampSize(Number(localStorage.getItem("curl-font-size") ?? DEFAULT_FONT_SIZE)));
  colorInput.addEventListener("input", () => applyCurlStyle(colorInput.value, currentSize()));
  sizeInput.addEventListener("change", () => applyCurlStyle(colorInput.value, currentSize()));
  document.querySelector("#curl-bg-reset")?.addEventListener("click", () => applyCurlStyle(DEFAULT_CURL_BG, currentSize()));
  document.querySelector("#curl-size-down")?.addEventListener("click", () => applyCurlStyle(colorInput.value, clampSize(currentSize() - 1)));
  document.querySelector("#curl-size-up")?.addEventListener("click", () => applyCurlStyle(colorInput.value, clampSize(currentSize() + 1)));

  const settings = document.querySelector("#settings") as HTMLElement;
  document.querySelector("#settings-toggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    closePops(settings);
    settings.hidden = !settings.hidden;
  });
  settings.addEventListener("click", (event) => event.stopPropagation());
  document.querySelector("#ask-ok")?.addEventListener("click", () => finishAsk(true));
  document.querySelector("#ask-cancel")?.addEventListener("click", () => finishAsk(false));
  document.querySelector("#ask")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) {
      finishAsk(false);
    }
  });
  document.addEventListener("keydown", (event) => {
    const ask = document.querySelector("#ask") as HTMLElement | null;
    if (!ask || ask.hidden) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finishAsk(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      finishAsk(true);
    }
  });
  document.addEventListener("click", () => closePops());
  detail.addEventListener("scroll", () => closePops(), { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePops();
    }
  });

  const dataDir = document.querySelector("#data-dir") as HTMLElement;
  void dataDirPath()
    .then((path) => {
      dataDir.textContent = path;
      dataDir.title = path;
    })
    .catch(() => {
      dataDir.textContent = "";
    });
  document.querySelector("#open-data-dir")?.addEventListener("click", () => {
    void openDataDir().catch((error: unknown) => notify(`打不开目录：${String(error)}`, true));
  });
  document.querySelector("#backup-all")?.addEventListener("click", () => {
    settings.hidden = true;
    void backupAll();
  });
  document.querySelector("#restore-all")?.addEventListener("click", () => {
    settings.hidden = true;
    void restoreAll();
  });
}

/* 菜单 */

function focusSearch() {
  search.focus();
  search.select();
}

const SHORTCUTS = [
  "⌘K  聚焦搜索框，↑↓ 在结果里定位，↵ 进入",
  "⌘P  快速跳转",
  "⌘S  立刻保存",
  "⌘⇧I  导入 Markdown",
  "⌘= / ⌘-  放大缩小 curl 字号",
  "⌘⇧E / ⌘⇧W  全部展开 / 全部收起",
  "⌘↵  在粘贴框里添加接口",
  "接口行：↑↓ 移动，→ 展开，← 收起，↵ 进入第一个用例，⌘C 复制路径",
  "用例框：Esc 回到接口行",
  "搜索前缀：post:  path:  sys:  #标题",
].join("\n");

function handleMenu(id: string) {
  switch (id) {
    case "import":
      void onImport();
      break;
    case "import-yapi": {
      const system = selectedSystem();
      if (system) {
        openYapiDialog(system);
      } else {
        notify("先选一个系统");
      }
      break;
    }
    case "save":
      void flush();
      break;
    case "export-system": {
      const system = selectedSystem();
      if (system) {
        void exportSystem(system);
      } else {
        notify("先选择一个系统");
      }
      break;
    }
    case "backup":
      void backupAll();
      break;
    case "restore":
      void restoreAll();
      break;
    case "open-data-dir":
      void openDataDir().catch((error: unknown) => notify(`打不开目录：${String(error)}`, true));
      break;
    case "search":
      focusSearch();
      break;
    case "palette":
      openPalette();
      break;
    case "font-bigger":
      applyCurlStyle(colorInput.value, clampSize(currentSize() + 1));
      break;
    case "font-smaller":
      applyCurlStyle(colorInput.value, clampSize(currentSize() - 1));
      break;
    case "expand-all":
      expandAll();
      break;
    case "collapse-all":
      collapseAll();
      break;
    case "shortcuts":
      void showMessage(SHORTCUTS, "快捷键");
      break;
    case "about":
      void showMessage("OpenApi 0.1.0\n本地整理 HTTP 接口的手册。数据保存在本机 SQLite。");
      break;
    default:
      break;
  }
}

/* 启动 */

function init() {
  initAppearance();
  initPalette();
  onMenu(handleMenu);

  const config = document.querySelector("#config") as HTMLElement;
  document.querySelector("#config-toggle")?.addEventListener("click", () => setConfigOpen(!configOpen));
  config.addEventListener("click", (event) => {
    if (event.target === config) {
      setConfigOpen(false);
    }
  });
  config.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement)) {
      setConfigOpen(false);
    }
  });
  search.addEventListener("keydown", onSearchKey);
  search.addEventListener("input", () => {
    query = parseQuery(search.value);
    sidebarCursor = "";
    closedApiIds.clear();
    if (query.empty) {
      openApiIds.clear();
    }
    render();
  });
  document.querySelector("#import")?.addEventListener("click", () => {
    void onImport();
  });
  document.querySelector("#add-system")?.addEventListener("click", () => openSystemDialog());
  const systemDialog = document.querySelector("#system-dialog") as HTMLElement;
  const systemForm = document.querySelector("#system-form") as HTMLFormElement;
  systemForm.addEventListener("submit", (event) => {
    event.preventDefault();
    submitSystem(systemForm);
  });
  systemForm.querySelector("input[name=domain]")?.addEventListener("input", () => {
    if ((systemForm.elements.namedItem("domain") as HTMLInputElement).value.trim()) {
      pickedDomain = "";
      paintDomainPicks();
    }
  });
  document.querySelector("#system-cancel")?.addEventListener("click", () => closeSystemDialog());
  systemDialog.addEventListener("click", (event) => {
    if (event.target === systemDialog) {
      closeSystemDialog();
    }
  });
  systemDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSystemDialog();
    }
  });
  document.addEventListener("copy", (event) => {
    const system = selectedSystem();
    if (!system) {
      return;
    }
    const active = document.activeElement;
    let text = "";
    if (active instanceof HTMLTextAreaElement || (active instanceof HTMLInputElement && active.type !== "password")) {
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? 0;
      if (end > start) {
        text = active.value.slice(start, end);
      }
    }
    if (!text) {
      text = window.getSelection()?.toString() ?? "";
    }
    if (!text.includes("{{")) {
      return;
    }
    const replaced = substitute(text, variablesFor(system));
    if (replaced === text) {
      return;
    }
    event.preventDefault();
    event.clipboardData?.setData("text/plain", replaced);
    void copyText(replaced);
  });
  document.addEventListener("keydown", (event) => {
    if (!(event.metaKey || event.ctrlKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "k") {
      event.preventDefault();
      focusSearch();
    } else if (key === "p") {
      event.preventDefault();
      openPalette();
    } else if (key === "s") {
      event.preventDefault();
      void flush();
    }
  });

  void loadLibrary()
    .then((loaded) => {
      library = loaded;
      const saved = localStorage.getItem("selected-system-id") ?? "";
      selectSystem(library.systems.some((system) => system.id === saved) ? saved : library.systems[0]?.id ?? "");
      setSaveState("saved");
      render();
    })
    .catch((error: unknown) => {
      notify(`读取失败：${String(error)}`, true);
      render();
    });
}

init();
