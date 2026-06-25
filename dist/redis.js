import { shellQuote } from "./utils.js";
export const REDIS_CLI_MISSING_MARKER = "__WORKCTL_REDIS_CLI_MISSING__";
export const DEFAULT_REDIS_NAMESPACE = "kubesphere-system";
export const DEFAULT_REDIS_WORKLOAD = "redis";
export const DEFAULT_REDIS_HOST = "127.0.0.1";
export const DEFAULT_BUSINESS_REDIS_NAMESPACE = "tax-component";
export const DEFAULT_BUSINESS_REDIS_SERVICE = "redis";
const DANGEROUS_REDIS_COMMANDS = new Set([
    "APPEND",
    "BITOP",
    "BLMOVE",
    "BRPOPLPUSH",
    "DECR",
    "DECRBY",
    "DEL",
    "EVAL",
    "EVALSHA",
    "EXPIRE",
    "EXPIREAT",
    "FLUSHALL",
    "FLUSHDB",
    "GETDEL",
    "GETEX",
    "HDEL",
    "HINCRBY",
    "HINCRBYFLOAT",
    "HMSET",
    "HSET",
    "HSETNX",
    "INCR",
    "INCRBY",
    "INCRBYFLOAT",
    "LINSERT",
    "LMOVE",
    "LPOP",
    "LPUSH",
    "LPUSHX",
    "LREM",
    "LSET",
    "LTRIM",
    "MIGRATE",
    "MOVE",
    "MSET",
    "MSETNX",
    "PERSIST",
    "PEXPIRE",
    "PEXPIREAT",
    "PSETEX",
    "RENAME",
    "RENAMENX",
    "RESTORE",
    "RPOP",
    "RPOPLPUSH",
    "RPUSH",
    "RPUSHX",
    "SADD",
    "SDIFFSTORE",
    "SET",
    "SETBIT",
    "SETEX",
    "SETNX",
    "SETRANGE",
    "SINTERSTORE",
    "SMOVE",
    "SPOP",
    "SREM",
    "SUNIONSTORE",
    "UNLINK",
    "ZADD",
    "ZDIFFSTORE",
    "ZINCRBY",
    "ZINTERSTORE",
    "ZPOPMAX",
    "ZPOPMIN",
    "ZREM",
    "ZREMRANGEBYLEX",
    "ZREMRANGEBYRANK",
    "ZREMRANGEBYSCORE",
    "ZUNIONSTORE"
]);
export function buildRedisCliCommand(connection, operation) {
    const args = buildRedisArgs(connection, operation);
    const networkCheckLine = connection.host && connection.port
        ? `  if command -v nc >/dev/null 2>&1; then nc -vz -w 3 ${shellQuote(connection.host)} ${shellQuote(String(connection.port))} >&2 || true; fi`
        : undefined;
    const script = [
        "if ! command -v redis-cli >/dev/null 2>&1; then",
        networkCheckLine,
        `  echo ${shellQuote(REDIS_CLI_MISSING_MARKER)} >&2`,
        "  exit 127",
        "fi",
        `exec redis-cli ${args.map(shellQuote).join(" ")}`
    ]
        .filter(Boolean)
        .join("\n");
    return ["sh", "-lc", script];
}
export function isRedisTarget(target) {
    return target.name.toLowerCase().includes("redis");
}
export function redisTargetPriority(target) {
    const namespace = target.namespace.toLowerCase();
    const name = target.name.toLowerCase();
    if (namespace === DEFAULT_REDIS_NAMESPACE && name === DEFAULT_REDIS_WORKLOAD) {
        return 0;
    }
    if (name === DEFAULT_REDIS_WORKLOAD) {
        return 1;
    }
    if (namespace === DEFAULT_REDIS_NAMESPACE) {
        return 2;
    }
    return 3;
}
export function sortRedisTargets(targets) {
    return [...targets].sort((left, right) => {
        const priorityDiff = redisTargetPriority(left) - redisTargetPriority(right);
        if (priorityDiff !== 0) {
            return priorityDiff;
        }
        const namespaceDiff = left.namespace.localeCompare(right.namespace);
        if (namespaceDiff !== 0) {
            return namespaceDiff;
        }
        return left.name.localeCompare(right.name);
    });
}
export function autoRedisTarget(targets) {
    return targets.length === 1 ? targets[0] : undefined;
}
export function formatRedisTargetChoice(target) {
    const desired = target.desiredReplicas ?? 0;
    const ready = target.readyReplicas ?? 0;
    return `${target.namespace} / ${target.name}  (${ready}/${desired})`;
}
export function defaultRedisHostForTarget(target) {
    return isRedisTarget(target) ? DEFAULT_REDIS_HOST : undefined;
}
export function redisServiceHost(namespace, workload = DEFAULT_REDIS_WORKLOAD) {
    return `${workload}.${namespace}.svc.cluster.local`;
}
export function redisServiceDnsName(service) {
    return `${service.name}.${service.namespace}`;
}
export function preferredRedisServicePort(service) {
    return service.ports.includes(6379) ? 6379 : service.ports[0];
}
export function redisServicePriority(service) {
    const namespace = service.namespace.toLowerCase();
    const name = service.name.toLowerCase();
    if (namespace === DEFAULT_BUSINESS_REDIS_NAMESPACE && name === DEFAULT_BUSINESS_REDIS_SERVICE) {
        return 0;
    }
    if (namespace === DEFAULT_BUSINESS_REDIS_NAMESPACE && name.includes("redis")) {
        return 1;
    }
    if (name === DEFAULT_BUSINESS_REDIS_SERVICE) {
        return 2;
    }
    return 3;
}
export function sortRedisServices(services) {
    return [...services].sort((left, right) => {
        const priorityDiff = redisServicePriority(left) - redisServicePriority(right);
        if (priorityDiff !== 0) {
            return priorityDiff;
        }
        const namespaceDiff = left.namespace.localeCompare(right.namespace);
        if (namespaceDiff !== 0) {
            return namespaceDiff;
        }
        return left.name.localeCompare(right.name);
    });
}
export function formatRedisServiceChoice(service) {
    const port = preferredRedisServicePort(service);
    const portText = port ? `:${port}` : "";
    return `${service.namespace} / ${service.name}  ${redisServiceDnsName(service)}${portText}  ${service.clusterIP ?? "-"}`;
}
export function buildRedisArgs(connection, operation) {
    const baseArgs = ["--raw"];
    if (connection.password) {
        baseArgs.push("-a", connection.password);
    }
    if (connection.host) {
        baseArgs.push("-h", connection.host);
    }
    if (connection.port !== undefined) {
        baseArgs.push("-p", String(connection.port));
    }
    if (connection.db !== undefined) {
        baseArgs.push("-n", String(connection.db));
    }
    switch (operation.action) {
        case "ping":
            return [...baseArgs, "PING"];
        case "info":
            return [...baseArgs, "INFO"];
        case "get":
            return [...baseArgs, "GET", operation.key];
        case "scan":
            return [...baseArgs, "--scan", "--pattern", operation.pattern];
        case "custom":
            return [...baseArgs, ...parseRedisCommand(operation.command)];
    }
}
export function describeRedisConnection(connection) {
    if (!connection.host && connection.port === undefined && connection.db === undefined) {
        return "redis-cli 默认连接 (127.0.0.1:6379 db 0)";
    }
    const host = connection.host ?? "127.0.0.1";
    const port = connection.port ?? 6379;
    const db = connection.db ?? 0;
    return `${host}:${port} db ${db}`;
}
export function parseRedisCommand(command) {
    const tokens = [];
    let current = "";
    let quote;
    let escaping = false;
    for (const char of command.trim()) {
        if (escaping) {
            current += char;
            escaping = false;
            continue;
        }
        if (char === "\\") {
            escaping = true;
            continue;
        }
        if (quote) {
            if (char === quote) {
                quote = undefined;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            continue;
        }
        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current);
                current = "";
            }
            continue;
        }
        current += char;
    }
    if (escaping) {
        current += "\\";
    }
    if (quote) {
        throw new Error("Redis 自定义命令的引号没有闭合");
    }
    if (current) {
        tokens.push(current);
    }
    if (tokens.length === 0) {
        throw new Error("Redis 自定义命令不能为空");
    }
    return tokens;
}
export function isDangerousRedisCommand(command) {
    const [name] = parseRedisCommand(command);
    return DANGEROUS_REDIS_COMMANDS.has(name.toUpperCase());
}
export function describeRedisOperation(operation) {
    switch (operation.action) {
        case "ping":
            return "PING";
        case "info":
            return "INFO";
        case "get":
            return `GET ${operation.key}`;
        case "scan":
            return `SCAN ${operation.pattern}`;
        case "custom":
            return operation.command;
    }
}
export function redactRedisPassword(value, password) {
    if (!password) {
        return value;
    }
    return value.split(password).join("******");
}
export function isRedisAuthFailureOutput(value) {
    return /\bNOAUTH\b|WRONGPASS|AUTH failed|Authentication required|invalid username-password pair/i.test(value);
}
//# sourceMappingURL=redis.js.map