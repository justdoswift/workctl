export type CookieJar = Map<string, string>;
export interface ClientOptions {
    baseUrl: string;
    insecure?: boolean;
}
export interface LoginConfig {
    encryptKey: string;
    version?: string;
}
export interface KubeTarget {
    kind: "Deployment";
    name: string;
    namespace: string;
    selector: Record<string, string>;
    desiredReplicas?: number;
    readyReplicas?: number;
    availableReplicas?: number;
}
export interface PodSummary {
    name: string;
    namespace: string;
    phase: string;
    ready: string;
    restartCount: number;
    containers: string[];
    nodeName?: string;
}
export interface LogRange {
    mode: "all" | "tail" | "since";
    tailLines?: number;
    sinceSeconds?: number;
}
export interface DownloadLogOptions {
    namespace: string;
    pod: string;
    container: string;
    range: LogRange;
    outputPath: string;
    timestamps?: boolean;
    onProgress?: (bytes: number) => void;
}
export type LogSource = "current" | "history";
export interface ExecOptions {
    namespace: string;
    pod: string;
    container: string;
    command: string[];
    timeoutMs?: number;
}
export interface ExecResult {
    stdout: string;
    stderr: string;
    error: string;
}
export interface StreamExecOptions extends ExecOptions {
    onStdout?: (chunk: Buffer) => void | Promise<void>;
    onStderr?: (chunk: Buffer) => void | Promise<void>;
    onErrorChannel?: (chunk: Buffer) => void | Promise<void>;
}
export interface SavedProfile {
    name: string;
    url: string;
    username: string;
    password: string;
    redisPassword?: string;
    insecure: boolean;
    createdAt: string;
    updatedAt: string;
}
export interface ProfilesFile {
    defaultProfile?: string;
    profiles: SavedProfile[];
}
export interface DateSelection {
    from: string;
    to: string;
    dates: string[];
}
export interface HistoryLogFile {
    path: string;
    size?: number;
}
export interface LeqiApiInfo {
    apiIdentity: string;
    apiName: string;
    remarks?: string;
    module?: string;
    urlSuffix?: string;
    useCaseCode?: string;
    serverCode?: string;
    abilityCode?: string;
    sceneCode?: string;
}
export type JsonValue = null | string | number | boolean | JsonValue[] | {
    [key: string]: JsonValue;
};
export type LeqiReqDto = {
    [key: string]: JsonValue;
} | JsonValue[];
export interface LeqiReqDtoField {
    key: string;
    name: string;
    type: string;
    length: string;
    required: string;
    description: string;
}
export interface LeqiReqDtoTemplate {
    apiIdentity: string;
    apiName: string;
    abilityCode?: string;
    serverCode?: string;
    sourceDoc: string;
    sectionTitle: string;
    fields: LeqiReqDtoField[];
    template: LeqiReqDto;
}
export interface LeqiInvokePayload {
    apiIdentity: string;
    taxPayerNo: string;
    testMode: number;
    reqDTO: LeqiReqDto;
}
export type LeqiAction = "curl" | "call";
