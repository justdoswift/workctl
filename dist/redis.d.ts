import type { KubeServiceSummary, KubeTarget } from "./types.js";
export declare const REDIS_CLI_MISSING_MARKER = "__WORKCTL_REDIS_CLI_MISSING__";
export declare const DEFAULT_REDIS_NAMESPACE = "kubesphere-system";
export declare const DEFAULT_REDIS_WORKLOAD = "redis";
export declare const DEFAULT_REDIS_HOST = "127.0.0.1";
export declare const DEFAULT_BUSINESS_REDIS_NAMESPACE = "tax-component";
export declare const DEFAULT_BUSINESS_REDIS_SERVICE = "redis";
export type RedisAction = "ping" | "info" | "get" | "scan" | "custom";
export interface RedisConnection {
    host?: string;
    port?: number;
    db?: number;
    password?: string;
}
export type RedisOperation = {
    action: "ping";
} | {
    action: "info";
} | {
    action: "get";
    key: string;
} | {
    action: "scan";
    pattern: string;
} | {
    action: "custom";
    command: string;
};
export declare function buildRedisCliCommand(connection: RedisConnection, operation: RedisOperation): string[];
export declare function isRedisTarget(target: KubeTarget): boolean;
export declare function redisTargetPriority(target: KubeTarget): number;
export declare function sortRedisTargets(targets: KubeTarget[]): KubeTarget[];
export declare function autoRedisTarget(targets: KubeTarget[]): KubeTarget | undefined;
export declare function formatRedisTargetChoice(target: KubeTarget): string;
export declare function defaultRedisHostForTarget(target: KubeTarget): string | undefined;
export declare function redisServiceHost(namespace: string, workload?: string): string;
export declare function redisServiceDnsName(service: KubeServiceSummary): string;
export declare function preferredRedisServicePort(service: KubeServiceSummary): number | undefined;
export declare function redisServicePriority(service: KubeServiceSummary): number;
export declare function sortRedisServices(services: KubeServiceSummary[]): KubeServiceSummary[];
export declare function formatRedisServiceChoice(service: KubeServiceSummary): string;
export declare function buildRedisArgs(connection: RedisConnection, operation: RedisOperation): string[];
export declare function describeRedisConnection(connection: RedisConnection): string;
export declare function parseRedisCommand(command: string): string[];
export declare function isDangerousRedisCommand(command: string): boolean;
export declare function describeRedisOperation(operation: RedisOperation): string;
export declare function redactRedisPassword(value: string, password?: string): string;
export declare function isRedisAuthFailureOutput(value: string): boolean;
