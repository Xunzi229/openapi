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
  appendLog,
  loadLibrary,
  onMenu,
  openDataDir,
  openLink,
  parseCurl,
  pickDirectory,
  pickJsonFile,
  pickSavePath,
  queryLogs,
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
  curlCommands,
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
  pathOf,
  replaceCurlPath,
  substitute,
  swapHost,
  type Query,
} from "./curl";
import type { ApiItem, CaseItem, Library, LinkItem, LogEntry, RunResult, SystemItem, VariableItem } from "./types";

const DOMAIN_ORDER = ["计划", "供应链", "采购", "风控", "商品", "PMS", "实验", "算法", "集成测试", "其他"];
const DEFAULT_CURL_BG = "#17211d";
const DEFAULT_FONT_SIZE = 16;
const RECENT_LIMIT = 5;

type Theme = "system" | "light" | "dark";

interface RunState {
  runId: string;
  running: boolean;
  index: number;
  result?: RunResult;
  error?: string;
}

let library: Library = { systems: [] };
let selectedId = "";
let domainView = "";
let logView = false;
let logCategory = "";
let logKeyword = "";
let logRows: LogEntry[] = [];
let logOpenId = 0;
let logLoading = false;
let logSeq = 0;
let logTimer = 0;
const skipCaseLog = new Set<string>();
const openApiIds = new Set<string>();
const closedApiIds = new Set<string>();
let query: Query = parseQuery("");
let saveTimer = 0;
let toastTimer = 0;
let epoch = 0;
let editingRow = "";
let sidebarCursor = "";
let methodFilter = "";
let groupFilter: string | null = null;
let groupsOpen = true;
let creatingGroup = false;
let focusGroupCreate = false;
const isApple = /Mac|iPhone|iPad/.test(navigator.platform);
const modLabel = isApple ? "⌘" : "Ctrl";
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
  const body = document.querySelector("#toast-text") as HTMLElement;
  const close = document.querySelector("#toast-close") as HTMLButtonElement;
  body.textContent = text.replace(/([?&]token=)[^&\s]+/gi, "$1***");
  close.hidden = !sticky;
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

document.querySelector("#toast-close")?.addEventListener("click", () => hideToast());

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

type LogCategory = "create" | "update" | "delete" | "run";

function recordLog(entry: {
  category: LogCategory;
  action: string;
  system?: SystemItem;
  api?: ApiItem;
  target?: string;
  detail?: string;
  result?: string;
}) {
  const target = entry.target ?? (entry.api ? `${entry.api.method} ${entry.api.path}` : (entry.system?.name ?? ""));
  void appendLog({
    category: entry.category,
    action: entry.action,
    systemId: entry.system?.id ?? "",
    systemName: entry.system?.name ?? "",
    apiId: entry.api?.id ?? "",
    target,
    detail: entry.detail ?? "",
    result: entry.result ?? "",
  })
    .then(() => {
      if (logView) {
        void loadLogs();
      }
    })
    .catch(() => {});
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
  if (id) {
    domainView = "";
    logView = false;
  }
  if (id !== selectedId) {
    methodFilter = "";
    groupFilter = null;
    creatingGroup = false;
    groupsOpen = true;
  }
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

function domainOrder(): string[] {
  const saved = readList("domain-order");
  return saved.length > 0 ? saved : [...DOMAIN_ORDER];
}

function rank(domain: string): number {
  const order = domainOrder();
  const index = order.indexOf(domain);
  if (index !== -1) {
    return index;
  }
  const preset = DOMAIN_ORDER.indexOf(domain);
  return preset === -1 ? order.length + 1 : preset;
}

function renameDomain(from: string, to: string) {
  const next = to.trim();
  if (!next || next === from || from === "最近" || from === "收藏") {
    return;
  }
  let count = 0;
  for (const system of library.systems) {
    if ((system.domain || "其他") === from) {
      system.domain = next;
      count += 1;
    }
  }
  if (count === 0) {
    return;
  }
  const collapsed = readCollapsed();
  if (collapsed.delete(from)) {
    collapsed.add(next);
    writeList("collapsed-domains", [...collapsed]);
  }
  const order = domainOrder();
  const fromIndex = order.indexOf(from);
  const toIndex = order.indexOf(next);
  if (fromIndex >= 0 && toIndex === -1) {
    order[fromIndex] = next;
  } else if (fromIndex >= 0) {
    order.splice(fromIndex, 1);
  } else if (toIndex === -1) {
    order.push(next);
  }
  writeList("domain-order", order);
  if (domainView === from) {
    domainView = next;
  }
  scheduleSave();
}

async function deleteDomain(domain: string) {
  if (domain === "最近" || domain === "收藏" || domain === "其他") {
    return;
  }
  const members = library.systems.filter((system) => (system.domain || "其他") === domain);
  const ok = await confirmDelete(`删除业务域「${domain}」？其中 ${members.length} 个系统会归到「其他」，系统不会删。`);
  if (!ok) {
    return;
  }
  for (const system of members) {
    system.domain = "其他";
  }
  const collapsed = readCollapsed();
  collapsed.delete(domain);
  writeList("collapsed-domains", [...collapsed]);
  const order = domainOrder();
  const index = order.indexOf(domain);
  if (index >= 0) {
    order.splice(index, 1);
  }
  if (!order.includes("其他")) {
    order.push("其他");
  }
  writeList("domain-order", order);
  if (domainView === domain) {
    domainView = "其他";
  }
  scheduleSave();
  render();
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
  const applyMethod = (apis: ApiItem[]) => {
    if (methodFilter === "star") {
      return apis.filter((api) => api.starred);
    }
    return methodFilter ? apis.filter((api) => api.method.toLowerCase() === methodFilter) : apis;
  };
  const applyGroup = (apis: ApiItem[]) => (groupFilter === null ? apis : apis.filter((api) => groupName(api) === groupFilter));
  const apis = sortedApis(system);
  if (!searching()) {
    return applyGroup(applyMethod(apis));
  }
  const hits = apis.filter(apiMatches);
  if (hits.length > 0) {
    return applyGroup(applyMethod(hits));
  }
  return applyGroup(applyMethod(systemTextMatches(system) || (query.sys && !(query.method || query.path || query.title || query.text)) ? apis : []));
}

function syncSelection() {
  if (!searching() || domainView || logView) {
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
    groups: [],
    color: "",
    links: [],
    variables: [],
    apis: [],
  };
  library.systems.push(system);
  selectSystem(system.id);
  closeSystemDialog();
  recordLog({ category: "create", action: "新增系统", system });
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
  writeList(`api-groups:${system.id}`, []);
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
  ensureGroups(system);
  const names = [...system.groups];
  if (system.apis.some((api) => !groupName(api))) {
    names.push("");
  }
  writeList(`api-groups:${system.id}`, names);
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

function clearSidebarSearch() {
  if (!search.value) {
    return;
  }
  search.value = "";
  query = parseQuery("");
  sidebarCursor = "";
}

function revealSystem(system: SystemItem) {
  const domain = system.domain || "其他";
  if (readCollapsed().has(domain)) {
    toggleCollapsed(domain);
  }
}

function goToSystem(system: SystemItem) {
  clearSidebarSearch();
  methodFilter = "";
  groupFilter = null;
  revealSystem(system);
  openSystemPage(system);
}

function goToApi(system: SystemItem, api: ApiItem) {
  clearSidebarSearch();
  methodFilter = "";
  groupFilter = null;
  revealSystem(system);
  const collapsed = collapsedApiGroups(system.id);
  const name = groupName(api);
  if (collapsed.has(name)) {
    collapsed.delete(name);
    writeList(`api-groups:${system.id}`, [...collapsed]);
  }
  jumpToApi(system.id, api.id);
}

/* 渲染 */

function render() {
  syncSelection();
  renderSidebar();
  renderDetail();
}

function renderSidebar() {
  const scrollTop = systemList.scrollTop;
  systemList.replaceChildren();
  brandCount.textContent = `${library.systems.length} 个系统`;
  const visible = orderedSystems(library.systems.filter(matches));
  if (visible.length === 0) {
    systemList.append(el("p", "domain", library.systems.length === 0 ? "还没有系统" : "没有匹配的系统"));
    systemList.scrollTop = scrollTop;
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
          if (!domainView && groupsOpen && system.id === selectedId && collapsed.has(system.domain || "其他") && (system.groups.length > 0 || creatingGroup)) {
            group.append(systemGroupNav(system));
          }
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
        } else if (!domainView && groupsOpen && system.id === selectedId && (system.groups.length > 0 || creatingGroup)) {
          group.append(systemGroupNav(system));
        }
      }
    }
    systemList.append(group);
  }
  systemList.scrollTop = scrollTop;
}

function domainGroup(domain: string, count: number, folded: boolean): HTMLElement {
  const group = el("section", folded ? "group folded" : "group");
  const title = el("button", "domain");
  title.type = "button";
  const name = el("span", "", domain);
  const editable = domain !== "最近" && domain !== "收藏";
  title.append(el("i"), name, el("em", "", String(count)));
  if (domainView === domain) {
    title.classList.add("on");
  }
  title.addEventListener("click", (event) => {
    const onChevron = event.target instanceof Element && Boolean(event.target.closest("i"));
    if (onChevron || !editable) {
      toggleCollapsed(domain);
      renderSidebar();
      return;
    }
    showDomain(domain);
  });
  if (editable) {
    title.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openDomainActionMenu(event.clientX, event.clientY, group, domain);
    });
  }
  const row = el("div", "domain-row");
  row.append(title);
  group.append(row);
  return group;
}

function openDomainActionMenu(x: number, y: number, group: HTMLElement, domain: string) {
  let menu = document.getElementById("domain-menu");
  if (!menu) {
    menu = el("div", "pop");
    menu.id = "domain-menu";
    document.body.append(menu);
    menu.addEventListener("click", (event) => event.stopPropagation());
  }
  const items = [
    button("修改名称", "item", () => {
      menu!.hidden = true;
      editDomain(group, domain);
    }),
  ];
  if (domain !== "其他") {
    items.push(
      button("删除", "item danger", () => {
        menu!.hidden = true;
        void deleteDomain(domain);
      }),
    );
  }
  menu.replaceChildren(...items);
  closePops(menu);
  menu.hidden = false;
  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.zIndex = "60";
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
}

function editDomain(group: HTMLElement, domain: string) {
  const row = el("div", "domain-edit");
  const input = el("input");
  input.value = domain;
  input.spellcheck = false;
  row.append(input);
  group.querySelector("button.domain")?.replaceWith(row);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) {
      return;
    }
    done = true;
    if (save) {
      renameDomain(domain, input.value);
    }
    render();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function showDomain(domain: string) {
  if (domain === "最近" || domain === "收藏") {
    return;
  }
  logView = false;
  if (readCollapsed().has(domain)) {
    toggleCollapsed(domain);
  }
  domainView = domain;
  configOpen = false;
  render();
}

function openSystemPage(system: SystemItem) {
  const fromDomain = domainView !== "";
  selectSystem(system.id);
  if (fromDomain) {
    methodFilter = "";
    groupFilter = null;
    creatingGroup = false;
  }
  resetOpenState();
  groupsOpen = true;
  render();
}

function systemButton(system: SystemItem): HTMLButtonElement {
  ensureGroups(system);
  const hasGroups = system.groups.length > 0;
  const viewing = !domainView && system.id === selectedId;
  const open = viewing && hasGroups && groupsOpen && !searching();
  const node = el("button", viewing ? "system active" : "system");
  node.type = "button";
  node.classList.toggle("open", open);
  node.classList.toggle("flat", !hasGroups);
  node.dataset.key = `sys:${system.id}`;
  node.classList.toggle("kb", node.dataset.key === sidebarCursor);
  const label = el("span", "", system.name || "未命名");
  if (system.color) {
    label.style.color = system.color;
  }
  node.append(el("i"), label, el("em", "", String(system.apis.length)));
  node.addEventListener("click", (event) => {
    if (event.button !== 0 || event.ctrlKey) {
      event.stopPropagation();
      return;
    }
    if (domainView) {
      openSystemPage(system);
      return;
    }
    if (!hasGroups) {
      if (system.id !== selectedId) {
        openSystemPage(system);
      }
      return;
    }
    if (!searching() && system.id === selectedId) {
      groupsOpen = !groupsOpen;
      const refreshDetail = !groupsOpen && groupFilter !== null;
      if (!groupsOpen) {
        groupFilter = null;
        creatingGroup = false;
      }
      if (refreshDetail) {
        render();
      } else {
        renderSidebar();
      }
      return;
    }
    openSystemPage(system);
  });
  node.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSystemMenu(event.clientX, event.clientY, system);
  });
  return node;
}

let colorMenuTimer = 0;
let colorMenuHot = false;
const menuHover = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

const SYSTEM_COLORS: Array<[string, string]> = [
  ["#ff3b30", "红色"],
  ["#ff9500", "橙色"],
  ["#ffcc00", "黄色"],
  ["#34c759", "绿色"],
  ["#007aff", "蓝色"],
  ["#af52de", "紫色"],
  ["#8e8e93", "灰色"],
];

function pointerElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) {
    return target;
  }
  if (target instanceof Node) {
    return target.parentElement;
  }
  return null;
}

function hideColorMenu() {
  window.clearTimeout(colorMenuTimer);
  colorMenuTimer = 0;
  colorMenuHot = false;
  for (const id of ["system-color-menu", "system-domain-menu"]) {
    const menu = document.getElementById(id);
    if (menu) {
      menu.hidden = true;
    }
  }
  document.querySelectorAll("#system-menu .has-sub.open").forEach((node) => node.classList.remove("open"));
}

function closeSiblingFlyout(keepMenuId: string, anchor: HTMLElement) {
  for (const id of ["system-color-menu", "system-domain-menu"]) {
    if (id === keepMenuId) {
      continue;
    }
    const menu = document.getElementById(id);
    if (menu) {
      menu.hidden = true;
    }
  }
  document.querySelectorAll("#system-menu .has-sub.open").forEach((node) => {
    if (node !== anchor) {
      node.classList.remove("open");
    }
  });
}

function scheduleHideColorMenu() {
  window.clearTimeout(colorMenuTimer);
  colorMenuTimer = window.setTimeout(hideColorMenu, 120);
}

function paintSystemColor(system: SystemItem) {
  const color = system.color;
  const key = CSS.escape(system.id);
  document.querySelectorAll<HTMLElement>(`[data-key="sys:${key}"] > span`).forEach((node) => {
    node.style.color = color;
  });
  document.querySelectorAll<HTMLElement>(`.domain-system[data-id="${key}"] > b`).forEach((node) => {
    node.style.color = color;
  });
  if (system.id !== selectedId || domainView) {
    return;
  }
  const name = document.querySelector(".system-head .name") as HTMLElement | null;
  if (name) {
    name.style.color = color;
  }
}

function openSystemMenu(x: number, y: number, system: SystemItem) {
  let menu = document.querySelector("#system-menu") as HTMLElement | null;
  if (!menu) {
    menu = el("div", "pop");
    menu.id = "system-menu";
    document.body.append(menu);
    menu.addEventListener("click", (event) => event.stopPropagation());
    menu.addEventListener("pointerleave", (event) => {
      if (colorMenuHot || pointerElement(event.relatedTarget)?.closest("#system-color-menu, #system-domain-menu")) {
        return;
      }
      scheduleHideColorMenu();
    });
  }
  hideColorMenu();
  const renameItem = button("修改名称", "item", () => {
    hideColorMenu();
    menu!.hidden = true;
    startSystemRename(system);
  });
  const domainItem = button("业务域", "item has-sub", () => openDomainMenu(domainItem, system));
  const colorItem = button("标签色", "item has-sub", () => openColorMenu(colorItem, system));
  if (menuHover) {
    renameItem.addEventListener("pointerenter", () => hideColorMenu());
    domainItem.addEventListener("pointerenter", () => {
      window.clearTimeout(colorMenuTimer);
      openDomainMenu(domainItem, system);
    });
    domainItem.addEventListener("pointerleave", (event) => {
      if (colorMenuHot || pointerElement(event.relatedTarget)?.closest("#system-domain-menu, #system-menu")) {
        return;
      }
      scheduleHideColorMenu();
    });
    colorItem.addEventListener("pointerenter", () => {
      window.clearTimeout(colorMenuTimer);
      openColorMenu(colorItem, system);
    });
    colorItem.addEventListener("pointerleave", (event) => {
      if (colorMenuHot || pointerElement(event.relatedTarget)?.closest("#system-color-menu, #system-menu")) {
        return;
      }
      scheduleHideColorMenu();
    });
  }
  menu.replaceChildren(renameItem, domainItem, colorItem);
  closePops(menu);
  menu.hidden = false;
  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.zIndex = "60";
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
}

function placeColorMenu(menu: HTMLElement, anchor: HTMLElement) {
  menu.hidden = false;
  menu.style.position = "fixed";
  menu.style.right = "auto";
  menu.style.zIndex = "70";
  const anchorRect = anchor.getBoundingClientRect();
  const parent = document.getElementById("system-menu");
  const parentRect = parent && !parent.hidden ? parent.getBoundingClientRect() : anchorRect;
  const margin = 8;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  let left = parentRect.right - 6;
  if (left + width > window.innerWidth - margin) {
    left = parentRect.left - width + 6;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  let top = anchorRect.top - 4;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - height - margin);
  }
  const coversParent =
    left < parentRect.right - 8 &&
    left + width > parentRect.left + 8 &&
    top < parentRect.bottom &&
    top + height > anchorRect.bottom;
  if (coversParent) {
    const roomRight = window.innerWidth - margin - parentRect.right;
    const roomLeft = parentRect.left - margin;
    left = roomRight >= roomLeft ? parentRect.right - 6 : Math.max(margin, parentRect.left - width + 6);
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function openDomainMenu(anchor: HTMLElement, system: SystemItem) {
  let menu = document.querySelector("#system-domain-menu") as HTMLElement | null;
  if (!menu) {
    menu = el("div", "pop");
    menu.id = "system-domain-menu";
    document.body.append(menu);
    menu.addEventListener("click", (event) => event.stopPropagation());
    menu.addEventListener("pointerenter", () => {
      colorMenuHot = true;
      window.clearTimeout(colorMenuTimer);
    });
    menu.addEventListener("pointerleave", (event) => {
      colorMenuHot = false;
      const next = pointerElement(event.relatedTarget);
      if (next?.closest("#system-menu .has-sub")) {
        return;
      }
      if (next?.closest("#system-menu")) {
        hideColorMenu();
        return;
      }
      scheduleHideColorMenu();
    });
  }
  closeSiblingFlyout("system-domain-menu", anchor);
  anchor.classList.add("open");
  const current = system.domain || "其他";
  menu.replaceChildren(
    ...knownDomains().map((domain) =>
      button(domain, domain === current ? "item on" : "item", () => {
        hideColorMenu();
        const parent = document.querySelector("#system-menu") as HTMLElement | null;
        if (parent) {
          parent.hidden = true;
        }
        if (current === domain) {
          return;
        }
        system.domain = domain;
        scheduleSave();
        render();
      }),
    ),
  );
  placeColorMenu(menu, anchor);
}

function systemRenameHost(system: SystemItem): HTMLElement | null {
  const nodes = [...systemList.querySelectorAll<HTMLElement>(`[data-key="sys:${CSS.escape(system.id)}"]`)];
  return (
    nodes.find((node) => node.closest("section")?.querySelector("button.domain span")?.textContent !== "最近") ??
    nodes[0] ??
    detail.querySelector<HTMLElement>(`.domain-system[data-id="${CSS.escape(system.id)}"]`) ??
    null
  );
}

function startSystemRename(system: SystemItem) {
  const domain = system.domain || "其他";
  if (searching()) {
    search.value = "";
    query = parseQuery("");
  }
  if (readCollapsed().has(domain)) {
    toggleCollapsed(domain);
  }
  renderSidebar();
  const host = systemRenameHost(system);
  if (!host) {
    return;
  }
  const inPage = host.classList.contains("domain-system");
  const box = el("div", inPage ? "domain-system editing" : "system-rename");
  if (!inPage) {
    box.classList.toggle("open", host.classList.contains("open"));
    box.classList.toggle("flat", host.classList.contains("flat"));
  }
  const input = el("input");
  input.value = system.name;
  input.spellcheck = false;
  if (system.color) {
    input.style.color = system.color;
  }
  const icon = host.querySelector("i");
  if (icon && !inPage) {
    box.append(icon);
  }
  box.append(input);
  const count = host.querySelector("em");
  if (count) {
    box.append(count);
  }
  host.replaceWith(box);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) {
      return;
    }
    done = true;
    const next = input.value.trim();
    if (save && !next) {
      notify("系统名不能为空");
    } else if (save && next !== system.name) {
      const previous = system.name;
      system.name = next;
      recordLog({ category: "update", action: "修改系统", system, detail: `${previous} → ${next}` });
      scheduleSave();
    }
    render();
  };
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

function openColorMenu(anchor: HTMLElement, system: SystemItem) {
  let menu = document.querySelector("#system-color-menu") as HTMLElement | null;
  if (!menu) {
    menu = el("div", "pop");
    menu.id = "system-color-menu";
    document.body.append(menu);
    menu.addEventListener("click", (event) => event.stopPropagation());
    menu.addEventListener("pointerenter", () => {
      colorMenuHot = true;
      window.clearTimeout(colorMenuTimer);
    });
    menu.addEventListener("pointerleave", (event) => {
      colorMenuHot = false;
      const next = pointerElement(event.relatedTarget);
      if (next?.closest("#system-menu .has-sub")) {
        return;
      }
      if (next?.closest("#system-menu")) {
        hideColorMenu();
        return;
      }
      scheduleHideColorMenu();
    });
  }
  closeSiblingFlyout("system-color-menu", anchor);
  anchor.classList.add("open");
  if (menu.dataset.system === system.id && !menu.hidden) {
    placeColorMenu(menu, anchor);
    return;
  }
  menu.dataset.system = system.id;
  const apply = (color: string) => {
    hideColorMenu();
    const parent = document.querySelector("#system-menu") as HTMLElement | null;
    if (parent) {
      parent.hidden = true;
    }
    system.color = color;
    scheduleSave();
    paintSystemColor(system);
  };
  const reset = button("默认", system.color ? "label-color" : "label-color on", () => apply(""));
  reset.prepend(el("i", "none"));
  menu.replaceChildren(
    reset,
    ...SYSTEM_COLORS.map(([color, name]) => {
      const node = button(name, system.color === color ? "label-color on" : "label-color", () => apply(color));
      node.style.setProperty("--dot", color);
      const dot = el("i");
      dot.style.background = color;
      node.prepend(dot);
      return node;
    }),
  );
  placeColorMenu(menu, anchor);
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
  if (logView) {
    crumbDomain.textContent = "";
    crumbName.textContent = "日志";
    crumbCount.textContent = logRows.length ? `最近 ${logRows.length} 条` : "";
    return;
  }
  if (domainView) {
    const count = library.systems.filter((item) => (item.domain || "其他") === domainView).length;
    crumbDomain.textContent = domainView;
    crumbName.textContent = "";
    crumbCount.textContent = `${count} 个系统`;
    return;
  }
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
  configOpen = open && !domainView && !logView && Boolean(selectedSystem());
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

function parkActions() {
  const actions = document.querySelector(".top-actions");
  actions?.querySelector(".system-more")?.remove();
  document.querySelector(".top")?.append(actions as HTMLElement);
}

function applyDomainSystemOrder(domain: string, ids: string[]) {
  const next = [...library.systems];
  const ordered = ids
    .map((id) => next.find((system) => system.id === id && (system.domain || "其他") === domain))
    .filter((system): system is SystemItem => Boolean(system));
  const slots = ordered
    .map((system) => next.findIndex((item) => item.id === system.id))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  ordered.forEach((system, index) => {
    if (slots[index] !== undefined) {
      next[slots[index]] = system;
    }
  });
  library.systems = next;
}

function attachSystemDrag(row: HTMLElement, domain: string) {
  const handle = el("span", "handle", "⋮⋮");
  handle.title = "拖动排序";
  handle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const home = row.parentElement;
    const id = row.dataset.id ?? "";
    if (!home || !id) {
      return;
    }
    const startY = event.clientY;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let moved = false;
    let slideFrame = 0;
    let gap: HTMLElement | null = null;
    let float: HTMLElement | null = null;
    let parkedTop = 0;
    const slide = (change: () => void) => {
      if (reduceMotion) {
        change();
        return;
      }
      const nodes = [...home.querySelectorAll<HTMLElement>(":scope > *")];
      const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect().top]));
      change();
      const pending: HTMLElement[] = [];
      for (const node of nodes) {
        if (!node.isConnected) {
          continue;
        }
        node.style.transition = "none";
        node.style.transform = "";
        const dy = (before.get(node) ?? 0) - node.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) {
          continue;
        }
        node.style.transform = `translateY(${dy}px)`;
        pending.push(node);
      }
      window.cancelAnimationFrame(slideFrame);
      slideFrame = window.requestAnimationFrame(() => {
        for (const node of pending) {
          node.style.transition = "transform 200ms cubic-bezier(.2, .8, .2, 1)";
          node.style.transform = "";
        }
      });
    };
    const placeGap = (clientY: number) => {
      const slot = gap;
      if (!slot) {
        return;
      }
      const rows = [...home.querySelectorAll<HTMLElement>(":scope > [data-id]")];
      let anchor: Element | null = null;
      let after = false;
      for (const item of rows) {
        const rect = item.getBoundingClientRect();
        if (clientY < rect.top) {
          anchor = item;
          break;
        }
        anchor = item;
        after = true;
        if (clientY < rect.bottom) {
          after = clientY > (rect.top + rect.bottom) / 2;
          break;
        }
      }
      if (!anchor) {
        return;
      }
      if (after) {
        anchor = anchor.nextElementSibling;
      }
      if (anchor === slot || slot.nextElementSibling === anchor) {
        return;
      }
      slide(() => home.insertBefore(slot, anchor));
    };
    const lift = () => {
      const origin = row.getBoundingClientRect();
      parkedTop = origin.top;
      gap = el("div", "row-gap");
      gap.style.height = `${origin.height}px`;
      home.insertBefore(gap, row);
      float = el("div", "drag-float");
      float.style.left = `${origin.left}px`;
      float.style.top = `${origin.top}px`;
      float.style.width = `${origin.width}px`;
      row.classList.add("dragging");
      float.append(row);
      document.body.append(float);
      document.body.classList.add("row-dragging");
    };
    const finish = (changed: boolean) => {
      window.cancelAnimationFrame(slideFrame);
      for (const node of home.querySelectorAll<HTMLElement>(":scope > *")) {
        node.style.transition = "";
        node.style.transform = "";
      }
      row.classList.remove("dragging");
      if (!changed && gap?.isConnected) {
        gap.replaceWith(row);
      }
      float?.remove();
      float = null;
      gap = null;
      document.body.classList.remove("row-dragging");
      if (changed) {
        scheduleSave();
        render();
      }
    };
    const move = (ev: MouseEvent) => {
      if (!moved) {
        if (Math.abs(ev.clientY - startY) <= 3) {
          return;
        }
        moved = true;
        lift();
      }
      if (!float) {
        return;
      }
      float.style.transform = `translateY(${ev.clientY - startY}px)`;
      placeGap(ev.clientY);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved) {
        const swallow = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
          window.removeEventListener("click", swallow, true);
        };
        window.addEventListener("click", swallow, true);
      }
      if (!gap || !float) {
        row.classList.remove("dragging");
        document.body.classList.remove("row-dragging");
        return;
      }
      const before = library.systems.map((system) => system.id).join("\0");
      const order: string[] = [];
      for (const child of home.children) {
        if (child === gap) {
          order.push(id);
          continue;
        }
        if (child instanceof HTMLElement && child.dataset.id) {
          order.push(child.dataset.id);
        }
      }
      applyDomainSystemOrder(domain, order);
      const changed = library.systems.map((system) => system.id).join("\0") !== before;
      const slotTop = gap.getBoundingClientRect().top;
      const current = float.getBoundingClientRect().top;
      if (reduceMotion || Math.abs(current - slotTop) < 1) {
        finish(changed);
        return;
      }
      float.style.transition = "transform 200ms cubic-bezier(.2, .8, .2, 1)";
      let settled = false;
      const land = () => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        float?.removeEventListener("transitionend", land);
        finish(changed);
      };
      const timer = window.setTimeout(land, 240);
      float.addEventListener("transitionend", land);
      window.requestAnimationFrame(() => {
        if (float) {
          float.style.transform = `translateY(${slotTop - parkedTop}px)`;
        }
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  row.prepend(handle);
}

function renderDomainPage(domain: string): HTMLElement {
  const members = library.systems.filter((system) => (system.domain || "其他") === domain);
  const page = el("section", "domain-page");
  const head = el("div", "system-head");
  const title = el("div", "system-title");
  title.append(el("span", "domain-name", domain), el("em", "", `${members.length} 个系统`));
  head.append(title);
  const list = el("div", "domain-systems");
  if (members.length === 0) {
    list.append(el("p", "filter-empty", "这个业务域还没有系统"));
  }
  for (const system of members) {
    const row = el("button", "domain-system");
    row.type = "button";
    row.dataset.id = system.id;
    const name = el("b", "", system.name || "未命名");
    if (system.color) {
      name.style.color = system.color;
    }
    row.append(name, el("em", "", `${system.apis.length} 个接口`));
    row.addEventListener("click", () => openSystemPage(system));
    row.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      openSystemMenu(event.clientX, event.clientY, system);
    });
    attachSystemDrag(row, domain);
    list.append(row);
  }
  page.append(head, list);
  return page;
}

const LOG_CATEGORIES: Array<[string, string]> = [
  ["", "全部"],
  ["create", "新增"],
  ["update", "修改"],
  ["delete", "删除"],
  ["run", "执行"],
];

function logTime(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function showLogs() {
  logView = true;
  domainView = "";
  configOpen = false;
  logLoading = true;
  render();
  void loadLogs();
}

async function loadLogs() {
  const seq = ++logSeq;
  logLoading = true;
  try {
    const rows = await queryLogs(logCategory, logKeyword);
    if (seq !== logSeq || !logView) {
      return;
    }
    logRows = rows;
  } catch (error) {
    if (seq !== logSeq || !logView) {
      return;
    }
    logRows = [];
    notify(`日志读取失败：${String(error)}`, true);
  }
  logLoading = false;
  if (!logView) {
    return;
  }
  const list = document.querySelector("#log-list");
  if (list instanceof HTMLElement) {
    paintLogList(list);
  }
  renderCrumb(undefined);
}

function openLoggedApi(row: LogEntry) {
  const system = library.systems.find((item) => item.id === row.systemId);
  const api = system?.apis.find((item) => item.id === row.apiId);
  if (!system || !api) {
    notify("这条接口已经不在了");
    return;
  }
  logView = false;
  goToApi(system, api);
}

function paintLogList(list: HTMLElement) {
  list.replaceChildren();
  if (logRows.length === 0) {
    list.append(el("p", "filter-empty", logLoading ? "正在读取" : logKeyword || logCategory ? "没有匹配的日志" : "还没有日志"));
    return;
  }
  for (const row of logRows) {
    const item = el("article", logOpenId === row.id ? "log-item open" : "log-item");
    const head = el("button", "log-row");
    head.type = "button";
    head.append(
      el("span", `log-cat ${row.category}`, LOG_CATEGORIES.find(([value]) => value === row.category)?.[1] ?? row.category),
      el("span", "log-action", row.action),
      el("span", "log-target", row.target),
      el("span", "log-system", row.systemName),
      el("time", "", logTime(row.at)),
    );
    head.addEventListener("click", () => {
      logOpenId = logOpenId === row.id ? 0 : row.id;
      paintLogList(list);
    });
    item.append(head);
    if (logOpenId === row.id) {
      const body = el("div", "log-body");
      if (row.detail) {
        body.append(el("p", "", row.detail));
      }
      if (row.result) {
        body.append(el("pre", "", row.result));
      }
      if (row.systemId && row.apiId) {
        body.append(button("打开接口", "ghost", () => openLoggedApi(row)));
      }
      item.append(body);
    }
    list.append(item);
  }
  if (logRows.length >= 200) {
    list.append(el("p", "log-more", "只显示最近 200 条，可以用关键字缩小"));
  }
}

function renderLogPage(): HTMLElement {
  const page = el("section", "log-page");
  const tools = el("div", "log-tools");
  const filters = el("div", "method-filter");
  for (const [value, label] of LOG_CATEGORIES) {
    const node = button(label, logCategory === value ? "on" : "", () => {
      logCategory = value;
      logOpenId = 0;
      logRows = [];
      logLoading = true;
      filters.querySelectorAll("button").forEach((item, index) => {
        item.classList.toggle("on", LOG_CATEGORIES[index][0] === value);
      });
      paintLogList(list);
      void loadLogs();
    });
    filters.append(node);
  }
  const input = el("input", "log-search");
  input.placeholder = "搜索系统、接口或结果";
  input.value = logKeyword;
  input.spellcheck = false;
  input.addEventListener("input", () => {
    logKeyword = input.value.trim();
    window.clearTimeout(logTimer);
    logTimer = window.setTimeout(() => {
      logOpenId = 0;
      void loadLogs();
    }, 200);
  });
  tools.append(filters, input);
  const list = el("div", "log-list");
  list.id = "log-list";
  paintLogList(list);
  page.append(tools, list);
  return page;
}

function renderDetail() {
  parkActions();
  const scrollTop = detail.scrollTop;
  detail.replaceChildren();
  const top = document.querySelector(".top");
  document.querySelector("#log-toggle")?.classList.toggle("on", logView);
  if (logView) {
    top?.classList.remove("system-open");
    top?.classList.remove("domain-open");
    renderCrumb(undefined);
    renderConfig(undefined);
    detail.append(renderLogPage());
    detail.scrollTop = scrollTop;
    return;
  }
  if (domainView) {
    top?.classList.remove("system-open");
    top?.classList.add("domain-open");
    renderCrumb(undefined);
    renderConfig(undefined);
    detail.append(renderDomainPage(domainView));
    detail.scrollTop = scrollTop;
    return;
  }
  top?.classList.remove("domain-open");
  const system = selectedSystem();
  top?.classList.toggle("system-open", Boolean(system));
  renderCrumb(system);
  renderConfig(system);
  if (!system) {
    detail.append(renderEmpty());
    return;
  }
  detail.append(renderSystemHead(system), renderNote(system), renderApiHead(system), renderCurlAdd(system));
  const apis = visibleApis(system);
  if (apis.length === 0 && (methodFilter || searching())) {
    detail.append(el("p", "filter-empty", methodFilter === "star" ? "没有星标接口" : methodFilter ? "这个方法下没有接口" : "没有匹配的接口"));
  }
  appendApiGroups(system, apis);
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
  const title = el("div", "system-title");
  const domainName = el("span", "domain-name jump", system.domain || "其他");
  domainName.addEventListener("click", () => showDomain(system.domain || "其他"));
  const name = el("span", "name", system.name || "未命名");
  if (system.color) {
    name.style.color = system.color;
  }
  name.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openSystemMenu(event.clientX, event.clientY, system);
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
      recordLog({ category: "delete", action: "删除系统", system, detail: system.name || "未命名" });
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

  const count = el("em", "", `${system.apis.length} 个接口`);
  title.append(domainName, el("span", "slash", "/"), name, count);
  const actions = document.querySelector(".top-actions");
  if (actions) {
    moreWrap.classList.add("system-more");
    actions.append(moreWrap);
    head.append(title, actions);
  } else {
    head.append(title, moreWrap);
  }
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
  row.append(el("span", "handle", "⋮⋮"));
  row.append(el("b", "", link.label || "未命名"));
  if (kind === "env") {
    const current = currentEnvId(system) === link.id;
    row.classList.add("env");
    row.classList.toggle("current", current);
    row.title = current ? "再点一次，只用全局变量" : "选择这个环境";
    row.addEventListener("click", (event) => {
      if ((event.target as HTMLElement).closest("button, input, a, .handle")) {
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
  const handle = row.querySelector(".handle");
  if (!(handle instanceof HTMLElement) || row.dataset.row !== id) {
    return;
  }
  handle.title = "拖动排序";
  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const home = row.parentElement;
    if (!home) {
      return;
    }
    const rows = () => [...home.querySelectorAll<HTMLElement>(":scope > .row-item")].filter((item) => item.querySelector(".handle"));
    const startY = event.clientY;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let moved = false;
    let slideFrame = 0;
    let gap: HTMLElement | null = null;
    const slide = (change: () => void) => {
      if (reduceMotion || !gap) {
        change();
        return;
      }
      const nodes = [...home.querySelectorAll<HTMLElement>(":scope > .row-item, :scope > .row-gap")];
      const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect().top]));
      change();
      const pending: HTMLElement[] = [];
      for (const node of nodes) {
        if (!node.isConnected) {
          continue;
        }
        node.style.transition = "none";
        node.style.transform = "";
        const dy = (before.get(node) ?? 0) - node.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) {
          continue;
        }
        node.style.transform = `translateY(${dy}px)`;
        pending.push(node);
      }
      window.cancelAnimationFrame(slideFrame);
      slideFrame = window.requestAnimationFrame(() => {
        for (const node of pending) {
          node.style.transition = "transform 200ms cubic-bezier(.2, .8, .2, 1)";
          node.style.transform = "";
        }
      });
    };
    const placeGap = (clientY: number) => {
      const slot = gap;
      if (!slot) {
        return;
      }
      const others = rows();
      if (others.length === 0) {
        return;
      }
      let anchor: Element | null = null;
      for (const item of others) {
        const rect = item.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          anchor = item;
          break;
        }
      }
      if (!anchor) {
        const last = others[others.length - 1];
        anchor = last.nextElementSibling === slot ? slot.nextElementSibling : last.nextElementSibling;
      }
      if (anchor === slot || slot.nextElementSibling === anchor) {
        return;
      }
      slide(() => home.insertBefore(slot, anchor));
    };
    const lift = () => {
      const origin = row.getBoundingClientRect();
      gap = el("div", "row-gap");
      gap.style.height = `${origin.height}px`;
      home.insertBefore(gap, row);
      document.body.append(row);
      row.classList.add("dragging");
      row.style.position = "fixed";
      row.style.left = `${origin.left}px`;
      row.style.top = `${origin.top}px`;
      row.style.width = `${origin.width}px`;
      row.style.height = `${origin.height}px`;
      row.style.margin = "0";
      row.style.zIndex = "50";
      document.body.classList.add("row-dragging");
    };
    const move = (ev: MouseEvent) => {
      if (!moved) {
        if (Math.abs(ev.clientY - startY) <= 3) {
          return;
        }
        moved = true;
        lift();
      }
      if (!gap) {
        return;
      }
      row.style.transform = `translateY(${ev.clientY - startY}px)`;
      placeGap(ev.clientY);
    };
    const persist = (order: string[]) => {
      const list = read();
      const before = list.map((item) => item.id).join("\0");
      const byId = new Map(list.map((item) => [item.id, item]));
      const queue: T[] = [];
      for (const itemId of order) {
        const item = byId.get(itemId);
        if (item) {
          queue.push(item);
        }
      }
      const moving = new Set(queue.map((item) => item.id));
      let index = 0;
      const next = list.map((item) => (moving.has(item.id) ? queue[index++] ?? item : item));
      if (next.map((item) => item.id).join("\0") === before) {
        return;
      }
      write(next);
      scheduleSave();
    };
    const orderNow = () => {
      if (!gap) {
        return rows().map((item) => item.dataset.row || "").filter(Boolean);
      }
      const order: string[] = [];
      for (const child of home.children) {
        if (child === gap) {
          if (row.dataset.row) {
            order.push(row.dataset.row);
          }
          continue;
        }
        if (child instanceof HTMLElement && child.classList.contains("row-item") && child.querySelector(".handle") && child.dataset.row) {
          order.push(child.dataset.row);
        }
      }
      return order;
    };
    const clearLift = () => {
      row.classList.remove("dragging");
      row.style.position = "";
      row.style.left = "";
      row.style.top = "";
      row.style.width = "";
      row.style.height = "";
      row.style.margin = "";
      row.style.zIndex = "";
      row.style.transform = "";
      row.style.transition = "";
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      window.cancelAnimationFrame(slideFrame);
      document.body.classList.remove("row-dragging");
      if (moved) {
        const swallow = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
          window.removeEventListener("click", swallow, true);
        };
        window.addEventListener("click", swallow, true);
      }
      if (!gap) {
        return;
      }
      for (const node of home.querySelectorAll<HTMLElement>(":scope > .row-item, :scope > .row-gap")) {
        node.style.transition = "";
        node.style.transform = "";
      }
      const order = orderNow();
      const slot = gap.getBoundingClientRect().top;
      const originTop = Number.parseFloat(row.style.top);
      const current = row.getBoundingClientRect().top;
      persist(order);
      const land = () => {
        const slotNode = gap;
        gap = null;
        if (slotNode?.isConnected) {
          slotNode.replaceWith(row);
          clearLift();
          return;
        }
        clearLift();
        row.remove();
      };
      if (reduceMotion || Math.abs(current - slot) < 1) {
        land();
        return;
      }
      row.style.transition = "transform 200ms cubic-bezier(.2, .8, .2, 1)";
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        row.removeEventListener("transitionend", finish);
        land();
      };
      const timer = window.setTimeout(finish, 240);
      row.addEventListener("transitionend", finish);
      window.requestAnimationFrame(() => {
        row.style.transform = `translateY(${slot - originTop}px)`;
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
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

function groupName(api: ApiItem): string {
  return (api.group || "").trim();
}

function ensureGroups(system: SystemItem) {
  const next: string[] = [];
  for (const name of system.groups || []) {
    const trimmed = name.trim();
    if (trimmed && !next.includes(trimmed)) {
      next.push(trimmed);
    }
  }
  for (const api of system.apis) {
    const name = groupName(api);
    if (name && !next.includes(name)) {
      next.push(name);
    }
  }
  system.groups = next;
}

function collapsedApiGroups(systemId: string): Set<string> {
  return new Set(readList(`api-groups:${systemId}`));
}

function toggleApiGroup(systemId: string, name: string) {
  const collapsed = collapsedApiGroups(systemId);
  if (collapsed.has(name)) {
    collapsed.delete(name);
  } else {
    collapsed.add(name);
  }
  writeList(`api-groups:${systemId}`, [...collapsed]);
}

function addGroup(system: SystemItem, raw: string): string {
  const next = raw.trim();
  if (!next) {
    return "";
  }
  ensureGroups(system);
  if (system.groups.includes(next)) {
    notify("已有这个分组");
    return "";
  }
  system.groups.push(next);
  scheduleSave();
  return next;
}

function renameApiGroup(system: SystemItem, from: string, to: string) {
  const next = to.trim();
  if (!next) {
    notify("分组名不能为空");
    return;
  }
  if (next === from) {
    return;
  }
  ensureGroups(system);
  if (system.groups.includes(next)) {
    notify("已有这个分组");
    return;
  }
  const index = system.groups.indexOf(from);
  if (index >= 0) {
    system.groups[index] = next;
  }
  for (const api of system.apis) {
    if (groupName(api) === from) {
      api.group = next;
    }
  }
  const collapsed = collapsedApiGroups(system.id);
  if (collapsed.delete(from)) {
    collapsed.add(next);
    writeList(`api-groups:${system.id}`, [...collapsed]);
  }
  if (groupFilter === from) {
    groupFilter = next;
  }
  recordLog({ category: "update", action: "修改分组", system, detail: `${from} → ${next}` });
  scheduleSave();
}

async function removeGroup(system: SystemItem, name: string) {
  const count = system.apis.filter((api) => groupName(api) === name).length;
  const ok = await confirmDelete(count ? `删除分组「${name}」？其中 ${count} 条接口会移到未分组。` : `删除分组「${name}」？`);
  if (!ok) {
    return;
  }
  system.groups = (system.groups || []).filter((item) => item !== name);
  for (const api of system.apis) {
    if (groupName(api) === name) {
      api.group = "";
      touchApi(api);
    }
  }
  const collapsed = collapsedApiGroups(system.id);
  if (collapsed.delete(name)) {
    writeList(`api-groups:${system.id}`, [...collapsed]);
  }
  if (groupFilter === name) {
    groupFilter = null;
  }
  recordLog({ category: "delete", action: "删除分组", system, detail: name });
  scheduleSave();
  render();
}

function openGroupCreate() {
  if (!selectedSystem()) {
    return;
  }
  creatingGroup = true;
  focusGroupCreate = true;
  setNavHidden(false);
  render();
}

function bindGroupRename(input: HTMLInputElement, system: SystemItem, from: string) {
  input.value = from;
  input.spellcheck = false;
  let done = false;
  const finish = (save: boolean) => {
    if (done) {
      return;
    }
    done = true;
    if (save) {
      renameApiGroup(system, from, input.value);
    }
    render();
  };
  input.addEventListener("keydown", (event) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
  input.focus();
  input.select();
}

function startGroupRename(row: HTMLElement, system: SystemItem, name: string) {
  const input = el("input");
  row.querySelector("button")?.replaceWith(input);
  bindGroupRename(input, system, name);
}

function groupCreateForm(system: SystemItem): HTMLFormElement {
  const form = el("form", "group-create");
  const input = el("input");
  input.placeholder = "分组名称";
  input.spellcheck = false;
  const ok = el("button", "primary", "添加");
  ok.type = "submit";
  form.append(
    input,
    ok,
    button("取消", "mini", () => {
      creatingGroup = false;
      render();
    }),
  );
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = addGroup(system, input.value);
    if (!name) {
      input.focus();
      return;
    }
    creatingGroup = false;
    groupFilter = name;
    render();
  });
  return form;
}

function applyGroupOrder(system: SystemItem, visible: string[]) {
  const next = [...system.groups];
  const slots = visible.map((name) => next.indexOf(name)).filter((index) => index >= 0).sort((left, right) => left - right);
  visible.forEach((name, index) => {
    if (slots[index] !== undefined) {
      next[slots[index]] = name;
    }
  });
  system.groups = next;
}

function attachGroupDrag(row: HTMLElement, system: SystemItem, name: string) {
  row.dataset.group = name;
  const handle = el("span", "handle", "⋮⋮");
  handle.title = "拖动排序";
  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const home = row.parentElement;
    if (!home) {
      return;
    }
    const stops = (node: Element) =>
      node.classList.contains("api-group") || node.classList.contains("group-nav") || node.classList.contains("nav-add");
    const block = () => {
      const nodes = [row];
      let next = row.nextElementSibling;
      while (next && !stops(next)) {
        nodes.push(next as HTMLElement);
        next = next.nextElementSibling;
      }
      return nodes;
    };
    const startY = event.clientY;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let moved = false;
    let slideFrame = 0;
    let gap: HTMLElement | null = null;
    let float: HTMLElement | null = null;
    let tail: HTMLElement[] = [];
    let parkedTop = 0;
    let gapInset = 0;
    const slide = (change: () => void) => {
      if (reduceMotion) {
        change();
        return;
      }
      const nodes = [...home.querySelectorAll<HTMLElement>(":scope > *")];
      const before = new Map(nodes.map((node) => [node, node.getBoundingClientRect().top]));
      change();
      const pending: HTMLElement[] = [];
      for (const node of nodes) {
        if (!node.isConnected) {
          continue;
        }
        node.style.transition = "none";
        node.style.transform = "";
        const dy = (before.get(node) ?? 0) - node.getBoundingClientRect().top;
        if (Math.abs(dy) < 1) {
          continue;
        }
        node.style.transform = `translateY(${dy}px)`;
        pending.push(node);
      }
      window.cancelAnimationFrame(slideFrame);
      slideFrame = window.requestAnimationFrame(() => {
        for (const node of pending) {
          node.style.transition = "transform 200ms cubic-bezier(.2, .8, .2, 1)";
          node.style.transform = "";
        }
      });
    };
    const blockEnd = (item: HTMLElement) => {
      let cursor = item.nextElementSibling;
      while (cursor && cursor !== gap && !stops(cursor)) {
        cursor = cursor.nextElementSibling;
      }
      return cursor;
    };
    const placeGap = (clientY: number) => {
      const slot = gap;
      if (!slot) {
        return;
      }
      const groups = [...home.querySelectorAll<HTMLElement>(":scope > [data-group]")];
      let anchor: Element | null = null;
      let after = false;
      for (const item of groups) {
        const top = item.getBoundingClientRect().top;
        const end = blockEnd(item);
        const bottom = end?.getBoundingClientRect().top ?? home.getBoundingClientRect().bottom;
        if (clientY < top || clientY >= bottom) {
          continue;
        }
        anchor = item;
        after = clientY > (top + bottom) / 2;
        break;
      }
      if (!anchor) {
        return;
      }
      if (after) {
        anchor = blockEnd(anchor as HTMLElement);
      }
      const last = tail.length > 0 ? tail[tail.length - 1] : slot;
      if (anchor === slot || last.nextElementSibling === anchor) {
        return;
      }
      slide(() => {
        home.insertBefore(slot, anchor);
        let cursor: Element = slot;
        for (const child of tail) {
          cursor.after(child);
          cursor = child;
        }
      });
    };
    const lift = () => {
      const nodes = block();
      tail = nodes.slice(1);
      const origin = row.getBoundingClientRect();
      const prevBottom = row.previousElementSibling?.getBoundingClientRect().bottom ?? origin.top;
      const nextTop = row.nextElementSibling?.getBoundingClientRect().top ?? origin.bottom;
      const spaceTop = Math.min(prevBottom, origin.top);
      parkedTop = origin.top;
      gapInset = origin.top - spaceTop;
      gap = el("div", "row-gap");
      gap.style.height = `${Math.max(origin.height, nextTop - spaceTop)}px`;
      home.insertBefore(gap, row);
      float = el("div", "drag-float");
      float.style.left = `${origin.left}px`;
      float.style.top = `${origin.top}px`;
      float.style.width = `${origin.width}px`;
      row.classList.add("dragging");
      float.append(row);
      document.body.append(float);
      document.body.classList.add("group-dragging");
    };
    const finish = (changed: boolean) => {
      window.cancelAnimationFrame(slideFrame);
      for (const node of home.querySelectorAll<HTMLElement>(":scope > *")) {
        node.style.transition = "";
        node.style.transform = "";
      }
      row.classList.remove("dragging");
      if (!changed && gap?.isConnected) {
        gap.replaceWith(row);
      }
      float?.remove();
      float = null;
      gap = null;
      document.body.classList.remove("group-dragging");
      if (changed) {
        scheduleSave();
        render();
      }
    };
    const move = (ev: MouseEvent) => {
      if (!moved) {
        if (Math.abs(ev.clientY - startY) <= 3) {
          return;
        }
        moved = true;
        lift();
      }
      if (!float) {
        return;
      }
      float.style.transform = `translateY(${ev.clientY - startY}px)`;
      placeGap(ev.clientY);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (moved) {
        const swallow = (ev: Event) => {
          ev.preventDefault();
          ev.stopPropagation();
          window.removeEventListener("click", swallow, true);
        };
        window.addEventListener("click", swallow, true);
      }
      if (!gap || !float) {
        row.classList.remove("dragging");
        document.body.classList.remove("group-dragging");
        return;
      }
      const before = system.groups.join("\0");
      const order: string[] = [];
      for (const child of home.children) {
        if (child === gap) {
          order.push(name);
          continue;
        }
        if (child instanceof HTMLElement && child.dataset.group) {
          order.push(child.dataset.group);
        }
      }
      applyGroupOrder(system, order);
      const changed = system.groups.join("\0") !== before;
      const slotTop = gap.getBoundingClientRect().top + gapInset;
      const current = float.getBoundingClientRect().top;
      if (reduceMotion || Math.abs(current - slotTop) < 1) {
        finish(changed);
        return;
      }
      float.style.transition = "transform 200ms cubic-bezier(.2, .8, .2, 1)";
      let settled = false;
      const land = () => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        float?.removeEventListener("transitionend", land);
        finish(changed);
      };
      const timer = window.setTimeout(land, 240);
      float.addEventListener("transitionend", land);
      window.requestAnimationFrame(() => {
        if (float) {
          float.style.transform = `translateY(${slotTop - parkedTop}px)`;
        }
      });
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  row.prepend(handle);
}

function groupNavItem(filter: string | null, label: string, count: number, system: SystemItem): HTMLElement {
  const row = el("div", "group-nav");
  const main = el("button", groupFilter === filter ? "on" : "");
  main.type = "button";
  main.append(el("span", "", label), el("em", "", String(count)));
  main.addEventListener("click", () => {
    groupFilter = filter;
    render();
  });
  row.append(main);
  if (filter) {
    attachGroupDrag(row, system, filter);
  }
  if (filter) {
    const actions = el("div", "group-nav-actions");
    actions.append(
      button("改名", "mini", () => startGroupRename(row, system, filter)),
      button("删除", "mini danger", () => void removeGroup(system, filter)),
    );
    row.append(actions);
  }
  return row;
}

function systemGroupNav(system: SystemItem): HTMLElement {
  ensureGroups(system);
  const list = el("div", "nav-groups");
  if (creatingGroup) {
    list.append(groupCreateForm(system));
  }
  for (const name of system.groups) {
    const count = system.apis.filter((api) => groupName(api) === name).length;
    list.append(groupNavItem(name, name, count, system));
  }
  const loose = system.apis.filter((api) => !groupName(api)).length;
  if (system.groups.length > 0 && loose > 0) {
    list.append(groupNavItem("", "未分组", loose, system));
  }
  if (focusGroupCreate) {
    focusGroupCreate = false;
    queueMicrotask(() => (list.querySelector(".group-create input") as HTMLInputElement | null)?.focus());
  }
  return list;
}

function showApiGroups(): boolean {
  return localStorage.getItem("show-api-groups") !== "0";
}

function appendApiGroups(system: SystemItem, apis: ApiItem[]) {
  ensureGroups(system);
  if (!showApiGroups() || (system.groups.length === 0 && groupFilter === null)) {
    for (const api of apis) {
      detail.append(renderApi(system, api));
    }
    return;
  }
  const collapsed = collapsedApiGroups(system.id);
  const names = groupFilter === null ? system.groups : groupFilter ? [groupFilter] : [];
  const showEmpty = groupFilter !== null || (!searching() && !methodFilter);
  for (const name of names) {
    const members = apis.filter((api) => groupName(api) === name);
    if (members.length === 0 && !showEmpty) {
      continue;
    }
    const folded = groupFilter === null && collapsed.has(name);
    detail.append(apiGroupHeader(system, name, members.length, folded));
    if (!folded) {
      for (const api of members) {
        detail.append(renderApi(system, api));
      }
      if (members.length === 0) {
        detail.append(el("p", "filter-empty", "这个分组里还没有接口"));
      }
    }
  }
  if (groupFilter === null && system.groups.length > 0) {
    const loose = apis.filter((api) => !groupName(api));
    if (loose.length > 0) {
      const folded = collapsed.has("");
      detail.append(apiGroupHeader(system, "", loose.length, folded));
      if (!folded) {
        for (const api of loose) {
          detail.append(renderApi(system, api));
        }
      }
    }
  }
  if (groupFilter === "") {
    const loose = apis.filter((api) => !groupName(api));
    detail.append(apiGroupHeader(system, "", loose.length, false));
    for (const api of loose) {
      detail.append(renderApi(system, api));
    }
    if (loose.length === 0 && !searching() && !methodFilter) {
      detail.append(el("p", "filter-empty", "没有未分组的接口"));
    }
  }
}

function apiGroupHeader(system: SystemItem, name: string, count: number, folded: boolean): HTMLElement {
  const row = el("div", folded ? "api-group folded" : "api-group");
  const title = el("button", "api-group-toggle");
  title.type = "button";
  title.append(el("i"), el("span", "", name || "未分组"), el("em", "", String(count)));
  title.addEventListener("click", () => {
    toggleApiGroup(system.id, name);
    renderDetail();
  });
  row.append(title);
  if (name) {
    attachGroupDrag(row, system, name);
    const actions = el("div", "api-group-actions");
    actions.append(
      button("改名", "mini", () => startGroupRename(row, system, name)),
      button("删除", "mini danger", () => void removeGroup(system, name)),
    );
    row.append(actions);
  }
  return row;
}

function groupButton(system: SystemItem, api: ApiItem): HTMLElement {
  const wrap = el("span", "pop-wrap");
  const pop = el("div", "pop");
  pop.hidden = true;
  pop.addEventListener("click", (event) => event.stopPropagation());
  ensureGroups(system);
  const assign = (name: string) => {
    const next = name.trim();
    if (groupName(api) === next) {
      pop.hidden = true;
      return;
    }
    if (next && !system.groups.includes(next)) {
      system.groups.push(next);
    }
    api.group = next;
    touchApi(api);
    recordLog({ category: "update", action: "修改分组", system, api, detail: next || "未分组" });
    scheduleSave();
    render();
  };
  pop.append(button(groupName(api) ? "未分组" : "✓ 未分组", "item", () => assign("")));
  for (const name of system.groups) {
    pop.append(button(groupName(api) === name ? `✓ ${name}` : name, "item", () => assign(name)));
  }
  const form = el("form", "group-new");
  const input = el("input");
  input.placeholder = "新分组";
  input.spellcheck = false;
  const save = el("button", "primary", "确定");
  save.type = "submit";
  form.append(input, save);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const next = input.value.trim();
    if (!next) {
      input.focus();
      return;
    }
    assign(next);
  });
  pop.append(form);
  const trigger = button("分组", "ghost", (event) => openPop(event.currentTarget as HTMLElement, pop));
  wrap.append(trigger, pop);
  return wrap;
}

/* 接口列表 */

function renderApiHead(system: SystemItem): HTMLElement {
  const head = el("div", "api-head");
  const shown = visibleApis(system).length;
  const narrowed = searching() || Boolean(methodFilter) || groupFilter !== null;
  head.append(el("h3", "", narrowed && shown !== system.apis.length ? `接口 ${shown} / ${system.apis.length}` : `接口 ${system.apis.length}`));
  const filters = el("div", "method-filter");
  const present = new Set(system.apis.map((api) => api.method.toUpperCase()));
  const methods = ["", ...["GET", "POST", "PUT", "PATCH", "DELETE"].filter((method) => present.has(method))];
  if (system.apis.some((api) => api.starred)) {
    methods.push("STAR");
  }
  for (const method of methods) {
    const value = method === "STAR" ? "star" : method.toLowerCase();
    const active = methodFilter === value;
    filters.append(
      button(method === "STAR" ? "星标" : method || "全部", active ? "on" : "", () => {
        methodFilter = value;
        renderDetail();
      }),
    );
  }
  const tools = [button("新建分组", "ghost", () => openGroupCreate())];
  if (showApiGroups()) {
    tools.push(button("全部展开", "ghost", expandAll), button("全部收起", "ghost", collapseAll));
  }
  head.append(filters, el("div", "spacer"), ...tools);
  return head;
}

function renderCurlAdd(system: SystemItem): HTMLElement {
  const form = el("form", "curl-add");
  const input = el("textarea", "curl-add-input");
  input.spellcheck = false;
  input.rows = 1;
  input.placeholder = `粘贴一条 curl，${modLabel}↵ 添加`;
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
          group: groupFilter ?? "",
          starred: false,
          updatedAt: Date.now(),
          cases: [],
        };
        if (!found) {
          system.apis.push(api);
          recordLog({ category: "create", action: "新增接口", system, api });
        }
        const same = api.cases.find((item) => item.content === parsed.content);
        const caseItem: CaseItem = same ?? { id: uid(), content: parsed.content, updatedAt: Date.now() };
        if (!same) {
          api.cases.push(caseItem);
          touchApi(api);
          recordLog({
            category: "create",
            action: "新增用例",
            system,
            api,
            detail: caseTitle(caseItem.content, api.cases.length - 1),
          });
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
    recordLog({ category: "update", action: api.starred ? "收藏接口" : "取消收藏", system, api });
    scheduleSave();
    render();
  }, api.starred ? "取消收藏" : "收藏");
  const badge = el("span", `method method-${api.method.toLowerCase()}`, api.method);
  const path = el("code", "path", api.path);
  path.title = api.path;
  const count = el("em", "", `${api.cases.length} 条用例`);
  const main = el("div", "api-main");
  main.append(star, badge, path);
  const actions = el("div", "api-actions");
  actions.append(
    button("复制", "mini", () => {
      void copyText(api.path).then(() => notify("已复制路径"));
    }),
    button("编辑", "mini", () => openPathDialog(system, api)),
    count,
  );
  row.append(main, actions);

  const target = mergeCandidate(system, api);
  if (target) {
    actions.append(
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
          recordLog({
            category: "update",
            action: "合并接口",
            system,
            api: target,
            detail: `并入 ${api.method} ${api.path} 的 ${api.cases.length} 条用例`,
          });
          system.apis = system.apis.filter((item) => item.id !== api.id);
          showApi(target.id);
          scheduleSave();
          render();
        });
      }, `与 ${target.method} ${target.path} 只差大小写或末尾斜杠`),
    );
  }
  actions.append(
    button("复制全部", "ghost", () => {
      const text = api.cases.map((item) => substitute(item.content, variablesFor(system)).trim()).filter(Boolean).join("\n\n");
      void copyText(text).then(() => notify(`已复制 ${api.cases.length} 条用例`));
    }, "复制这个接口下的全部用例"),
    button("移动到…", "ghost", () => moveApi(system, api)),
    groupButton(system, api),
    button("删除接口", "ghost danger", () => {
      void confirmDelete(`删除 ${api.method} ${api.path}？`).then((ok) => {
        if (!ok) {
          return;
        }
        recordLog({ category: "delete", action: "删除接口", system, api, detail: `${api.cases.length} 条用例` });
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
    const noteBefore = api.note;
    note.addEventListener("input", () => {
      api.note = note.value;
      touchApi(api);
      scheduleSave();
    });
    note.addEventListener("blur", () => {
      if (note.value !== noteBefore) {
        recordLog({ category: "update", action: "修改备注", system, api, detail: note.value.trim() || "已清空" });
      }
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

function cleanPath(input: string): string {
  const trimmed = input.replace(/\s+/g, "");
  if (!trimmed) {
    return "";
  }
  if (trimmed.startsWith("/") || trimmed.includes("://") || trimmed.startsWith("{{")) {
    return pathOf(trimmed);
  }
  return `/${trimmed.split(/[?#]/)[0]}`;
}

let pathTarget: { systemId: string; apiId: string } | null = null;

function openPathDialog(system: SystemItem, api: ApiItem) {
  pathTarget = { systemId: system.id, apiId: api.id };
  const dialog = document.querySelector("#path-dialog") as HTMLElement;
  const input = document.querySelector("#path-input") as HTMLTextAreaElement;
  input.value = api.path;
  dialog.hidden = false;
  input.focus();
  input.select();
}

function closePathDialog() {
  pathTarget = null;
  (document.querySelector("#path-dialog") as HTMLElement).hidden = true;
}

function submitPath(event: Event) {
  event.preventDefault();
  const target = pathTarget;
  const input = document.querySelector("#path-input") as HTMLTextAreaElement;
  const system = library.systems.find((item) => item.id === target?.systemId);
  const api = system?.apis.find((item) => item.id === target?.apiId);
  if (!system || !api) {
    closePathDialog();
    return;
  }
  const next = cleanPath(input.value);
  if (!next) {
    notify("路径不能为空");
    input.focus();
    return;
  }
  if (next === api.path) {
    closePathDialog();
    return;
  }
  if (system.apis.some((item) => item !== api && item.method === api.method && item.path === next)) {
    notify("这个系统里已经有相同的方法和路径");
    input.focus();
    return;
  }
  const from = api.path;
  let count = 0;
  for (const item of api.cases) {
    const updated = replaceCurlPath(item.content, from, next);
    if (updated === item.content) {
      continue;
    }
    item.content = updated;
    item.updatedAt = Date.now();
    count += 1;
  }
  api.path = next;
  touchApi(api);
  recordLog({ category: "update", action: "修改路径", system, api, detail: `${from} → ${next}` });
  scheduleSave();
  closePathDialog();
  render();
  if (api.cases.length > 0 && count === 0) {
    notify("路径已改，用例里的地址没有对上");
  } else if (count > 0) {
    notify(`已替换 ${count} 条用例里的地址`);
  }
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

  const format = button(formatBackup.has(item.id) ? "还原" : "格式化", "", () => {
    const before = item.content;
    const formatting = !formatBackup.has(item.id);
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
    if (item.content !== before) {
      skipCaseLog.add(item.id);
      recordLog({
        category: "update",
        action: "修改用例",
        system,
        api,
        detail: `${formatting ? "格式化" : "还原"} · ${caseTitle(item.content, index)}`,
      });
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
    recordLog({ category: "create", action: "新增用例", system, api, detail: caseTitle(copyItem.content, index + 1) });
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
      recordLog({ category: "delete", action: "删除用例", system, api, detail: caseTitle(item.content, index) });
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
  head.append(moreWrap);

  const wrap = el("div", structureOpen.has(item.id) ? "shell-wrap with-structure" : "shell-wrap");
  const view = el("div", "shell-view");
  const highlight = el("pre", "shell-highlight");
  const area = el("textarea", "shell-input");
  area.dataset.case = item.id;
  area.spellcheck = false;
  area.value = item.content;
  const syncRunButtons = () => {
    const commands = curlCommands(area.value);
    const count = Math.max(commands.length, 1);
    const buttons = [...view.querySelectorAll<HTMLButtonElement>(".run-icon")];
    while (buttons.length < count) {
      const button = el("button", "run-icon");
      button.type = "button";
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const index = Number(button.dataset.index ?? "0");
        const list = curlCommands(area.value);
        const source = list[index]?.text ?? area.value;
        void runCase(system, item, index, source);
      });
      view.append(button);
      buttons.push(button);
    }
    while (buttons.length > count) {
      buttons.pop()?.remove();
    }
    buttons.forEach((button, index) => {
      button.dataset.index = String(index);
      paintRunIcon(button, item, index);
    });
  };
  const placeRunButtons = () => {
    if (!highlight.isConnected) {
      return;
    }
    const buttons = [...view.querySelectorAll<HTMLButtonElement>(".run-icon")];
    const marks = [...highlight.querySelectorAll<HTMLElement>(".curl-mark")];
    const lineHeight = Number.parseFloat(getComputedStyle(highlight).lineHeight);
    const hostTop = view.getBoundingClientRect().top;
    buttons.forEach((button, index) => {
      const mark = marks[index];
      const word = mark?.nextElementSibling ?? mark;
      if (!word || !Number.isFinite(lineHeight)) {
        button.style.top = "14px";
        return;
      }
      const rect = word.getBoundingClientRect();
      const leading = Math.max(0, (lineHeight - rect.height) / 2);
      button.style.top = `${rect.top - hostTop - leading}px`;
    });
  };
  const paint = () => {
    highlight.innerHTML = highlightShell(area.value, definedVariables(system));
    syncRunButtons();
    placeRunButtons();
    requestAnimationFrame(placeRunButtons);
  };
  let caseSnapshot = item.content;
  area.addEventListener("focus", () => {
    caseSnapshot = area.value;
  });
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
    const previous = caseSnapshot;
    const next = area.value;
    window.setTimeout(() => {
      if (document.activeElement === area || varBar.contains(document.activeElement)) {
        return;
      }
      varBar.hidden = true;
      if (skipCaseLog.delete(item.id)) {
        return;
      }
      if (!api.cases.some((caseItem) => caseItem.id === item.id)) {
        return;
      }
      if (!next.trim()) {
        if (previous.trim()) {
          recordLog({ category: "delete", action: "删除用例", system, api, detail: caseTitle(previous, index) });
        }
        const focusId = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.case ?? "" : "";
        api.cases = api.cases.filter((caseItem) => caseItem.id !== item.id);
        touchApi(api);
        scheduleSave();
        renderDetail();
        if (focusId) {
          focusCase(focusId);
        }
        return;
      }
      if (next !== previous) {
        recordLog({
          category: previous.trim() ? "update" : "create",
          action: previous.trim() ? "修改用例" : "新增用例",
          system,
          api,
          detail: caseTitle(next, index),
        });
        caseSnapshot = next;
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

function describeRun(result: RunResult): string {
  const status = result.timedOut ? "超时" : result.killed ? "已停止" : `退出码 ${result.code ?? "?"}`;
  const chunks = [`${status} · ${result.millis} ms`];
  if (result.stdout) {
    chunks.push(result.stdout);
  }
  if (result.stderr.trim()) {
    chunks.push(`stderr:\n${result.stderr}`);
  }
  return chunks.join("\n\n");
}

function recordRun(system: SystemItem, item: CaseItem, index: number, result: string) {
  const api = system.apis.find((candidate) => candidate.cases.some((caseItem) => caseItem.id === item.id));
  const title = caseTitle(item.content, api?.cases.findIndex((caseItem) => caseItem.id === item.id) ?? 0);
  recordLog({
    category: "run",
    action: "执行用例",
    system,
    api,
    detail: index > 0 ? `${title} · 第 ${index + 1} 条` : title,
    result,
  });
}

async function runCase(system: SystemItem, item: CaseItem, index = 0, source = item.content) {
  const current = runs.get(item.id);
  if (current?.running) {
    void stopCommand(current.runId);
    if (current.index === index) {
      return;
    }
  }
  const command = substitute(source, variablesFor(system)).trim();
  if (!command) {
    notify("用例是空的");
    return;
  }
  const runId = uid();
  runs.set(item.id, { runId, running: true, index });
  paintRunPanel(item);
  try {
    const result = await runCommand(runId, command);
    recordRun(system, item, index, describeRun(result));
    if (runs.get(item.id)?.runId !== runId) {
      return;
    }
    runs.set(item.id, { runId, running: false, index, result });
  } catch (error) {
    recordRun(system, item, index, String(error));
    if (runs.get(item.id)?.runId !== runId) {
      return;
    }
    runs.set(item.id, { runId, running: false, index, error: String(error) });
  }
  paintRunPanel(item);
}

function paintRunPanel(item: CaseItem) {
  const existing = detail.querySelector(`[data-result="${item.id}"]`);
  const next = renderRunPanel(item);
  if (existing) {
    existing.replaceWith(next);
  }
  detail.querySelectorAll<HTMLButtonElement>(`[data-case-box="${item.id}"] .run-icon`).forEach((node) => {
    paintRunIcon(node, item, Number(node.dataset.index ?? "0"));
  });
}

function runIcon(running: boolean): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "14");
  svg.setAttribute("height", "14");
  svg.setAttribute("aria-hidden", "true");
  if (running) {
    const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    rect.setAttribute("x", "3.5");
    rect.setAttribute("y", "3.5");
    rect.setAttribute("width", "9");
    rect.setAttribute("height", "9");
    rect.setAttribute("rx", "1.5");
    rect.setAttribute("fill", "currentColor");
    svg.append(rect);
  } else {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "currentColor");
    path.setAttribute("d", "M5.2 2.8v10.4L13 8 5.2 2.8z");
    svg.append(path);
  }
  return svg;
}

function paintRunIcon(node: HTMLButtonElement, item: CaseItem, index = Number(node.dataset.index ?? "0")) {
  const state = runs.get(item.id);
  const running = Boolean(state?.running && state.index === index);
  node.title = running ? "停止" : "运行这条";
  node.setAttribute("aria-label", running ? "停止" : "运行这条");
  node.classList.toggle("running", running);
  node.replaceChildren(runIcon(running));
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
          const from = library.systems.find((candidate) => candidate.apis.includes(api));
          recordLog({
            category: "update",
            action: "移动用例",
            system: targetSystem,
            api: target,
            detail: `从 ${from?.name || "未命名"} 的 ${api.method} ${api.path}`,
          });
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
          recordLog({
            category: "update",
            action: "移动接口",
            system: target,
            api: existing,
            detail: `从 ${system.name} 并入 ${api.cases.length} 条用例`,
          });
          scheduleSave();
          jumpToApi(target.id, existing.id);
          notify(`已并入 ${target.name} 的 ${existing.method} ${existing.path}`);
          return;
        }
        target.apis.push(api);
        touchApi(api);
        recordLog({ category: "update", action: "移动接口", system: target, api, detail: `从 ${system.name}` });
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
  closeFinder();
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

/* 查找 */

const finder = document.querySelector("#finder") as HTMLElement;
const finderInput = document.querySelector("#finder-input") as HTMLInputElement;
const finderList = document.querySelector("#finder-list") as HTMLElement;
let finderIndex = 0;

interface FinderRow {
  system: SystemItem;
  api: ApiItem | null;
  more: boolean;
}

function finderSystemNamed(system: SystemItem, parsed: Query): boolean {
  if (parsed.method || parsed.path || parsed.title) {
    return false;
  }
  const blob = `${system.name}\n${system.domain || ""}`.toLowerCase();
  if (parsed.sys && !blob.includes(parsed.sys)) {
    return false;
  }
  if (!parsed.text) {
    return Boolean(parsed.sys);
  }
  return blob.includes(parsed.text);
}

function finderApiNamed(api: ApiItem, parsed: Query): boolean {
  if (parsed.method && api.method.toLowerCase() !== parsed.method) {
    return false;
  }
  if (parsed.path && !api.path.toLowerCase().includes(parsed.path)) {
    return false;
  }
  if (parsed.title) {
    const titles = api.cases.map((item, index) => caseTitle(item.content, index)).join("\n").toLowerCase();
    if (!titles.includes(parsed.title)) {
      return false;
    }
  }
  if (parsed.text && !`${api.method}\n${api.path}\n${api.note}`.toLowerCase().includes(parsed.text)) {
    return false;
  }
  return Boolean(parsed.method || parsed.path || parsed.title || parsed.text);
}

function collectFinder(raw: string): { rows: FinderRow[]; capped: boolean } {
  const parsed = parseQuery(raw);
  if (parsed.empty) {
    return { rows: [], capped: false };
  }
  const rows: FinderRow[] = [];
  let shown = 0;
  let capped = false;
  for (const system of library.systems) {
    if (parsed.sys && !`${system.name}\n${system.domain || ""}`.toLowerCase().includes(parsed.sys)) {
      continue;
    }
    const named = finderSystemNamed(system, parsed);
    const listed = named ? system.apis : system.apis.filter((api) => finderApiNamed(api, parsed));
    if (!named && listed.length === 0) {
      continue;
    }
    const room = 80 - shown;
    if (room <= 0) {
      capped = true;
      break;
    }
    const take = listed.slice(0, Math.min(40, room));
    if (take.length < listed.length) {
      capped = true;
    }
    rows.push({ system, api: null, more: take.length < listed.length });
    for (const api of take) {
      rows.push({ system, api, more: false });
      shown += 1;
    }
  }
  return { rows, capped };
}

function scrollFinderHit(node: HTMLElement) {
  const top = node.offsetTop - finderList.offsetTop;
  const bottom = top + node.offsetHeight;
  if (top < finderList.scrollTop) {
    finderList.scrollTop = top;
  } else if (bottom > finderList.scrollTop + finderList.clientHeight) {
    finderList.scrollTop = bottom - finderList.clientHeight;
  }
}

function paintFinder(reset: boolean) {
  const { rows, capped } = collectFinder(finderInput.value);
  finderList.replaceChildren();
  if (parseQuery(finderInput.value).empty) {
    finderList.hidden = true;
    finderIndex = 0;
    return;
  }
  finderList.hidden = false;
  if (reset) {
    const firstApi = rows.findIndex((row) => row.api);
    finderIndex = firstApi >= 0 ? firstApi : 0;
  } else if (rows.length === 0) {
    finderIndex = 0;
  } else if (finderIndex >= rows.length) {
    finderIndex = rows.length - 1;
  }
  if (rows.length === 0) {
    finderList.append(el("p", "finder-empty", "没有匹配"));
    return;
  }
  rows.forEach((row, index) => {
    const hit = button("", index === finderIndex ? "finder-hit on" : "finder-hit", () => pickFinder(row));
    hit.classList.add(row.api ? "api" : "system");
    hit.addEventListener("mousemove", (event) => {
      if ((event.movementX === 0 && event.movementY === 0) || finderIndex === index) {
        return;
      }
      finderIndex = index;
      paintFinder(false);
    });
    if (row.api) {
      hit.append(el("span", `method method-${row.api.method.toLowerCase()}`, row.api.method));
      hit.append(el("span", "path", row.api.path));
      const group = groupName(row.api);
      if (group) {
        hit.append(el("span", "meta", group));
      }
    } else {
      const name = el("span", "name", row.system.name || "未命名");
      if (row.system.color) {
        name.style.color = row.system.color;
      }
      hit.append(name, el("span", "meta", row.more ? `${row.system.domain || "其他"} · 还有更多` : row.system.domain || "其他"));
    }
    finderList.append(hit);
  });
  if (capped) {
    finderList.append(el("p", "finder-more", "还有更多结果，缩小关键字"));
  }
  const active = finderList.querySelector(".finder-hit.on");
  if (active instanceof HTMLElement) {
    scrollFinderHit(active);
  }
}

function pickFinder(row: FinderRow) {
  closeFinder();
  if (row.api) {
    goToApi(row.system, row.api);
    return;
  }
  goToSystem(row.system);
}

function openFinder() {
  closePops();
  closePalette();
  finder.hidden = false;
  paintFinder(true);
  finderInput.focus();
  finderInput.select();
}

function closeFinder() {
  finder.hidden = true;
}

function initFinder() {
  finder.addEventListener("click", (event) => event.stopPropagation());
  finderInput.addEventListener("input", () => paintFinder(true));
  finderInput.addEventListener("keydown", (event) => {
    const { rows } = collectFinder(finderInput.value);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rows.length === 0) {
        return;
      }
      finderIndex = Math.min(rows.length - 1, Math.max(0, finderIndex + (event.key === "ArrowDown" ? 1 : -1)));
      paintFinder(false);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const row = rows[finderIndex];
      if (row) {
        pickFinder(row);
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFinder();
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
    recordLog({ category: "create", action: "导入 Markdown", detail: `${library.systems.length} 个系统` });
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
    recordLog({
      category: "create",
      action: "从 YApi 导入",
      system,
      detail: `新增 ${added} 个接口，跳过 ${skipped} 个`,
    });
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
  ensureGroups(system);
  const existing = new Set(system.apis.map(normalizedKey));
  const fresh = new Map<string, ApiItem>();
  let added = 0;
  let skipped = 0;
  for (const api of project.apis) {
    const incoming = groupName(api);
    if (incoming && !system.groups.includes(incoming)) {
      system.groups.push(incoming);
    }
    const key = normalizedKey(api);
    if (existing.has(key)) {
      skipped += 1;
      const local = system.apis.find((item) => normalizedKey(item) === key);
      if (local && !groupName(local) && groupName(api)) {
        local.group = groupName(api);
      }
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
  if (except?.id === "system-color-menu" || except?.id === "system-domain-menu") {
    return;
  }
  colorMenuHot = false;
  if (except?.id !== "system-menu") {
    document.querySelectorAll("#system-menu .has-sub.open").forEach((node) => node.classList.remove("open"));
  }
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

function applySystemNameBg(color: string | null) {
  const root = document.documentElement;
  const input = document.querySelector("#system-name-bg") as HTMLInputElement;
  if (!color) {
    root.style.removeProperty("--system-name-bg");
    root.style.removeProperty("--system-name-fg");
    root.classList.remove("system-name-bg");
    localStorage.removeItem("system-name-bg");
    input.value = "#f4f1ea";
    return;
  }
  root.style.setProperty("--system-name-bg", color);
  root.style.setProperty("--system-name-fg", isLightColor(color) ? "#1e1c19" : "#eef0ec");
  root.classList.add("system-name-bg");
  input.value = color;
  localStorage.setItem("system-name-bg", color);
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

  const showGroupsInput = document.querySelector("#show-api-groups") as HTMLInputElement | null;
  if (showGroupsInput) {
    showGroupsInput.checked = showApiGroups();
    showGroupsInput.addEventListener("change", () => {
      localStorage.setItem("show-api-groups", showGroupsInput.checked ? "1" : "0");
      render();
    });
  }

  applySystemNameBg(localStorage.getItem("system-name-bg"));
  document.querySelector("#system-name-bg")?.addEventListener("input", (event) => {
    applySystemNameBg((event.currentTarget as HTMLInputElement).value);
  });
  document.querySelector("#system-name-bg-reset")?.addEventListener("click", () => applySystemNameBg(null));

  applyCurlStyle(localStorage.getItem("curl-bg") || DEFAULT_CURL_BG, clampSize(Number(localStorage.getItem("curl-font-size") ?? DEFAULT_FONT_SIZE)));
  colorInput.addEventListener("input", () => applyCurlStyle(colorInput.value, currentSize()));
  sizeInput.addEventListener("change", () => applyCurlStyle(colorInput.value, currentSize()));
  document.querySelector("#curl-bg-reset")?.addEventListener("click", () => applyCurlStyle(DEFAULT_CURL_BG, currentSize()));
  document.querySelector("#curl-size-down")?.addEventListener("click", () => applyCurlStyle(colorInput.value, clampSize(currentSize() - 1)));
  document.querySelector("#curl-size-up")?.addEventListener("click", () => applyCurlStyle(colorInput.value, clampSize(currentSize() + 1)));

  const settings = document.querySelector("#settings") as HTMLElement;
  const placeSettings = () => {
    const toggle = document.querySelector("#settings-toggle") as HTMLElement;
    document.body.append(settings);
    settings.hidden = false;
    settings.style.position = "fixed";
    settings.style.right = "auto";
    settings.style.zIndex = "80";
    const rect = toggle.getBoundingClientRect();
    const margin = 8;
    const width = settings.offsetWidth;
    const height = settings.offsetHeight;
    const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - margin) {
      top = Math.max(margin, rect.top - height - 8);
    }
    settings.style.left = `${left}px`;
    settings.style.top = `${top}px`;
  };
  document.querySelector("#settings-toggle")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const opening = settings.hidden;
    closePops(settings);
    settings.hidden = true;
    if (opening) {
      placeSettings();
    }
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
  let blockClick = false;
  document.addEventListener("mousedown", (event) => {
    if (event.button === 0 && !event.ctrlKey) {
      blockClick = false;
    }
  }, true);
  document.addEventListener("mouseup", (event) => {
    if (event.button !== 0 || event.ctrlKey) {
      blockClick = true;
    }
  }, true);
  document.addEventListener("click", (event) => {
    if (!blockClick) {
      return;
    }
    blockClick = false;
    const target = event.target;
    if (target instanceof Element && target.closest(".pop")) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, true);
  document.addEventListener("click", () => {
    closePops();
    closeFinder();
  });
  detail.addEventListener("scroll", () => closePops(), { passive: true });
  systemList.addEventListener("scroll", () => closePops(), { passive: true });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closePops();
      closeFinder();
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

function setNavHidden(hidden: boolean) {
  document.querySelector(".app")?.classList.toggle("nav-hidden", hidden);
  localStorage.setItem("nav-hidden", hidden ? "1" : "0");
}

function toggleNav() {
  const app = document.querySelector(".app");
  setNavHidden(!app?.classList.contains("nav-hidden"));
}

function focusSearch() {
  closeFinder();
  setNavHidden(false);
  search.focus();
  search.select();
}

const SHORTCUTS = [
  `${modLabel}B  隐藏或显示侧栏`,
  `${modLabel}F  查找系统和 URL，↑↓ 选择，↵ 跳转`,
  `${modLabel}K  聚焦搜索框，↑↓ 在结果里定位，↵ 进入`,
  `${modLabel}P  快速跳转`,
  `${modLabel}S  立刻保存`,
  `${modLabel}⇧I  导入 Markdown`,
  `${modLabel}= / ${modLabel}-  放大缩小 curl 字号`,
  `${modLabel}⇧E / ${modLabel}⇧W  全部展开 / 全部收起`,
  `${modLabel}↵  在粘贴框里添加接口`,
  `接口行：↑↓ 移动，→ 展开，← 收起，↵ 进入第一个用例，${modLabel}C 复制路径`,
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
    case "find":
      openFinder();
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

function initNavResize() {
  const app = document.querySelector(".app") as HTMLElement;
  const handle = document.querySelector("#nav-resize") as HTMLElement;
  const clamp = (width: number) => {
    const max = Math.max(220, Math.min(720, window.innerWidth - 320));
    return Math.round(Math.min(max, Math.max(180, width)));
  };
  const saved = Number(localStorage.getItem("nav-width"));
  const width = saved === 248 ? 300 : saved;
  if (Number.isFinite(width) && width > 0) {
    app.style.setProperty("--nav-width", `${clamp(width)}px`);
    if (width !== saved) {
      localStorage.setItem("nav-width", String(width));
    }
  }
  handle.addEventListener("mousedown", (event) => {
    if (event.button !== 0 || app.classList.contains("nav-hidden")) {
      return;
    }
    event.preventDefault();
    const aside = document.querySelector("aside") as HTMLElement;
    const origin = aside.getBoundingClientRect().width;
    const startX = event.clientX;
    document.body.classList.add("nav-resizing");
    const move = (ev: MouseEvent) => {
      app.style.setProperty("--nav-width", `${clamp(origin + ev.clientX - startX)}px`);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.classList.remove("nav-resizing");
      const width = Number.parseFloat(app.style.getPropertyValue("--nav-width"));
      if (Number.isFinite(width)) {
        localStorage.setItem("nav-width", String(Math.round(width)));
      }
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

function init() {
  setNavHidden(localStorage.getItem("nav-hidden") === "1");
  initNavResize();
  document.querySelector("#nav-hide")?.addEventListener("click", toggleNav);
  document.querySelector("#nav-show")?.addEventListener("click", toggleNav);
  const searchKey = document.querySelector(".search-wrap kbd");
  if (searchKey) {
    searchKey.textContent = isApple ? "⌘K" : "Ctrl K";
  }
  initAppearance();
  initPalette();
  initFinder();
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
  document.querySelector("#log-toggle")?.addEventListener("click", () => {
    if (logView) {
      logView = false;
      render();
      return;
    }
    showLogs();
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
  document.querySelector("#path-form")?.addEventListener("submit", submitPath);
  document.querySelector("#path-cancel")?.addEventListener("click", () => closePathDialog());
  const pathDialog = document.querySelector("#path-dialog") as HTMLElement;
  pathDialog.addEventListener("click", (event) => {
    if (event.target === pathDialog) {
      closePathDialog();
    }
  });
  pathDialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePathDialog();
    }
  });
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
    if (key === "f" && !event.shiftKey && !event.altKey) {
      const ask = document.querySelector("#ask") as HTMLElement | null;
      if (ask && !ask.hidden) {
        return;
      }
      event.preventDefault();
      openFinder();
    } else if (key === "k") {
      event.preventDefault();
      focusSearch();
    } else if (key === "b") {
      event.preventDefault();
      toggleNav();
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
      for (const system of library.systems) {
        system.color = system.color || "";
        ensureGroups(system);
      }
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
