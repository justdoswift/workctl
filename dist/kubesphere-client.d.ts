import type { ClientOptions, DownloadLogOptions, ExecOptions, ExecResult, KubeTarget, LoginConfig, PodSummary, StreamExecOptions } from "./types.js";
interface KubeObjectMeta {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    ownerReferences?: Array<{
        kind?: string;
        name?: string;
    }>;
}
export declare class KubeSphereClient {
    readonly baseUrl: string;
    private readonly cookieJar;
    private readonly dispatcher?;
    private readonly insecure;
    constructor(options: ClientOptions);
    login(username: string, password: string): Promise<void>;
    getLoginConfig(): Promise<LoginConfig>;
    listNamespaces(): Promise<string[]>;
    listTargets(namespace: string): Promise<KubeTarget[]>;
    resolveTarget(namespace: string, targetName: string): Promise<KubeTarget>;
    listPods(namespace: string, selector: Record<string, string>): Promise<PodSummary[]>;
    listPodsForTarget(target: KubeTarget): Promise<PodSummary[]>;
    downloadLog(options: DownloadLogOptions): Promise<void>;
    execCommand(options: ExecOptions): Promise<ExecResult>;
    streamExecOutput(options: StreamExecOptions): Promise<void>;
    private toPodSummary;
    private listPodsForDeployment;
    private fetchJson;
    private request;
    private buildExecWebSocketUrl;
    private handleExecMessage;
    private storeCookies;
}
export declare function deploymentReplicaSetNames(replicaSets: Array<{
    metadata?: KubeObjectMeta;
}>, deploymentName: string): Set<string>;
export declare function podBelongsToDeployment(pod: {
    metadata?: KubeObjectMeta;
}, deploymentName: string, replicaSetNames: Set<string>): boolean;
export {};
