export interface CaseItem {
  id: string;
  content: string;
  updatedAt: number;
}

export interface ApiItem {
  id: string;
  method: string;
  path: string;
  note: string;
  /** 空字符串表示未分组。 */
  group: string;
  starred: boolean;
  updatedAt: number;
  cases: CaseItem[];
}

export interface LinkItem {
  id: string;
  label: string;
  url: string;
  kind: "env" | "doc";
  host: string;
  note: string;
}

export interface VariableItem {
  id: string;
  name: string;
  value: string;
  secret: boolean;
  /** 空字符串表示全局变量，否则是环境的 id。 */
  envId: string;
}

export interface SystemItem {
  id: string;
  name: string;
  domain: string;
  note: string;
  groups: string[];
  links: LinkItem[];
  variables: VariableItem[];
  apis: ApiItem[];
}

export interface Library {
  systems: SystemItem[];
}

export interface YapiProject {
  name: string;
  basepath: string;
  envs: LinkItem[];
  apis: ApiItem[];
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  millis: number;
  timedOut: boolean;
  killed: boolean;
}
