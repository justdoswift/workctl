import { describe, expect, it } from "vitest";

import {
  DEFAULT_REDIS_HOST,
  REDIS_CLI_MISSING_MARKER,
  autoRedisTarget,
  buildRedisArgs,
  buildRedisCliCommand,
  defaultRedisHostForTarget,
  describeRedisConnection,
  describeRedisOperation,
  formatRedisTargetChoice,
  formatRedisServiceChoice,
  isRedisAuthFailureOutput,
  isDangerousRedisCommand,
  parseRedisCommand,
  preferredRedisServicePort,
  redactRedisPassword,
  redisServiceDnsName,
  redisServiceHost,
  sortRedisServices,
  sortRedisTargets
} from "../src/redis.js";
import type { KubeServiceSummary, KubeTarget } from "../src/types.js";

describe("redis", () => {
  const target = (namespace: string, name: string, ready = 1, desired = 1): KubeTarget => ({
    kind: "Deployment",
    namespace,
    name,
    selector: { app: name },
    readyReplicas: ready,
    desiredReplicas: desired
  });
  const service = (namespace: string, name: string, ports = [6379], clusterIP = "10.233.0.1"): KubeServiceSummary => ({
    namespace,
    name,
    ports,
    clusterIP
  });

  it("sorts redis workload candidates with kubesphere-system/redis first", () => {
    const sorted = sortRedisTargets([
      target("tax-digital", "redis-cache"),
      target("kubesphere-system", "redis-helper"),
      target("dev", "redis"),
      target("kubesphere-system", "redis")
    ]);

    expect(sorted.map((item) => `${item.namespace}/${item.name}`)).toEqual([
      "kubesphere-system/redis",
      "dev/redis",
      "kubesphere-system/redis-helper",
      "tax-digital/redis-cache"
    ]);
  });

  it("auto selects only when there is a single redis candidate", () => {
    const redis = target("kubesphere-system", "redis");

    expect(autoRedisTarget([redis])).toBe(redis);
    expect(autoRedisTarget([redis, target("dev", "redis")])).toBeUndefined();
  });

  it("formats redis workload candidates and defaults host for redis targets", () => {
    const redis = target("kubesphere-system", "redis", 1, 1);

    expect(formatRedisTargetChoice(redis)).toBe("kubesphere-system / redis  (1/1)");
    expect(defaultRedisHostForTarget(redis)).toBe(DEFAULT_REDIS_HOST);
    expect(defaultRedisHostForTarget(target("tax-digital", "tax-api-proxy-server"))).toBeUndefined();
    expect(redisServiceHost("kubesphere-system")).toBe("redis.kubesphere-system.svc.cluster.local");
  });

  it("sorts redis services with tax-component/redis first", () => {
    const sorted = sortRedisServices([
      service("kubesphere-system", "redis"),
      service("tax-component", "stock-pool-redis"),
      service("tax-component", "redis-nodeport", [30379]),
      service("tax-component", "redis")
    ]);

    expect(sorted.map((item) => `${item.namespace}/${item.name}`)).toEqual([
      "tax-component/redis",
      "tax-component/redis-nodeport",
      "tax-component/stock-pool-redis",
      "kubesphere-system/redis"
    ]);
  });

  it("formats redis service choices", () => {
    const redis = service("tax-component", "redis", [26379, 6379], "10.233.27.215");

    expect(preferredRedisServicePort(redis)).toBe(6379);
    expect(redisServiceDnsName(redis)).toBe("redis.tax-component");
    expect(formatRedisServiceChoice(redis)).toBe("tax-component / redis  redis.tax-component:6379  10.233.27.215");
  });

  it("builds redis-cli args for built-in operations", () => {
    const connection = { host: "redis.tax-digital.svc.cluster.local", port: 6379, db: 2 };

    expect(buildRedisArgs({}, { action: "ping" })).toEqual(["--raw", "PING"]);
    expect(buildRedisArgs(connection, { action: "ping" })).toEqual([
      "--raw",
      "-h",
      "redis.tax-digital.svc.cluster.local",
      "-p",
      "6379",
      "-n",
      "2",
      "PING"
    ]);
    expect(buildRedisArgs(connection, { action: "get", key: "tax:invoice" })).toContain("tax:invoice");
    expect(buildRedisArgs(connection, { action: "scan", pattern: "tax:*" })).toEqual([
      "--raw",
      "-h",
      "redis.tax-digital.svc.cluster.local",
      "-p",
      "6379",
      "-n",
      "2",
      "--scan",
      "--pattern",
      "tax:*"
    ]);
  });

  it("quotes shell arguments and passes passwords to redis-cli", () => {
    const command = buildRedisCliCommand(
      {
        host: "redis'prod",
        port: 6379,
        db: 0,
        password: "p@ss'word"
      },
      { action: "get", key: "a'b" }
    );

    expect(command[0]).toBe("sh");
    expect(command[1]).toBe("-lc");
    expect(command[2]).toContain(REDIS_CLI_MISSING_MARKER);
    expect(command[2]).toContain("'--no-auth-warning'");
    expect(command[2]).toContain("'-a' 'p@ss'\\''word'");
    expect(command[2]).toContain("'-h' 'redis'\\''prod'");
    expect(command[2]).toContain("'a'\\''b'");
  });

  it("detects redis auth failures", () => {
    expect(isRedisAuthFailureOutput("NOAUTH Authentication required.")).toBe(true);
    expect(isRedisAuthFailureOutput("WRONGPASS invalid username-password pair")).toBe(true);
    expect(isRedisAuthFailureOutput("PONG")).toBe(false);
  });

  it("parses custom redis commands with quotes", () => {
    expect(parseRedisCommand('GET "tax invoice"')).toEqual(["GET", "tax invoice"]);
    expect(parseRedisCommand("TTL tax\\ key")).toEqual(["TTL", "tax key"]);
    expect(() => parseRedisCommand('GET "open')).toThrow("引号没有闭合");
  });

  it("detects dangerous custom commands", () => {
    expect(isDangerousRedisCommand("GET tax:key")).toBe(false);
    expect(isDangerousRedisCommand("del tax:key")).toBe(true);
    expect(isDangerousRedisCommand("FLUSHDB")).toBe(true);
    expect(isDangerousRedisCommand("expire tax:key 60")).toBe(true);
  });

  it("describes operations and redacts passwords", () => {
    expect(describeRedisConnection({})).toBe("redis-cli 默认连接 (127.0.0.1:6379 db 0)");
    expect(describeRedisConnection({ host: "redis.local", port: 6380, db: 2 })).toBe("redis.local:6380 db 2");
    expect(describeRedisOperation({ action: "scan", pattern: "tax:*" })).toBe("SCAN tax:*");
    expect(redactRedisPassword("ERR invalid password secret", "secret")).toBe("ERR invalid password ******");
  });
});
