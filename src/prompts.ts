import os from "node:os";
import path from "node:path";

import { checkbox, confirm, input, number, password, select } from "@inquirer/prompts";

import { addDays, assertDateString, buildDateRange, buildDateSelection, formatLocalDate } from "./date-utils.js";
import type {
  DateSelection,
  HistoryLogFile,
  KubeTarget,
  LeqiAction,
  LeqiApiInfo,
  LeqiReqDto,
  LogRange,
  LogSource,
  PodSummary,
  SavedProfile
} from "./types.js";
import { formatRedisTargetChoice, type RedisAction, type RedisConnection, type RedisOperation } from "./redis.js";
import { formatLeqiApiChoice, parseReqDtoJson } from "./leqi.js";
import { buildLogFileName, defaultOutputDir, formatBytes, normalizeBaseUrl } from "./utils.js";

const NEW_PROFILE_VALUE = "__new__";
export const DEFAULT_NAMESPACE = "tax-digital";

export interface ConnectionAnswers {
  baseUrl: string;
  username: string;
  password: string;
  insecure?: boolean;
}

export type WorkctlFeature = "logs" | "leqi" | "redis" | "exit";
export type RedisActionChoice = RedisAction | "back";

export type ProfileChoice =
  | {
      kind: "saved";
      profile: SavedProfile;
    }
  | {
      kind: "new";
    };

export async function chooseSavedProfile(
  profiles: SavedProfile[],
  defaultProfile?: string
): Promise<ProfileChoice> {
  if (profiles.length === 0) {
    return { kind: "new" };
  }

  const choices = profiles.map((profile) => ({
    name: profile.name === defaultProfile ? `${profile.name} (默认)` : profile.name,
    value: profile.name
  }));
  choices.push({ name: "新增环境", value: NEW_PROFILE_VALUE });

  const selected = await select({
    message: "选择 KubeSphere 环境",
    choices,
    default: defaultProfile ?? profiles[0]?.name
  });

  if (selected === NEW_PROFILE_VALUE) {
    return { kind: "new" };
  }

  const profile = profiles.find((item) => item.name === selected);
  if (!profile) {
    throw new Error(`profile 不存在：${selected}`);
  }

  return { kind: "saved", profile };
}

export async function promptConnection(defaults: Partial<ConnectionAnswers>): Promise<ConnectionAnswers> {
  const baseUrl =
    defaults.baseUrl ??
    normalizeBaseUrl(
      await input({
        message: "KubeSphere 地址",
        default: "http://192.168.7.191:30880",
        required: true
      })
    );

  const username =
    defaults.username ??
    (await input({
      message: "用户名",
      default: "admin",
      required: true
    }));

  const secret =
    defaults.password ??
    (await password({
      message: "密码",
      mask: "*"
    }));

  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    username,
    password: secret,
    insecure: defaults.insecure
  };
}

export async function promptNewProfileName(existingNames: string[]): Promise<string> {
  const existing = new Set(existingNames);
  const name = await input({
    message: "新环境名称",
    required: true,
    validate: (value) => {
      const name = value.trim();
      if (!name) {
        return "环境名称不能为空";
      }
      if (existing.has(name)) {
        return "环境名称已存在，请换一个";
      }
      return true;
    },
    transformer: (value) => value.trim()
  });
  return name.trim();
}

export function preferredNamespace(namespaces: string[], preferred = DEFAULT_NAMESPACE): string | undefined {
  return namespaces.includes(preferred) ? preferred : namespaces[0];
}

export async function chooseWorkctlFeature(): Promise<WorkctlFeature> {
  return select({
    message: "选择功能",
    choices: [
      { name: "K8s 日志", value: "logs" },
      { name: "乐企接口", value: "leqi" },
      { name: "Redis 工具", value: "redis" },
      { name: "退出", value: "exit" }
    ]
  });
}

export async function chooseNamespace(namespaces: string[], provided?: string): Promise<string> {
  if (provided) {
    if (!namespaces.includes(provided)) {
      throw new Error(`namespace 不存在：${provided}`);
    }
    return provided;
  }

  return select({
    message: "选择 namespace",
    pageSize: 15,
    default: preferredNamespace(namespaces),
    choices: namespaces.map((name) => ({ name, value: name }))
  });
}

export async function chooseTarget(targets: KubeTarget[], provided?: string): Promise<KubeTarget> {
  if (provided) {
    const target = targets.find((item) => item.name === provided);

    if (!target) {
      throw new Error(`工作负载不存在：${provided}`);
    }

    return target;
  }

  return select({
    message: "选择工作负载",
    pageSize: 15,
    choices: targets.map((target) => ({
      name: formatTargetChoice(target),
      value: target
    }))
  });
}

export async function chooseRedisTargetCandidate(targets: KubeTarget[]): Promise<KubeTarget> {
  return select({
    message: "选择 Redis 工作负载",
    pageSize: 12,
    choices: targets.map((target) => ({
      name: formatRedisTargetChoice(target),
      value: target
    }))
  });
}

export function formatTargetChoice(target: KubeTarget): string {
  const desired = target.desiredReplicas ?? 0;
  const ready = target.readyReplicas ?? 0;
  return `${target.name}  工作负载(Deployment)  (${ready}/${desired})`;
}

export async function choosePod(pods: PodSummary[], provided?: string): Promise<PodSummary> {
  if (provided) {
    const pod = pods.find((item) => item.name === provided);

    if (!pod) {
      throw new Error(`Pod 不存在：${provided}`);
    }

    return pod;
  }

  if (pods.length === 1) {
    return pods[0];
  }

  return select({
    message: "选择 Pod",
    pageSize: 12,
    choices: pods.map((pod) => ({
      name: `${pod.name}  ${pod.phase}  Ready ${pod.ready}  重启 ${pod.restartCount}`,
      value: pod
    }))
  });
}

export async function chooseContainer(containers: string[], provided?: string): Promise<string> {
  if (provided) {
    if (!containers.includes(provided)) {
      throw new Error(`容器不存在：${provided}`);
    }
    return provided;
  }

  if (containers.length === 1) {
    return containers[0];
  }

  return select({
    message: "选择容器",
    choices: containers.map((container) => ({
      name: container,
      value: container
    }))
  });
}

export async function chooseLogRange(options: {
  tailLines?: number;
  sinceMinutes?: number;
  all?: boolean;
}): Promise<LogRange> {
  if (options.tailLines) {
    return { mode: "tail", tailLines: options.tailLines };
  }

  if (options.sinceMinutes) {
    return { mode: "since", sinceSeconds: options.sinceMinutes * 60 };
  }

  if (options.all) {
    return { mode: "all" };
  }

  const choice = await select({
    message: "选择日志范围",
    choices: [
      { name: "全部当前日志", value: "all" },
      { name: "最近 1000 行", value: "tail-1000" },
      { name: "最近 5000 行", value: "tail-5000" },
      { name: "最近 1 小时", value: "since-60" },
      { name: "自定义最近 N 行", value: "tail-custom" },
      { name: "自定义最近 N 分钟", value: "since-custom" }
    ]
  });

  if (choice === "all") {
    return { mode: "all" };
  }

  if (choice.startsWith("tail-") && choice !== "tail-custom") {
    return { mode: "tail", tailLines: Number(choice.replace("tail-", "")) };
  }

  if (choice.startsWith("since-") && choice !== "since-custom") {
    return { mode: "since", sinceSeconds: Number(choice.replace("since-", "")) * 60 };
  }

  if (choice === "tail-custom") {
    const value = await number({
      message: "最近多少行",
      default: 1000,
      min: 1,
      required: true
    });
    return { mode: "tail", tailLines: value };
  }

  const value = await number({
    message: "最近多少分钟",
    default: 60,
    min: 1,
    required: true
  });
  return { mode: "since", sinceSeconds: value * 60 };
}

export async function chooseLogSource(provided?: LogSource): Promise<LogSource> {
  if (provided) {
    return provided;
  }

  return select({
    message: "选择日志来源",
    choices: [
      { name: "当前容器日志 (Kubernetes Pod log)", value: "current" },
      { name: "历史文件日志 (/opt/saas-logs)", value: "history" }
    ]
  });
}

export async function chooseLeqiApi(apis: LeqiApiInfo[], provided?: string): Promise<LeqiApiInfo> {
  if (apis.length === 0) {
    throw new Error("没有可用的乐企接口");
  }

  if (provided) {
    const api = apis.find((item) => item.apiIdentity === provided);
    if (!api) {
      throw new Error(`乐企接口不存在：${provided}`);
    }
    return api;
  }

  return select({
    message: "选择乐企接口",
    pageSize: 20,
    choices: apis.map((api) => ({
      name: formatLeqiApiChoice(api),
      value: api
    }))
  });
}

export async function chooseLeqiAction(provided?: LeqiAction): Promise<LeqiAction> {
  if (provided) {
    return provided;
  }

  return select({
    message: "选择操作",
    choices: [
      { name: "导出 curl（使用文档模板）", value: "curl" },
      { name: "直接调用（使用文档模板）", value: "call" }
    ],
    default: "curl"
  });
}

export async function promptLeqiReqDto(options: {
  provided?: string;
  defaultReqDto?: LeqiReqDto;
} = {}): Promise<LeqiReqDto> {
  if (options.provided) {
    return parseReqDtoJson(options.provided);
  }

  if (options.defaultReqDto) {
    return options.defaultReqDto;
  }

  return {};
}

export async function promptRedisConnection(options: {
  host?: string;
  defaultHost?: string;
  port?: number;
  db?: number;
  password?: string;
}): Promise<RedisConnection> {
  const host =
    options.host ??
    (await input({
      message: "Redis host",
      default: options.defaultHost,
      required: true
    }));
  const port =
    options.port ??
    (await number({
      message: "Redis port",
      default: 6379,
      min: 1,
      required: true
    }));
  const db =
    options.db ??
    (await number({
      message: "Redis db",
      default: 0,
      min: 0,
      required: true
    }));
  const redisPassword =
    options.password ??
    (await password({
      message: "Redis 密码",
      mask: "*"
    }));
  if (!redisPassword) {
    throw new Error("Redis 密码不能为空");
  }

  return {
    host: host.trim(),
    port,
    db,
    password: redisPassword
  };
}

export async function chooseRedisAction(provided?: RedisAction): Promise<RedisActionChoice> {
  if (provided) {
    return provided;
  }

  return select({
    message: "选择 Redis 操作",
    choices: [
      { name: "PING", value: "ping" },
      { name: "INFO", value: "info" },
      { name: "GET key", value: "get" },
      { name: "SCAN pattern", value: "scan" },
      { name: "执行自定义命令", value: "custom" },
      { name: "返回上一级", value: "back" }
    ],
    default: "ping"
  });
}

export async function promptRedisOperation(options: {
  action: RedisAction;
  key?: string;
  pattern?: string;
  command?: string;
}): Promise<RedisOperation> {
  switch (options.action) {
    case "ping":
      return { action: "ping" };
    case "info":
      return { action: "info" };
    case "get":
      return {
        action: "get",
        key:
          options.key ??
          (await input({
            message: "Redis key",
            required: true
          }))
      };
    case "scan":
      return {
        action: "scan",
        pattern:
          options.pattern ??
          (await input({
            message: "Redis key pattern",
            default: "*",
            required: true
          }))
      };
    case "custom":
      return {
        action: "custom",
        command:
          options.command ??
          (await input({
            message: "Redis 自定义命令",
            required: true
          }))
      };
  }
}

export async function chooseDateSelection(options: {
  date?: string;
  from?: string;
  to?: string;
  recentDays?: number;
}): Promise<DateSelection> {
  if (options.date || options.from || options.to || options.recentDays) {
    return buildDateSelection(options);
  }

  const today = new Date();
  const todayText = formatLocalDate(today);
  const yesterdayText = formatLocalDate(addDays(today, -1));
  const choice = await select({
    message: "选择历史日志日期",
    choices: [
      { name: `今天 (${todayText})`, value: "today" },
      { name: `昨天 (${yesterdayText})`, value: "yesterday" },
      { name: "最近 N 天", value: "recent" },
      { name: "指定日期", value: "date" },
      { name: "日期范围", value: "range" }
    ]
  });

  if (choice === "today") {
    return buildDateSelection({ date: todayText });
  }

  if (choice === "yesterday") {
    return buildDateSelection({ date: yesterdayText });
  }

  if (choice === "recent") {
    const days = await number({
      message: "最近多少天",
      default: 3,
      min: 1,
      required: true
    });
    return buildDateSelection({ recentDays: days });
  }

  if (choice === "date") {
    const date = await input({
      message: "日期 YYYY-MM-DD",
      default: todayText,
      required: true,
      validate: (value) => {
        try {
          assertDateString(value);
          return true;
        } catch (error) {
          return (error as Error).message;
        }
      }
    });
    return buildDateSelection({ date });
  }

  const from = await input({
    message: "开始日期 YYYY-MM-DD",
    default: yesterdayText,
    required: true,
    validate: (value) => {
      try {
        assertDateString(value);
        return true;
      } catch (error) {
        return (error as Error).message;
      }
    }
  });
  const to = await input({
    message: "结束日期 YYYY-MM-DD",
    default: todayText,
    required: true,
    validate: (value) => {
      try {
        buildDateRange(from, value);
        return true;
      } catch (error) {
        return (error as Error).message;
      }
    }
  });

  return buildDateSelection({ from, to });
}

export async function chooseHistoryFiles(files: HistoryLogFile[]): Promise<HistoryLogFile[]> {
  if (files.length === 0) {
    throw new Error("没有可选历史日志文件");
  }

  if (files.length === 1) {
    const useOnlyFile = await confirm({
      message: `只找到 1 个历史日志文件，是否下载：${formatHistoryFileChoice(files[0])}`,
      default: true
    });
    return useOnlyFile ? files : [];
  }

  return checkbox({
    message: "选择历史日志文件",
    pageSize: 15,
    required: true,
    choices: files.map((file) => ({
      name: formatHistoryFileChoice(file),
      value: file,
      checked: files.length <= 5
    }))
  });
}

export async function buildOutputPath(options: {
  namespace: string;
  service: string;
  pod: string;
  outputDir?: string;
}): Promise<string> {
  const outputDir = options.outputDir ?? defaultOutputDir(os.homedir());
  const fileName = buildLogFileName(options.namespace, options.service, options.pod);
  return path.join(outputDir, fileName);
}

function formatHistoryFileChoice(file: HistoryLogFile): string {
  return typeof file.size === "number" ? `${file.path}  ${formatBytes(file.size)}` : file.path;
}
