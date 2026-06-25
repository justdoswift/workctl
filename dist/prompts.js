import os from "node:os";
import path from "node:path";
import { checkbox, confirm, editor, input, number, password, select } from "@inquirer/prompts";
import { addDays, assertDateString, buildDateRange, buildDateSelection, formatLocalDate } from "./date-utils.js";
import { formatRedisTargetChoice } from "./redis.js";
import { formatLeqiApiChoice, parseReqDtoJson } from "./leqi.js";
import { DEFAULT_LEXIANG_VERSION, formatLexiangInterfaceChoice, parseLexiangBusinessPayloadJson } from "./lexiang.js";
import { buildLogFileName, defaultOutputDir, formatBytes, normalizeBaseUrl } from "./utils.js";
const NEW_PROFILE_VALUE = "__new__";
export const DEFAULT_NAMESPACE = "tax-digital";
export async function chooseSavedProfile(profiles, defaultProfile) {
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
export async function promptConnection(defaults) {
    const baseUrl = defaults.baseUrl ??
        normalizeBaseUrl(await input({
            message: "KubeSphere 地址",
            default: "http://192.168.7.191:30880",
            required: true
        }));
    const username = defaults.username ??
        (await input({
            message: "用户名",
            default: "admin",
            required: true
        }));
    const secret = defaults.password ??
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
export async function promptNewProfileName(existingNames) {
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
export function preferredNamespace(namespaces, preferred = DEFAULT_NAMESPACE) {
    return namespaces.includes(preferred) ? preferred : namespaces[0];
}
export async function chooseBosscliFeature(defaultFeature) {
    return select({
        message: "选择功能",
        default: defaultFeature,
        choices: [
            { name: "k8s", value: "logs" },
            { name: "乐企 curl", value: "leqi" },
            { name: "乐享", value: "lexiang" },
            { name: "乐企 SM4", value: "leqi-sm4" },
            { name: "Get Hash Code", value: "get-hash-code" },
            { name: "Redis", value: "redis" },
            { name: "中间库 mock", value: "middle-db-mock" },
            { name: "文件共享", value: "file-share" },
            { name: "退出", value: "exit" }
        ]
    });
}
export async function chooseLexiangProfile(profiles, defaultProfile) {
    if (profiles.length === 0) {
        return { kind: "new" };
    }
    const choices = profiles.map((profile) => ({
        name: profile.name === defaultProfile ? `${profile.name} (默认)` : profile.name,
        value: profile.name
    }));
    choices.push({ name: "新增乐享环境", value: NEW_PROFILE_VALUE });
    const selected = await select({
        message: "选择乐享环境",
        choices,
        default: defaultProfile ?? profiles[0]?.name
    });
    if (selected === NEW_PROFILE_VALUE) {
        return { kind: "new" };
    }
    const profile = profiles.find((item) => item.name === selected);
    if (!profile) {
        throw new Error(`乐享 profile 不存在：${selected}`);
    }
    return { kind: "saved", profile };
}
export async function chooseLexiangCatalog(catalogs) {
    if (catalogs.length === 0) {
        throw new Error("没有可用的乐享接口类型");
    }
    return select({
        message: "选择乐享接口类型",
        default: catalogs[0],
        choices: catalogs.map((catalog) => ({
            name: `${catalog.name}  ${catalog.description}`,
            value: catalog
        }))
    });
}
export async function promptLexiangProfile(options) {
    const existing = new Set(options.existingNames);
    const name = await input({
        message: "乐享环境名称",
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
    const baseUrl = await input({
        message: "乐享 baseUrl",
        required: true,
        transformer: (value) => value.trim()
    });
    const appid = await input({
        message: "appid",
        required: true,
        transformer: (value) => value.trim()
    });
    const appkey = await password({
        message: "appkey",
        mask: "*"
    });
    const taxPayerNo = await input({
        message: "X-TaxPayerNo",
        required: true,
        transformer: (value) => value.trim()
    });
    const version = await input({
        message: "version",
        default: DEFAULT_LEXIANG_VERSION,
        required: true,
        transformer: (value) => value.trim()
    });
    return {
        name: name.trim(),
        baseUrl: normalizeBaseUrl(baseUrl),
        appid: appid.trim(),
        appkey,
        taxPayerNo: taxPayerNo.trim(),
        version: version.trim() || DEFAULT_LEXIANG_VERSION
    };
}
export async function chooseLexiangInterface(apis) {
    if (apis.length === 0) {
        throw new Error("没有可用的乐享接口");
    }
    return select({
        message: "选择乐享接口",
        pageSize: 15,
        choices: apis.map((api) => ({
            name: formatLexiangInterfaceChoice(api),
            value: api
        }))
    });
}
export async function promptLexiangBusinessPayload(options) {
    const action = await select({
        message: "业务参数 JSON",
        default: "default",
        choices: [
            { name: "使用默认参数生成 curl", value: "default" },
            { name: "编辑业务参数 JSON", value: "edit" }
        ]
    });
    if (action === "default") {
        return options.defaultPayload;
    }
    const value = await editor({
        message: "业务参数 JSON",
        default: JSON.stringify(options.defaultPayload, null, 2),
        postfix: ".json",
        validate: (input) => {
            try {
                parseLexiangBusinessPayloadJson(input);
                return true;
            }
            catch (error) {
                return error.message;
            }
        }
    });
    return parseLexiangBusinessPayloadJson(value);
}
export async function chooseLexiangNextAction() {
    return select({
        message: "乐享下一步",
        default: "continue",
        choices: [
            { name: "继续生成乐享 curl", value: "continue" },
            { name: "切换通用/医疗", value: "switch-catalog" },
            { name: "切换乐享环境", value: "switch-profile" },
            { name: "返回首页", value: "home" },
            { name: "退出", value: "exit" }
        ]
    });
}
export async function chooseNamespace(namespaces, provided) {
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
export async function chooseTarget(targets, provided) {
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
export async function chooseRedisTargetCandidate(targets) {
    return select({
        message: "选择 Redis 工作负载",
        pageSize: 12,
        choices: targets.map((target) => ({
            name: formatRedisTargetChoice(target),
            value: target
        }))
    });
}
export function formatTargetChoice(target) {
    const desired = target.desiredReplicas ?? 0;
    const ready = target.readyReplicas ?? 0;
    return `${target.name}  工作负载(Deployment)  (${ready}/${desired})`;
}
export async function choosePod(pods, provided) {
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
export async function chooseContainer(containers, provided) {
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
export async function chooseLogRange(options) {
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
export async function chooseLogSource(provided) {
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
export async function chooseLeqiApi(apis, provided) {
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
export async function chooseLeqiAction(provided) {
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
export async function promptLeqiReqDto(options = {}) {
    if (options.provided) {
        return parseReqDtoJson(options.provided);
    }
    if (options.defaultReqDto) {
        return options.defaultReqDto;
    }
    return {};
}
export async function promptRedisConnection(options) {
    const host = options.host ??
        (await input({
            message: "Redis host",
            default: options.defaultHost,
            required: true
        }));
    const port = options.port ??
        (await number({
            message: "Redis port",
            default: 6379,
            min: 1,
            required: true
        }));
    const db = options.db ??
        (await number({
            message: "Redis db",
            default: 0,
            min: 0,
            required: true
        }));
    const redisPassword = options.password ??
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
export async function chooseRedisAction(provided) {
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
            { name: "切换 database", value: "switch-db" },
            { name: "返回上一级", value: "back" }
        ],
        default: "ping"
    });
}
export async function promptRedisOperation(options) {
    switch (options.action) {
        case "ping":
            return { action: "ping" };
        case "info":
            return { action: "info" };
        case "get":
            return {
                action: "get",
                key: options.key ??
                    (await input({
                        message: "Redis key",
                        required: true
                    }))
            };
        case "scan":
            return {
                action: "scan",
                pattern: options.pattern ??
                    (await input({
                        message: "Redis key pattern",
                        default: "*",
                        required: true
                    }))
            };
        case "custom":
            return {
                action: "custom",
                command: options.command ??
                    (await input({
                        message: "Redis 自定义命令",
                        required: true
                    }))
            };
    }
}
export async function chooseDateSelection(options) {
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
                }
                catch (error) {
                    return error.message;
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
            }
            catch (error) {
                return error.message;
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
            }
            catch (error) {
                return error.message;
            }
        }
    });
    return buildDateSelection({ from, to });
}
export async function chooseHistoryFiles(files) {
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
export async function buildOutputPath(options) {
    const outputDir = options.outputDir ?? defaultOutputDir(os.homedir());
    const fileName = buildLogFileName(options.namespace, options.service, options.pod);
    return path.join(outputDir, fileName);
}
function formatHistoryFileChoice(file) {
    return typeof file.size === "number" ? `${file.path}  ${formatBytes(file.size)}` : file.path;
}
//# sourceMappingURL=prompts.js.map