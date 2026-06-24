#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

import { confirm, input, password as promptPassword } from "@inquirer/prompts";
import { Command, Option } from "commander";

import { KubeSphereClient } from "./kubesphere-client.js";
import {
  buildOutputPath,
  chooseContainer,
  chooseDateSelection,
  chooseHistoryFiles,
  chooseLogRange,
  chooseLogSource,
  chooseNamespace,
  choosePod,
  chooseSavedProfile,
  chooseTarget,
  promptConnection,
  promptNewProfileName
} from "./prompts.js";
import type { ConnectionAnswers } from "./prompts.js";
import {
  getProfile,
  readProfiles,
  removeProfile,
  setDefaultProfile,
  upsertProfile
} from "./profile-store.js";
import {
  exportHistoryLogs,
  filterHistoryFilesByService,
  listHistoryFiles,
  statHistoryFiles
} from "./history-logs.js";
import type { DateSelection, HistoryLogFile, KubeTarget, LogRange, LogSource, PodSummary } from "./types.js";
import {
  buildLogFileName,
  defaultOutputDir,
  formatBytes,
  normalizeBaseUrl
} from "./utils.js";
import { ProgressBar } from "./progress.js";

interface ConnectionOptions {
  profile?: string;
  url?: string;
  username?: string;
  password?: string;
  insecure?: boolean;
}

interface DownloadOptions extends ConnectionOptions {
  namespace?: string;
  service?: string;
  pod?: string;
  container?: string;
  tailLines?: number;
  sinceMinutes?: number;
  all?: boolean;
  outputDir?: string;
  source?: LogSource;
  historyPath?: string;
  date?: string;
  from?: string;
  to?: string;
  recentDays?: number;
  historyFile?: string[];
}

const program = new Command();

program
  .name("kslog")
  .description("KubeSphere 日志下载 CLI")
  .version("0.3.2");

addConnectionOptions(program);
addDownloadOptions(program);

program.action(async (options: DownloadOptions) => {
  await runDownloadFlow(options);
});

const loginCheck = program
  .command("login-check")
  .description("验证 KubeSphere 地址和账号能否登录");
addConnectionOptions(loginCheck);
loginCheck.action(async (options: ConnectionOptions, command: Command) => {
  const mergedOptions = mergeCommandOptions<ConnectionOptions>(options, command);
  const { client, connection } = await loginFromOptions(mergedOptions);
  const namespaces = await client.listNamespaces();
  console.log(`登录成功：${connection.username} @ ${connection.baseUrl}`);
  console.log(`可见 namespace 数量：${namespaces.length}`);
});

const download = program.command("download").description("下载指定服务/工作负载的容器日志");
addConnectionOptions(download);
addDownloadOptions(download);
download.action(async (options: DownloadOptions, command: Command) => {
  await runDownloadFlow(mergeCommandOptions<DownloadOptions>(options, command));
});

const current = program.command("current").description("下载当前容器日志");
addConnectionOptions(current);
addDownloadOptions(current);
current.action(async (options: DownloadOptions, command: Command) => {
  await runDownloadFlow({ ...mergeCommandOptions<DownloadOptions>(options, command), source: "current" });
});

const history = program.command("history").description("下载 /opt/saas-logs 历史日志");
addConnectionOptions(history);
addDownloadOptions(history);
history.action(async (options: DownloadOptions, command: Command) => {
  await runDownloadFlow({ ...mergeCommandOptions<DownloadOptions>(options, command), source: "history" });
});

const profile = program.command("profile").description("管理已保存的 KubeSphere 环境");
profile.command("list").description("列出环境").action(async () => {
  const config = await readProfiles();
  if (config.profiles.length === 0) {
    console.log("还没有保存的环境");
    return;
  }

  for (const item of config.profiles) {
    const marker = item.name === config.defaultProfile ? "*" : " ";
    console.log(`${marker} ${item.name}\t${item.url}\t${item.username}`);
  }
});
profile.command("add").description("新增或更新环境").action(async () => {
  const name = await input({ message: "环境名称", required: true });
  const url = await input({ message: "KubeSphere 地址", default: "http://192.168.7.191:30880", required: true });
  const username = await input({ message: "用户名", default: "admin", required: true });
  const password = await promptPassword({ message: "密码", mask: "*" });
  const insecure = await confirm({ message: "是否允许 https 自签名证书", default: false });
  const setDefault = await confirm({ message: "设为默认环境", default: true });

  console.warn("提示：密码会按你的选择明文保存到 ~/.kslog/profiles.json。");
  const saved = await upsertProfile({ name, url, username, password, insecure, setDefault });
  console.log(`已保存环境：${saved.name}`);
});
profile.command("remove <name>").description("删除环境").action(async (name: string) => {
  const removed = await removeProfile(name);
  console.log(removed ? `已删除环境：${name}` : `环境不存在：${name}`);
});
profile.command("use <name>").description("设置默认环境").action(async (name: string) => {
  await setDefaultProfile(name);
  console.log(`默认环境已设置为：${name}`);
});

program.parseAsync(process.argv).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`错误：${message}`);
  process.exitCode = 1;
});

function addConnectionOptions(command: Command): void {
  command
    .addOption(new Option("--profile <name>", "使用已保存的环境").env("KSLOG_PROFILE"))
    .addOption(new Option("--url <url>", "KubeSphere 地址，例如 http://192.168.7.191:30880").env("KSLOG_URL"))
    .addOption(new Option("-u, --username <username>", "用户名").env("KSLOG_USERNAME"))
    .addOption(new Option("-p, --password <password>", "密码").env("KSLOG_PASSWORD"))
    .option("--insecure", "允许 https 自签名证书");
}

function addDownloadOptions(command: Command): void {
  command
    .option("-n, --namespace <namespace>", "namespace")
    .option("-s, --service <service>", "服务或工作负载名称")
    .option("--pod <pod>", "Pod 名称")
    .option("-c, --container <container>", "容器名称")
    .addOption(new Option("--source <source>", "日志来源").choices(["current", "history"]))
    .option("--tail-lines <number>", "当前日志：最近 N 行", parsePositiveInteger)
    .option("--since-minutes <number>", "当前日志：最近 N 分钟", parsePositiveInteger)
    .option("--all", "当前日志：下载全部当前日志")
    .option("--history-path <path>", "历史日志根路径", "/opt/saas-logs")
    .option("--date <date>", "历史日志：指定日期 YYYY-MM-DD")
    .option("--from <date>", "历史日志：开始日期 YYYY-MM-DD")
    .option("--to <date>", "历史日志：结束日期 YYYY-MM-DD")
    .option("--recent-days <number>", "历史日志：最近 N 天", parsePositiveInteger)
    .option("--history-file <path...>", "历史日志：指定远端文件，可传多个")
    .option("-o, --output-dir <dir>", "输出目录");
}

function mergeCommandOptions<T extends object>(options: T, command: Command): T {
  return {
    ...(command.parent?.opts<Record<string, unknown>>() ?? {}),
    ...command.opts<Record<string, unknown>>(),
    ...options
  } as T;
}

async function runDownloadFlow(options: DownloadOptions): Promise<void> {
  const { client, connection } = await loginFromOptions(options);
  console.log(`已登录：${connection.username} @ ${connection.baseUrl}`);

  const { namespace, target, pod, container } = await chooseKubeTarget(client, options);
  const source = await chooseLogSource(options.source);

  if (source === "history") {
    await runHistoryDownload(client, options, namespace, target, pod, container);
    return;
  }

  await runCurrentDownload(client, options, namespace, target, pod, container);
}

async function chooseKubeTarget(client: KubeSphereClient, options: DownloadOptions): Promise<{
  namespace: string;
  target: KubeTarget;
  pod: PodSummary;
  container: string;
}> {
  const namespaces = await client.listNamespaces();
  if (namespaces.length === 0) {
    throw new Error("当前账号没有可见 namespace");
  }

  const namespace = await chooseNamespace(namespaces, options.namespace);
  const targets = await client.listTargets(namespace);
  if (targets.length === 0) {
    throw new Error(`namespace ${namespace} 中没有可选择的 Service/Deployment`);
  }

  const target = options.service
    ? await client.resolveTarget(namespace, options.service)
    : await chooseTarget(targets);
  const pods = await client.listPodsForTarget(target);
  if (pods.length === 0) {
    throw new Error(`${target.kind} ${target.name} 没有匹配的 Pod`);
  }

  const pod = await choosePod(pods, options.pod);
  if (pod.containers.length === 0) {
    throw new Error(`Pod ${pod.name} 中没有可选容器`);
  }

  return {
    namespace,
    target,
    pod,
    container: await chooseContainer(pod.containers, options.container)
  };
}

async function runCurrentDownload(
  client: KubeSphereClient,
  options: DownloadOptions,
  namespace: string,
  target: KubeTarget,
  pod: PodSummary,
  container: string
): Promise<void> {
  const range = await chooseLogRange({
    tailLines: options.tailLines,
    sinceMinutes: options.sinceMinutes,
    all: options.all
  });
  const outputPath = await buildOutputPath({
    namespace,
    service: target.name,
    pod: pod.name,
    outputDir: options.outputDir
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  printCurrentDownloadSummary(namespace, target.name, pod.name, container, range, outputPath);

  const progress = new ProgressBar();
  await client.downloadLog({
    namespace,
    pod: pod.name,
    container,
    range,
    outputPath,
    timestamps: true,
    onProgress: (bytes) =>
      progress.update({
        label: "当前日志",
        currentBytes: bytes
      })
  });

  const stats = await fs.stat(outputPath);
  progress.done(`下载完成：${outputPath}`);
  console.log(`文件大小：${formatBytes(stats.size)}`);
}

async function runHistoryDownload(
  client: KubeSphereClient,
  options: DownloadOptions,
  namespace: string,
  target: KubeTarget,
  pod: PodSummary,
  container: string
): Promise<void> {
  const historyPath = options.historyPath ?? "/opt/saas-logs";
  const dateSelection = await chooseDateSelection({
    date: options.date,
    from: options.from,
    to: options.to,
    recentDays: options.recentDays
  });
  const progress = new ProgressBar();

  let files: HistoryLogFile[] | undefined = options.historyFile?.map((file) => ({ path: file }));
  if (files && files.length > 0) {
    progress.update({
      label: "读取历史日志大小",
      currentBytes: 0,
      extra: `${files.length} 个文件`
    });
    files = await statHistoryFiles(client, { namespace, pod: pod.name, container, historyPath }, options.historyFile ?? []);
  } else {
    progress.update({
      label: "列历史日志文件",
      currentBytes: 0,
      extra: historyPath
    });
    const allFiles = await listHistoryFiles(client, { namespace, pod: pod.name, container, historyPath });
    const serviceFiles = filterHistoryFilesByService(allFiles, target.name);
    files = serviceFiles.length > 0 ? serviceFiles : allFiles;

    if (serviceFiles.length === 0) {
      console.log(`没有找到路径包含 ${target.name} 的历史文件，改为展示全部 ${allFiles.length} 个文件。`);
    }

    files = await chooseHistoryFiles(files);
  }

  if (files.length === 0) {
    throw new Error("未选择历史日志文件");
  }

  const outputPath = await buildHistoryOutputPath({
    namespace,
    service: target.name,
    pod: pod.name,
    dateSelection,
    outputDir: options.outputDir
  });
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  console.log("开始导出历史日志：");
  console.log(`  namespace: ${namespace}`);
  console.log(`  service:   ${target.name}`);
  console.log(`  pod:       ${pod.name}`);
  console.log(`  container: ${container}`);
  console.log(`  path:      ${historyPath}`);
  console.log(`  dates:     ${dateSelection.from} ~ ${dateSelection.to}`);
  console.log(`  files:     ${files.length}`);
  console.log(`  output:    ${outputPath}`);

  const result = await exportHistoryLogs(client, {
    namespace,
    pod: pod.name,
    container,
    historyPath,
    files,
    dateSelection,
    outputPath,
    onProgress: (snapshot) =>
      progress.update({
        label: `历史日志 ${snapshot.fileIndex}/${snapshot.fileCount}`,
        currentBytes:
          typeof snapshot.totalSourceBytes === "number"
            ? snapshot.sourceBytesProcessed
            : snapshot.bytesWritten,
        totalBytes: snapshot.totalSourceBytes,
        extra: `写入 ${formatBytes(snapshot.bytesWritten)}  ${snapshot.currentFile ? path.basename(snapshot.currentFile) : ""}`
      })
  });
  const stats = await fs.stat(outputPath);

  progress.done(`历史日志导出完成：${outputPath}`);
  console.log(`文件大小：${formatBytes(stats.size)}`);
  console.log(`扫描文件：${result.scannedFiles}，有匹配：${result.matchedFiles}，跳过：${result.skippedFiles}`);

  if (result.matchedFiles === 0) {
    console.log("没有导出匹配日期的日志行。");
  }
}

async function loginFromOptions(options: ConnectionOptions): Promise<{
  client: KubeSphereClient;
  connection: ConnectionAnswers;
}> {
  const { connection, newProfileName } = await resolveConnection(options);
  const client = new KubeSphereClient({
    baseUrl: connection.baseUrl,
    insecure: connection.insecure
  });

  await client.login(connection.username, connection.password);
  if (newProfileName) {
    const saved = await upsertProfile({
      name: newProfileName,
      url: connection.baseUrl,
      username: connection.username,
      password: connection.password,
      insecure: connection.insecure,
      setDefault: true
    });
    console.log(`已保存环境：${saved.name}`);
  }

  return { client, connection };
}

async function resolveConnection(options: ConnectionOptions): Promise<{
  connection: ConnectionAnswers;
  newProfileName?: string;
}> {
  const config = await readProfiles();

  if (options.profile) {
    const profile = await getProfile(options.profile);
    if (!profile) {
      throw new Error(`profile 不存在：${options.profile}`);
    }
    return {
      connection: await promptConnection({
        baseUrl: options.url ? normalizeBaseUrl(options.url) : profile.url,
        username: options.username ?? profile.username,
        password: options.password ?? profile.password,
        insecure: options.insecure ?? profile.insecure
      })
    };
  }

  if (options.url || options.username || options.password) {
    return {
      connection: await promptConnection({
        baseUrl: options.url ? normalizeBaseUrl(options.url) : undefined,
        username: options.username,
        password: options.password,
        insecure: options.insecure
      })
    };
  }

  const choice = await chooseSavedProfile(config.profiles, config.defaultProfile);
  if (choice.kind === "saved") {
    return {
      connection: await promptConnection({
        baseUrl: choice.profile.url,
        username: choice.profile.username,
        password: choice.profile.password,
        insecure: options.insecure ?? choice.profile.insecure
      })
    };
  }

  const newProfileName = await promptNewProfileName(config.profiles.map((profile) => profile.name));
  return {
    connection: await promptConnection({
      insecure: options.insecure
    }),
    newProfileName
  };
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`需要正整数：${value}`);
  }

  return parsed;
}

function printCurrentDownloadSummary(
  namespace: string,
  service: string,
  pod: string,
  container: string,
  range: LogRange,
  outputPath: string
): void {
  const rangeText =
    range.mode === "all"
      ? "全部当前日志"
      : range.mode === "tail"
        ? `最近 ${range.tailLines} 行`
        : `最近 ${Math.round((range.sinceSeconds ?? 0) / 60)} 分钟`;

  console.log("开始下载当前日志：");
  console.log(`  namespace: ${namespace}`);
  console.log(`  service:   ${service}`);
  console.log(`  pod:       ${pod}`);
  console.log(`  container: ${container}`);
  console.log(`  range:     ${rangeText}`);
  console.log(`  output:    ${outputPath}`);
}

async function buildHistoryOutputPath(options: {
  namespace: string;
  service: string;
  pod: string;
  dateSelection: DateSelection;
  outputDir?: string;
}): Promise<string> {
  const outputDir = options.outputDir ?? defaultOutputDir(process.env.HOME ?? "");
  const datePart =
    options.dateSelection.from === options.dateSelection.to
      ? options.dateSelection.from
      : `${options.dateSelection.from}_to_${options.dateSelection.to}`;
  const fileName = buildLogFileName(options.namespace, `${options.service}_history_${datePart}`, options.pod);
  return path.join(outputDir, fileName);
}
