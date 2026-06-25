#!/usr/bin/env node
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { confirm, input, number, password as promptPassword, select } from "@inquirer/prompts";
import { Command, Option } from "commander";

import { KubeSphereClient } from "./kubesphere-client.js";
import {
  buildOutputPath,
  chooseLeqiAction,
  chooseLeqiApi,
  chooseContainer,
  chooseDateSelection,
  chooseHistoryFiles,
  chooseLexiangCatalog,
  chooseLexiangInterface,
  chooseLexiangNextAction,
  chooseLexiangProfile,
  chooseLogRange,
  chooseLogSource,
  chooseNamespace,
  choosePod,
  chooseRedisAction,
  chooseRedisTargetCandidate,
  chooseSavedProfile,
  chooseTarget,
  chooseBosscliFeature,
  promptLexiangBusinessPayload,
  promptLexiangProfile,
  promptLeqiReqDto,
  promptConnection,
  promptNewProfileName,
  promptRedisOperation
} from "./prompts.js";
import type { BosscliFeature, ConnectionAnswers } from "./prompts.js";
import {
  getProfile,
  readProfiles,
  removeProfile,
  setDefaultProfile,
  setProfileRedisConfig,
  setProfileRedisPassword,
  upsertProfile
} from "./profile-store.js";
import { readLexiangProfiles, upsertLexiangProfile } from "./lexiang-profile-store.js";
import {
  exportHistoryLogs,
  filterHistoryFilesByService,
  listHistoryFiles,
  statHistoryFiles
} from "./history-logs.js";
import type {
  DateSelection,
  HistoryLogFile,
  KubeServiceSummary,
  KubeTarget,
  LexiangProfile,
  LogRange,
  LogSource,
  PodSummary
} from "./types.js";
import {
  buildLogFileName,
  defaultOutputDir,
  formatBytes,
  normalizeBaseUrl
} from "./utils.js";
import { ProgressBar } from "./progress.js";
import { copyToClipboard } from "./clipboard.js";
import {
  buildLeqiCurl,
  buildLeqiExecCurlCommand,
  buildLeqiInvokePayload,
  buildLeqiReqDtoDefault,
  DEFAULT_LEQI_ENDPOINT,
  DEFAULT_LEQI_RUNNER_WORKLOAD,
  DEFAULT_LEQI_TAX_PAYER_NO,
  findLeqiReqDtoTemplate,
  formatLeqiReqDtoTemplateSummary,
  formatLeqiReqDtoTemplateSource,
  listLeqiApis
} from "./leqi.js";
import {
  buildLexiangBusinessPayloadDefault,
  buildLexiangCurl,
  formatLexiangTemplateSummary,
  listLexiangCatalogs,
  listLexiangInterfaces
} from "./lexiang.js";
import type { LexiangCatalogInfo } from "./lexiang.js";
import {
  REDIS_CLI_MISSING_MARKER,
  buildRedisCliCommand,
  describeRedisConnection,
  describeRedisOperation,
  autoRedisTarget,
  formatRedisTargetChoice,
  isDangerousRedisCommand,
  isRedisAuthFailureOutput,
  isRedisTarget,
  formatRedisServiceChoice,
  preferredRedisServicePort,
  redisServiceDnsName,
  redactRedisPassword,
  redisServiceHost,
  sortRedisServices,
  sortRedisTargets,
  type RedisAction,
  type RedisConnection,
  type RedisOperation
} from "./redis.js";
import { openUrl } from "./open-url.js";

interface ConnectionOptions {
  profile?: string;
  url?: string;
  username?: string;
  password?: string;
  insecure?: boolean;
}

interface KubeTargetOptions {
  namespace?: string;
  workload?: string;
  service?: string;
  pod?: string;
  container?: string;
}

interface DownloadOptions extends ConnectionOptions, KubeTargetOptions {
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

interface LeqiOptions extends ConnectionOptions {
  api?: string;
  taxPayerNo?: string;
  testMode?: number;
  reqDto?: string;
  action?: "curl" | "call";
  endpoint?: string;
  namespace?: string;
  runnerWorkload?: string;
  pod?: string;
  container?: string;
}

interface RedisOptions extends ConnectionOptions, KubeTargetOptions {
  redisHost?: string;
  redisPort?: number;
  redisDb?: number;
  redisPassword?: string;
  redisAction?: RedisAction;
  key?: string;
  pattern?: string;
  redisCommand?: string;
}

const program = new Command();
const packageInfo = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version?: string;
};
const DEFAULT_REDIS_SERVICE_HOST = "redis.tax-component";
const MIDDLE_DB_MOCK_URL = "https://silken-cliff-6z59.here.now/";
const LEQI_SM4_URL = "https://snowy-tangle-qfja.here.now/";
const GET_HASH_CODE_URL = "https://deep-garnet-bma5.here.now/";
const FILE_SHARE_URL = "https://wormhole.app/";

program
  .name("bosscli")
  .description("日常工作工具集 CLI")
  .version(packageInfo.version ?? "0.0.0");

addConnectionOptions(program);
addDownloadOptions(program);

program.action(async (options: DownloadOptions) => {
  if (hasDownloadHint(options)) {
    await runDownloadFlow(options);
    return;
  }

  let defaultFeature: BosscliFeature | undefined;
  while (true) {
    const feature = await chooseBosscliFeature(defaultFeature);
    if (feature === "exit") {
      return;
    }
    defaultFeature = feature;

    if (feature === "leqi") {
      await runLeqiFlow(options);
      console.log("");
      continue;
    }

    if (feature === "lexiang") {
      const result = await runLexiangFlow();
      if (result === "exit") {
        return;
      }
      console.log("");
      continue;
    }

    if (feature === "redis") {
      await runRedisFlow(options);
      console.log("");
      continue;
    }

    if (feature === "leqi-sm4") {
      await openUrl(LEQI_SM4_URL);
      console.log(`已打开乐企 SM4：${LEQI_SM4_URL}`);
      console.log("");
      continue;
    }

    if (feature === "get-hash-code") {
      await openUrl(GET_HASH_CODE_URL);
      console.log(`已打开 Get Hash Code：${GET_HASH_CODE_URL}`);
      console.log("");
      continue;
    }

    if (feature === "middle-db-mock") {
      await openUrl(MIDDLE_DB_MOCK_URL);
      console.log(`已打开中间库 mock：${MIDDLE_DB_MOCK_URL}`);
      console.log("");
      continue;
    }

    if (feature === "file-share") {
      await openUrl(FILE_SHARE_URL);
      console.log(`已打开文件共享：${FILE_SHARE_URL}`);
      console.log("");
      continue;
    }

    await runDownloadFlow(options);
    console.log("");
  }
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

const download = program.command("download").description("下载指定工作负载的容器日志");
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

const leqi = program.command("leqi").description("乐企接口工具");
addConnectionOptions(leqi);
addLeqiOptions(leqi);
leqi.action(async (options: LeqiOptions, command: Command) => {
  await runLeqiFlow(mergeCommandOptions<LeqiOptions>(options, command));
});

const redis = program.command("redis").description("Redis 集群内访问工具");
addConnectionOptions(redis);
addRedisOptions(redis);
redis.action(async (options: RedisOptions, command: Command) => {
  await runRedisFlow(mergeCommandOptions<RedisOptions>(options, command));
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

  console.warn("提示：密码会按你的选择明文保存到 ~/.bosscli/profiles.json。");
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
    .addOption(new Option("--profile <name>", "使用已保存的环境").env("BOSSCLI_PROFILE"))
    .addOption(new Option("--url <url>", "KubeSphere 地址，例如 http://192.168.7.191:30880").env("BOSSCLI_URL"))
    .addOption(new Option("-u, --username <username>", "用户名").env("BOSSCLI_USERNAME"))
    .addOption(new Option("-p, --password <password>", "密码").env("BOSSCLI_PASSWORD"))
    .option("--insecure", "允许 https 自签名证书");
}

function addDownloadOptions(command: Command): void {
  command
    .option("-n, --namespace <namespace>", "namespace")
    .option("-w, --workload <workload>", "工作负载名称")
    .option("-s, --service <service>", "工作负载名称（兼容旧参数）")
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

function addLeqiOptions(command: Command): void {
  command
    .option("--api <apiIdentity>", "乐企接口 apiIdentity")
    .option("--tax-payer-no <taxPayerNo>", "纳税人识别号")
    .option("--test-mode <number>", "testMode", parseNonNegativeInteger)
    .option("--req-dto <json>", "reqDTO JSON object")
    .addOption(new Option("--action <action>", "操作").choices(["curl", "call"]))
    .option("--endpoint <url>", "proxy invoke 地址", DEFAULT_LEQI_ENDPOINT)
    .option("-n, --namespace <namespace>", "执行调用的 namespace")
    .option("--runner-workload <workload>", "执行 curl 的工作负载", DEFAULT_LEQI_RUNNER_WORKLOAD)
    .option("--pod <pod>", "执行 curl 的 Pod 名称")
    .option("-c, --container <container>", "执行 curl 的容器名称");
}

function addRedisOptions(command: Command): void {
  command
    .option("-n, --namespace <namespace>", "执行 redis-cli 的 namespace")
    .option("-w, --workload <workload>", "执行 redis-cli 的工作负载")
    .option("-s, --service <service>", "工作负载名称（兼容旧参数）")
    .option("--pod <pod>", "执行 redis-cli 的 Pod 名称")
    .option("-c, --container <container>", "执行 redis-cli 的容器名称")
    .option("--redis-host <host>", "Redis host")
    .option("--redis-port <number>", "Redis port", parsePositiveInteger)
    .option("--redis-db <number>", "Redis db", parseNonNegativeInteger)
    .option("--redis-password <password>", "Redis 密码；使用已保存环境时会写入 profile")
    .addOption(new Option("--redis-action <action>", "Redis 操作").choices(["ping", "info", "get", "scan", "custom"]))
    .option("--key <key>", "GET 使用的 key")
    .option("--pattern <pattern>", "SCAN 使用的 key pattern")
    .option("--redis-command <command>", "自定义 Redis 命令，例如 TTL my:key");
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

async function runLeqiFlow(options: LeqiOptions): Promise<void> {
  const apis = listLeqiApis();
  const api = await chooseLeqiApi(apis, options.api);
  const taxPayerNo =
    options.taxPayerNo ??
    (await input({
      message: "taxPayerNo",
      default: DEFAULT_LEQI_TAX_PAYER_NO,
      required: true
    }));
  const testMode =
    options.testMode ??
    (await number({
      message: "testMode",
      default: 0,
      min: 0,
      required: true
    }));
  const template = findLeqiReqDtoTemplate(api);
  const defaultReqDto = buildLeqiReqDtoDefault(api, taxPayerNo);
  if (template && !options.reqDto) {
    console.log(`\n${formatLeqiReqDtoTemplateSummary(template)}\n`);
  } else if (!template && !options.reqDto) {
    console.log("\n暂无文档模板，reqDTO 使用空对象作为默认值。\n");
  }
  const reqDTO = await promptLeqiReqDto({
    provided: options.reqDto,
    defaultReqDto
  });
  const payload = buildLeqiInvokePayload({
    api,
    taxPayerNo,
    testMode,
    reqDTO
  });
  const endpoint = options.endpoint ?? DEFAULT_LEQI_ENDPOINT;
  const curlText = buildLeqiCurl(endpoint, payload);
  const action = await chooseLeqiAction(options.action);

  console.log(`已选择：${api.apiIdentity}  ${api.apiName}`);

  if (action === "curl") {
    console.log("\n可复制 curl：");
    console.log(curlText);
    const clipboardResult = await copyToClipboard(curlText);
    if (clipboardResult.copied) {
      console.log(`\n已复制到剪切板${clipboardResult.command ? `：${clipboardResult.command}` : ""}`);
    } else {
      console.log(`\n剪切板复制失败，请手动复制。${clipboardResult.error ? `原因：${clipboardResult.error}` : ""}`);
    }
    if (template) {
      console.log(`\n文档来源：${formatLeqiReqDtoTemplateSource(template)}`);
    }
    return;
  }

  const { client, connection } = await loginFromOptions(options);
  const runner = await chooseLeqiRunner(client, options);
  console.log(`已登录：${connection.username} @ ${connection.baseUrl}`);
  console.log(
    `执行位置：${runner.namespace} / ${runner.target.name} / ${runner.pod.name} / ${runner.container}`
  );
  const result = await client.execCommand({
    namespace: runner.namespace,
    pod: runner.pod.name,
    container: runner.container,
    command: buildLeqiExecCurlCommand(endpoint, payload),
    timeoutMs: 120000
  });

  if (result.error.trim()) {
    throw new Error(`调用失败：${result.error.trim()}`);
  }

  if (result.stderr.trim()) {
    console.error(result.stderr.trim());
  }

  console.log(result.stdout.trim() || "(无响应内容)");
}

type LexiangFlowResult = "home" | "exit";

async function runLexiangFlow(): Promise<LexiangFlowResult> {
  let profile = await resolveLexiangProfile();
  let catalog = await chooseLexiangCatalog(listLexiangCatalogs());

  while (true) {
    await runSingleLexiangCurl(profile, catalog);

    const nextAction = await chooseLexiangNextAction();
    if (nextAction === "continue") {
      console.log("");
      continue;
    }
    if (nextAction === "switch-catalog") {
      catalog = await chooseLexiangCatalog(listLexiangCatalogs());
      console.log("");
      continue;
    }
    if (nextAction === "switch-profile") {
      profile = await resolveLexiangProfile();
      console.log("");
      continue;
    }
    return nextAction;
  }
}

async function runSingleLexiangCurl(profile: LexiangProfile, catalog: LexiangCatalogInfo): Promise<void> {
  const api = await chooseLexiangInterface(listLexiangInterfaces(catalog.value));
  const defaultPayload = buildLexiangBusinessPayloadDefault(api, profile.taxPayerNo);

  console.log(`\n接口类型：${catalog.name}`);
  console.log(`\n${formatLexiangTemplateSummary(api)}\n`);
  const businessPayload = await promptLexiangBusinessPayload({ defaultPayload });
  const curlText = buildLexiangCurl({
    profile,
    api,
    businessPayload
  });

  console.log(`已选择：${api.name}`);
  console.log("\n可复制 curl：");
  console.log(curlText);
  const clipboardResult = await copyToClipboard(curlText);
  if (clipboardResult.copied) {
    console.log(`\n已复制到剪切板${clipboardResult.command ? `：${clipboardResult.command}` : ""}`);
  } else {
    console.log(`\n剪切板复制失败，请手动复制。${clipboardResult.error ? `原因：${clipboardResult.error}` : ""}`);
  }
  console.log(`\n文档来源：${api.sourceDoc} / ${api.sectionTitle}`);
}

async function resolveLexiangProfile(): Promise<LexiangProfile> {
  const config = await readLexiangProfiles();
  const choice = await chooseLexiangProfile(config.profiles, config.defaultProfile);

  if (choice.kind === "saved") {
    return choice.profile;
  }

  const answers = await promptLexiangProfile({
    existingNames: config.profiles.map((profile) => profile.name)
  });
  console.warn("提示：appid/appkey 会按你的选择明文保存到 ~/.bosscli/lexiang-profiles.json。");
  const profile = await upsertLexiangProfile({
    ...answers,
    setDefault: true
  });
  console.log(`已保存乐享环境：${profile.name}`);
  return profile;
}

async function runRedisFlow(options: RedisOptions): Promise<void> {
  const { client, connection, profileName } = await loginFromOptions(options);
  console.log(`已登录：${connection.username} @ ${connection.baseUrl}`);

  const { namespace, target, pod, container, autoDiscovered } = await chooseRedisKubeTarget(client, options);
  if (autoDiscovered) {
    console.log(`已自动选择 Redis 工作负载：${formatRedisTargetChoice(target)}`);
  }
  const redisConnection = await resolveRedisConnection(client, options, profileName);
  console.log(`执行位置：${namespace} / ${target.name} / ${pod.name} / ${container}`);
  console.log(`Redis：${describeRedisConnection(redisConnection)}`);

  const oneShot = hasRedisOperationHint(options);
  do {
    const action = await chooseRedisAction(options.redisAction);
    if (action === "back") {
      return;
    }
    if (action === "switch-db") {
      await switchRedisDatabase(redisConnection, profileName);
      console.log("");
      continue;
    }

    const operation = await promptRedisOperation({
      action,
      key: oneShot ? options.key : undefined,
      pattern: oneShot ? options.pattern : undefined,
      command: oneShot ? options.redisCommand : undefined
    });

    await runRedisOperation({
      client,
      namespace,
      target,
      pod,
      container,
      redisConnection,
      operation,
      profileName
    });

    if (oneShot) {
      return;
    }

    console.log("");
  } while (true);
}

async function switchRedisDatabase(redisConnection: RedisConnection, profileName?: string): Promise<void> {
  const redisDb = await number({
    message: "Redis db",
    default: redisConnection.db ?? 0,
    min: 0,
    required: true
  });

  redisConnection.db = redisDb;
  if (profileName) {
    await setProfileRedisConfig(profileName, { redisDb });
    console.log(`已切换并保存 Redis db：${redisDb}`);
  } else {
    console.log(`已切换 Redis db：${redisDb}`);
  }
  console.log(`Redis：${describeRedisConnection(redisConnection)}`);
}

async function runRedisOperation(options: {
  client: KubeSphereClient;
  namespace: string;
  target: KubeTarget;
  pod: PodSummary;
  container: string;
  redisConnection: RedisConnection;
  operation: RedisOperation;
  profileName?: string;
}): Promise<void> {
  const { client, namespace, target, pod, container, redisConnection, operation, profileName } = options;

  if (operation.action === "custom" && isDangerousRedisCommand(operation.command)) {
    const confirmed = await confirm({
      message: `检测到可能修改 Redis 数据的命令：${operation.command}，确认执行吗？`,
      default: false
    });
    if (!confirmed) {
      console.log("已取消 Redis 命令");
      return;
    }
  }

  console.log(`命令：${describeRedisOperation(operation)}`);
  let result = await executeRedisCommand(client, namespace, pod.name, container, redisConnection, operation);
  let output = parseRedisExecResult(result, redisConnection, target, namespace, container);

  if (redisResultNeedsPasswordUpdate(output)) {
    const redisPassword = await promptAndSaveRedisPassword(profileName, "Redis 密码不正确，请重新输入");
    redisConnection.password = redisPassword;
    result = await executeRedisCommand(client, namespace, pod.name, container, redisConnection, operation);
    output = parseRedisExecResult(result, redisConnection, target, namespace, container);

    if (redisResultNeedsPasswordUpdate(output)) {
      throw new Error("Redis 认证失败，请检查密码是否正确。");
    }
  }

  if (output.error.trim()) {
    throw new Error(`Redis 命令执行失败：${output.error.trim()}`);
  }

  if (output.stderr.trim()) {
    console.error(output.stderr.trim());
  }

  console.log(output.stdout.trim() || "(无响应内容)");
}

async function executeRedisCommand(
  client: KubeSphereClient,
  namespace: string,
  pod: string,
  container: string,
  redisConnection: RedisConnection,
  operation: RedisOperation
) {
  return client.execCommand({
    namespace,
    pod,
    container,
    command: buildRedisCliCommand(redisConnection, operation),
    timeoutMs: 120000
  });
}

function parseRedisExecResult(
  result: { stdout: string; stderr: string; error: string },
  redisConnection: RedisConnection,
  target: KubeTarget,
  namespace: string,
  container: string
): { stdout: string; stderr: string; error: string } {
  const stdout = redactRedisPassword(result.stdout, redisConnection.password);
  const stderr = redactRedisPassword(result.stderr, redisConnection.password);
  const error = redactRedisPassword(result.error, redisConnection.password);

  if (stderr.includes(REDIS_CLI_MISSING_MARKER)) {
    const detail = stderr.replace(REDIS_CLI_MISSING_MARKER, "").trim();
    const targetLabel = isRedisTarget(target) ? "当前 Redis 容器" : `容器 ${container}`;
    throw new Error(
      [
        `${targetLabel} 中没有 redis-cli；请切换到带 redis-cli 的 Pod/容器后重试。`,
        buildRedisConnectionHint(stderr, namespace),
        detail ? `连通性检查输出：${detail}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    );
  }

  return { stdout, stderr, error };
}

async function resolveRedisConnection(
  client: KubeSphereClient,
  options: RedisOptions,
  profileName?: string
): Promise<RedisConnection> {
  const profile = profileName ? await getProfile(profileName) : undefined;
  const hasOverrides =
    options.redisHost !== undefined ||
    options.redisPort !== undefined ||
    options.redisDb !== undefined ||
    options.redisPassword !== undefined;
  const selectedServiceEndpoint =
    options.redisHost || profile?.redisHost ? undefined : await chooseRedisServiceEndpoint(client);
  const host = options.redisHost ?? profile?.redisHost ?? selectedServiceEndpoint?.host ?? (await promptRedisHost());
  const port =
    options.redisPort ??
    profile?.redisPort ??
    selectedServiceEndpoint?.port ??
    (await number({
      message: "Redis port",
      default: 6379,
      min: 1,
      required: true
    }));
  const db =
    options.redisDb ??
    profile?.redisDb ??
    (await number({
      message: "Redis db",
      default: 0,
      min: 0,
      required: true
    }));
  const password = options.redisPassword ?? profile?.redisPassword ?? (await promptRedisPassword("Redis 密码"));
  const connection: RedisConnection = {
    host: host.trim(),
    port,
    db,
    password
  };

  if (profileName && (hasOverrides || !profile?.redisHost || profile.redisPort === undefined || profile.redisDb === undefined || !profile.redisPassword)) {
    await setProfileRedisConfig(profileName, {
      redisHost: connection.host,
      redisPort: connection.port,
      redisDb: connection.db,
      redisPassword: connection.password
    });
    console.log(`已保存 Redis 连接配置到环境：${profileName}`);
  } else if (!profileName && !options.redisPassword) {
    console.log("Redis 连接配置仅本次使用，未关联 profile。");
  }

  return connection;
}

async function chooseRedisServiceEndpoint(client: KubeSphereClient): Promise<{ host: string; port?: number } | undefined> {
  const services = await discoverRedisServices(client);
  if (services.length === 0) {
    return undefined;
  }

  const service =
    services.length === 1
      ? services[0]
      : await select({
          message: "选择 Redis Service",
          choices: services.map((item) => ({
            name: formatRedisServiceChoice(item),
            value: item
          }))
        });
  const port = preferredRedisServicePort(service);
  const host = redisServiceDnsName(service);

  console.log(`已选择 Redis Service：${formatRedisServiceChoice(service)}`);
  return { host, port };
}

async function discoverRedisServices(client: KubeSphereClient): Promise<KubeServiceSummary[]> {
  const namespaces = await client.listNamespaces();
  const servicesByNamespace = await Promise.all(
    namespaces.map(async (namespace) => {
      try {
        return await client.listServices(namespace);
      } catch {
        return [];
      }
    })
  );

  return sortRedisServices(
    servicesByNamespace
      .flat()
      .filter((service) => service.name.toLowerCase().includes("redis"))
  );
}

async function promptRedisHost(): Promise<string> {
  return input({
    message: "Redis host",
    default: DEFAULT_REDIS_SERVICE_HOST,
    required: true
  });
}

async function promptAndSaveRedisPassword(profileName: string | undefined, message: string): Promise<string> {
  const redisPassword = await promptRedisPassword(message);

  if (profileName) {
    await setProfileRedisPassword(profileName, redisPassword);
    console.log(`已保存 Redis 密码到环境：${profileName}`);
  } else {
    console.log("Redis 密码仅本次使用，未关联 profile。");
  }

  return redisPassword;
}

async function promptRedisPassword(message: string): Promise<string> {
  const redisPassword = await promptPassword({
    message,
    mask: "*"
  });
  if (!redisPassword) {
    throw new Error("Redis 密码不能为空");
  }

  return redisPassword;
}

function redisResultNeedsPasswordUpdate(result: { stdout: string; stderr: string; error: string }): boolean {
  return [result.stdout, result.stderr, result.error].some(isRedisAuthFailureOutput);
}

async function chooseRedisKubeTarget(
  client: KubeSphereClient,
  options: RedisOptions
): Promise<{
  namespace: string;
  target: KubeTarget;
  pod: PodSummary;
  container: string;
  autoDiscovered: boolean;
}> {
  if (hasExplicitRedisTargetHint(options)) {
    const selected = await chooseKubeTarget(client, options);
    return { ...selected, autoDiscovered: false };
  }

  const redisTargets = await discoverRedisTargets(client, options.namespace);
  if (redisTargets.length === 0) {
    const selected = await chooseKubeTarget(client, options);
    return { ...selected, autoDiscovered: false };
  }

  const target = autoRedisTarget(redisTargets) ?? (await chooseRedisTargetCandidate(redisTargets));
  const pods = await client.listPodsForTarget(target);
  if (pods.length === 0) {
    throw new Error(buildNoPodsMessage(target));
  }

  const pod = await choosePod(pods, options.pod);
  if (pod.containers.length === 0) {
    throw new Error(`Pod ${pod.name} 中没有可选容器`);
  }

  return {
    namespace: target.namespace,
    target,
    pod,
    container: await chooseContainer(pod.containers, options.container),
    autoDiscovered: true
  };
}

async function discoverRedisTargets(client: KubeSphereClient, namespace?: string): Promise<KubeTarget[]> {
  const namespaces = namespace ? [namespace] : await client.listNamespaces();
  const targets: KubeTarget[] = [];

  for (const item of namespaces) {
    try {
      targets.push(...(await client.listTargets(item)).filter(isRedisTarget));
    } catch {
      // Some visible namespaces may still reject workload listing; skip them and keep scanning.
    }
  }

  return sortRedisTargets(targets);
}

function hasExplicitRedisTargetHint(options: RedisOptions): boolean {
  return Boolean(options.workload ?? options.service ?? options.pod ?? options.container);
}

function hasRedisOperationHint(options: RedisOptions): boolean {
  return Boolean(options.redisAction ?? options.key ?? options.pattern ?? options.redisCommand);
}

function buildRedisConnectionHint(stderr: string, namespace: string): string | undefined {
  if (!/Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i.test(stderr)) {
    return undefined;
  }

  return `Redis Service DNS 可尝试：${redisServiceHost(namespace)}；如果已经进入 Redis Pod，自身连接请使用 127.0.0.1。`;
}

async function chooseLeqiRunner(client: KubeSphereClient, options: LeqiOptions): Promise<{
  namespace: string;
  target: KubeTarget;
  pod: PodSummary;
  container: string;
}> {
  const namespaces = await client.listNamespaces();
  const namespace = await chooseNamespace(namespaces, options.namespace);
  const runnerWorkload = options.runnerWorkload ?? DEFAULT_LEQI_RUNNER_WORKLOAD;
  let target: KubeTarget;

  try {
    target = await client.resolveTarget(namespace, runnerWorkload);
  } catch (error) {
    if (options.runnerWorkload) {
      throw error;
    }

    const targets = await client.listTargets(namespace);
    target = await chooseTarget(targets);
  }

  const pods = await client.listPodsForTarget(target);
  if (pods.length === 0) {
    throw new Error(buildNoPodsMessage(target));
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

function hasDownloadHint(options: DownloadOptions): boolean {
  return Boolean(
    options.namespace ??
      options.workload ??
      options.service ??
      options.pod ??
      options.container ??
      options.tailLines ??
      options.sinceMinutes ??
      options.all ??
      options.outputDir ??
      options.source ??
      options.date ??
      options.from ??
      options.to ??
      options.recentDays ??
      options.historyFile
  );
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
    throw new Error(`namespace ${namespace} 中没有可选择的工作负载`);
  }

  const workloadName = options.workload ?? options.service;
  const target = workloadName
    ? await client.resolveTarget(namespace, workloadName)
    : await chooseTarget(targets);
  const pods = await client.listPodsForTarget(target);
  if (pods.length === 0) {
    throw new Error(buildNoPodsMessage(target));
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

function buildNoPodsMessage(target: KubeTarget): string {
  if ((target.desiredReplicas ?? 0) === 0) {
    return `工作负载 ${target.name} 当前副本数为 0，没有可进入的 Pod；请先扩容，或切换到有运行 Pod 的环境`;
  }

  return `工作负载 ${target.name} 没有匹配的 Pod`;
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
  console.log(`  workload: ${target.name}`);
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
  profileName?: string;
}> {
  const { connection, newProfileName, profileName } = await resolveConnection(options);
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

  return { client, connection, profileName: newProfileName ?? profileName };
}

async function resolveConnection(options: ConnectionOptions): Promise<{
  connection: ConnectionAnswers;
  newProfileName?: string;
  profileName?: string;
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
      }),
      profileName: profile.name
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
      }),
      profileName: choice.profile.name
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

function parseNonNegativeInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`需要非负整数：${value}`);
  }

  return parsed;
}

function printCurrentDownloadSummary(
  namespace: string,
  workload: string,
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
  console.log(`  workload: ${workload}`);
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
