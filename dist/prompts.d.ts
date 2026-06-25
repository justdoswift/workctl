import type { DateSelection, HistoryLogFile, KubeTarget, LeqiAction, LeqiApiInfo, LeqiReqDto, LogRange, LogSource, PodSummary, SavedProfile } from "./types.js";
import { type RedisAction, type RedisConnection, type RedisOperation } from "./redis.js";
export declare const DEFAULT_NAMESPACE = "tax-digital";
export interface ConnectionAnswers {
    baseUrl: string;
    username: string;
    password: string;
    insecure?: boolean;
}
export type WorkctlFeature = "logs" | "leqi" | "redis" | "exit";
export type RedisActionChoice = RedisAction | "back";
export type ProfileChoice = {
    kind: "saved";
    profile: SavedProfile;
} | {
    kind: "new";
};
export declare function chooseSavedProfile(profiles: SavedProfile[], defaultProfile?: string): Promise<ProfileChoice>;
export declare function promptConnection(defaults: Partial<ConnectionAnswers>): Promise<ConnectionAnswers>;
export declare function promptNewProfileName(existingNames: string[]): Promise<string>;
export declare function preferredNamespace(namespaces: string[], preferred?: string): string | undefined;
export declare function chooseWorkctlFeature(): Promise<WorkctlFeature>;
export declare function chooseNamespace(namespaces: string[], provided?: string): Promise<string>;
export declare function chooseTarget(targets: KubeTarget[], provided?: string): Promise<KubeTarget>;
export declare function chooseRedisTargetCandidate(targets: KubeTarget[]): Promise<KubeTarget>;
export declare function formatTargetChoice(target: KubeTarget): string;
export declare function choosePod(pods: PodSummary[], provided?: string): Promise<PodSummary>;
export declare function chooseContainer(containers: string[], provided?: string): Promise<string>;
export declare function chooseLogRange(options: {
    tailLines?: number;
    sinceMinutes?: number;
    all?: boolean;
}): Promise<LogRange>;
export declare function chooseLogSource(provided?: LogSource): Promise<LogSource>;
export declare function chooseLeqiApi(apis: LeqiApiInfo[], provided?: string): Promise<LeqiApiInfo>;
export declare function chooseLeqiAction(provided?: LeqiAction): Promise<LeqiAction>;
export declare function promptLeqiReqDto(options?: {
    provided?: string;
    defaultReqDto?: LeqiReqDto;
}): Promise<LeqiReqDto>;
export declare function promptRedisConnection(options: {
    host?: string;
    defaultHost?: string;
    port?: number;
    db?: number;
    password?: string;
}): Promise<RedisConnection>;
export declare function chooseRedisAction(provided?: RedisAction): Promise<RedisActionChoice>;
export declare function promptRedisOperation(options: {
    action: RedisAction;
    key?: string;
    pattern?: string;
    command?: string;
}): Promise<RedisOperation>;
export declare function chooseDateSelection(options: {
    date?: string;
    from?: string;
    to?: string;
    recentDays?: number;
}): Promise<DateSelection>;
export declare function chooseHistoryFiles(files: HistoryLogFile[]): Promise<HistoryLogFile[]>;
export declare function buildOutputPath(options: {
    namespace: string;
    service: string;
    pod: string;
    outputDir?: string;
}): Promise<string>;
