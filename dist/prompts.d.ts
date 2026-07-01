import type { DateSelection, HistoryLogFile, LexiangBusinessPayload, LexiangInterfaceInfo, LexiangProfile, KubeTarget, LeqiAction, LeqiApiInfo, LeqiReqDto, LogRange, LogSource, MySqlProfile, PodSummary, SavedProfile } from "./types.js";
import { type RedisAction, type RedisConnection, type RedisOperation } from "./redis.js";
import type { JarCandidate } from "./dependencies.js";
import { type LexiangCatalogInfo } from "./lexiang.js";
import { type MySqlConnection } from "./mysql-backup.js";
export declare const DEFAULT_NAMESPACE = "tax-digital";
export interface ConnectionAnswers {
    baseUrl: string;
    username: string;
    password: string;
    insecure?: boolean;
}
export type BosscliFeature = "logs" | "leqi" | "lexiang" | "leqi-sm4" | "get-hash-code" | "redis" | "mysql-backup" | "deps" | "middle-db-mock" | "file-share" | "exit";
export type RedisActionChoice = RedisAction | "switch-db" | "back";
export type LexiangNextAction = "continue" | "switch-catalog" | "switch-profile" | "home" | "exit";
export type ProfileChoice = {
    kind: "saved";
    profile: SavedProfile;
} | {
    kind: "new";
};
export type LexiangProfileChoice = {
    kind: "saved";
    profile: LexiangProfile;
} | {
    kind: "new";
};
export type MySqlProfileChoice = {
    kind: "saved";
    profile: MySqlProfile;
} | {
    kind: "new";
};
export declare function chooseSavedProfile(profiles: SavedProfile[], defaultProfile?: string): Promise<ProfileChoice>;
export declare function promptConnection(defaults: Partial<ConnectionAnswers>): Promise<ConnectionAnswers>;
export declare function promptNewProfileName(existingNames: string[]): Promise<string>;
export declare function preferredNamespace(namespaces: string[], preferred?: string): string | undefined;
export declare function chooseBosscliFeature(defaultFeature?: BosscliFeature): Promise<BosscliFeature>;
export declare function chooseLexiangProfile(profiles: LexiangProfile[], defaultProfile?: string): Promise<LexiangProfileChoice>;
export declare function chooseLexiangCatalog(catalogs: LexiangCatalogInfo[]): Promise<LexiangCatalogInfo>;
export declare function chooseMySqlProfile(profiles: MySqlProfile[], defaultProfile?: string): Promise<MySqlProfileChoice>;
export declare function promptMySqlProfile(options: {
    existingNames: string[];
}): Promise<MySqlConnection & {
    name: string;
    setDefault: boolean;
}>;
export declare function promptMySqlBackupDatabases(options: {
    source?: string;
    dest?: string;
}): Promise<{
    source: string;
    dest: string;
}>;
export declare function promptLexiangProfile(options: {
    existingNames: string[];
}): Promise<{
    name: string;
    baseUrl: string;
    appid: string;
    appkey: string;
    taxPayerNo: string;
    version: string;
}>;
export declare function chooseLexiangInterface(apis: LexiangInterfaceInfo[]): Promise<LexiangInterfaceInfo>;
export declare function promptLexiangBusinessPayload(options: {
    defaultPayload: LexiangBusinessPayload;
}): Promise<LexiangBusinessPayload>;
export declare function chooseLexiangNextAction(): Promise<LexiangNextAction>;
export declare function chooseNamespace(namespaces: string[], provided?: string): Promise<string>;
export declare function chooseTarget(targets: KubeTarget[], provided?: string): Promise<KubeTarget>;
export declare function filterTargetChoices(targets: KubeTarget[], term?: string): Array<{
    name: string;
    value: KubeTarget;
}>;
export declare function chooseRedisTargetCandidate(targets: KubeTarget[]): Promise<KubeTarget>;
export declare function formatTargetChoice(target: KubeTarget): string;
export declare function choosePod(pods: PodSummary[], provided?: string): Promise<PodSummary>;
export declare function chooseContainer(containers: string[], provided?: string): Promise<string>;
export declare function chooseJarCandidate(candidates: JarCandidate[], provided?: string): Promise<string>;
export declare function filterJarCandidateChoices(candidates: JarCandidate[], term?: string): Array<{
    name: string;
    value: string;
}>;
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
