import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

import { Agent, fetch, type Dispatcher } from "undici";
import WebSocket from "ws";

import type {
  ClientOptions,
  CookieJar,
  DownloadLogOptions,
  ExecOptions,
  ExecResult,
  KubeServiceSummary,
  KubeTarget,
  LoginConfig,
  PodSummary,
  StreamExecOptions
} from "./types.js";
import {
  cookieHeaderFromJar,
  encryptPassword,
  joinUrl,
  mergeCookieJar,
  normalizeBaseUrl,
  parseSetCookieHeaders,
  selectorToString
} from "./utils.js";

interface HeadersLike {
  get(name: string): string | null;
  getSetCookie?: () => string[];
}

interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  redirect?: "follow" | "manual";
}

interface KubeList<T> {
  items?: T[];
  kind?: string;
  message?: string;
}

interface KubeObjectMeta {
  name?: string;
  namespace?: string;
  labels?: Record<string, string>;
  ownerReferences?: Array<{
    kind?: string;
    name?: string;
  }>;
}

interface KubeDeployment {
  metadata?: KubeObjectMeta;
  spec?: {
    replicas?: number;
    selector?: {
      matchLabels?: Record<string, string>;
    };
  };
  status?: {
    readyReplicas?: number;
    availableReplicas?: number;
  };
}

interface KubePod {
  metadata?: KubeObjectMeta;
  spec?: {
    nodeName?: string;
    containers?: Array<{ name?: string }>;
  };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
    }>;
  };
}

interface KubeService {
  metadata?: KubeObjectMeta;
  spec?: {
    clusterIP?: string;
    ports?: Array<{
      port?: number;
    }>;
  };
}

interface KubeReplicaSet {
  metadata?: KubeObjectMeta;
}

interface ExecStatus {
  status?: string;
  message?: string;
  reason?: string;
  details?: {
    causes?: Array<{
      reason?: string;
      message?: string;
    }>;
  };
}

export class KubeSphereClient {
  readonly baseUrl: string;

  private readonly cookieJar: CookieJar = new Map();
  private readonly dispatcher?: Dispatcher;
  private readonly insecure: boolean;

  constructor(options: ClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.insecure = Boolean(options.insecure);
    this.dispatcher = options.insecure
      ? new Agent({ connect: { rejectUnauthorized: false } })
      : undefined;
  }

  async login(username: string, password: string): Promise<void> {
    const config = await this.getLoginConfig();
    const encryptedPassword = encryptPassword(config.encryptKey, password);

    const response = await this.request("/login", {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        username,
        encrypt: encryptedPassword
      })
    });

    await this.storeCookies(response.headers);

    if (!this.cookieJar.has("token")) {
      const body = await response.text();
      throw new Error(`登录失败：${body.slice(0, 300) || response.statusText}`);
    }

    if (![200, 201, 204, 302, 303].includes(response.status)) {
      throw new Error(`登录失败：HTTP ${response.status} ${response.statusText}`);
    }
  }

  async getLoginConfig(): Promise<LoginConfig> {
    const response = await this.request("/login", { method: "GET" });
    const html = await response.text();
    const match = html.match(/globals\s*=\s*JSON\.parse\(`([\s\S]*?)`\)/);

    if (!match) {
      return { encryptKey: "kubesphere" };
    }

    try {
      const globals = JSON.parse(match[1]);
      return {
        encryptKey: globals?.config?.encryptKey || "kubesphere",
        version: globals?.config?.version?.kubesphere
      };
    } catch {
      return { encryptKey: "kubesphere" };
    }
  }

  async listNamespaces(): Promise<string[]> {
    const data = await this.fetchJson<KubeList<{ metadata?: KubeObjectMeta }>>(
      "/kapis/resources.kubesphere.io/v1alpha3/namespaces?limit=1000"
    );

    return (data.items ?? [])
      .map((item) => item.metadata?.name)
      .filter((name): name is string => Boolean(name))
      .sort((left, right) => left.localeCompare(right));
  }

  async listTargets(namespace: string): Promise<KubeTarget[]> {
    const deployments = await this.fetchJson<KubeList<KubeDeployment>>(
      `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`
    );

    const targets: KubeTarget[] = [];

    for (const deployment of deployments.items ?? []) {
      const name = deployment.metadata?.name;
      const selector = deployment.spec?.selector?.matchLabels;

      if (!name || !selector || Object.keys(selector).length === 0) {
        continue;
      }

      targets.push({
        kind: "Deployment",
        name,
        namespace,
        selector,
        desiredReplicas: deployment.spec?.replicas ?? 0,
        readyReplicas: deployment.status?.readyReplicas ?? 0,
        availableReplicas: deployment.status?.availableReplicas ?? 0
      });
    }

    return targets.sort((left, right) => left.name.localeCompare(right.name));
  }

  async resolveTarget(namespace: string, targetName: string): Promise<KubeTarget> {
    const targets = await this.listTargets(namespace);
    const target = targets.find((item) => item.name === targetName);

    if (!target) {
      throw new Error(`在 namespace ${namespace} 中未找到工作负载：${targetName}`);
    }

    return target;
  }

  async listServices(namespace: string): Promise<KubeServiceSummary[]> {
    const data = await this.fetchJson<KubeList<KubeService>>(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/services?limit=1000`
    );

    return (data.items ?? [])
      .map((service): KubeServiceSummary | undefined => {
        const name = service.metadata?.name;
        if (!name) {
          return undefined;
        }

        const summary: KubeServiceSummary = {
          name,
          namespace,
          ports: (service.spec?.ports ?? [])
            .map((port) => port.port)
            .filter((port): port is number => typeof port === "number")
        };
        if (service.spec?.clusterIP) {
          summary.clusterIP = service.spec.clusterIP;
        }

        return summary;
      })
      .filter((service): service is KubeServiceSummary => Boolean(service))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listPods(namespace: string, selector: Record<string, string>): Promise<PodSummary[]> {
    const selectorText = selectorToString(selector);
    const encodedSelector = encodeURIComponent(selectorText);
    const data = await this.fetchJson<KubeList<KubePod>>(
      `/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodedSelector}`
    );

    return (data.items ?? [])
      .map((pod) => this.toPodSummary(namespace, pod))
      .filter((pod): pod is PodSummary => Boolean(pod))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  async listPodsForTarget(target: KubeTarget): Promise<PodSummary[]> {
    const pods = await this.listPods(target.namespace, target.selector);

    if (pods.length > 0) {
      return pods;
    }

    return this.listPodsForDeployment(target.namespace, target.name);
  }

  async downloadLog(options: DownloadLogOptions): Promise<void> {
    const query = new URLSearchParams({
      container: options.container
    });

    if (options.timestamps ?? true) {
      query.set("timestamps", "true");
    }

    if (options.range.mode === "tail" && options.range.tailLines) {
      query.set("tailLines", String(options.range.tailLines));
    }

    if (options.range.mode === "since" && options.range.sinceSeconds) {
      query.set("sinceSeconds", String(options.range.sinceSeconds));
    }

    const apiPath = `/api/v1/namespaces/${encodeURIComponent(options.namespace)}/pods/${encodeURIComponent(
      options.pod
    )}/log?${query.toString()}`;
    const response = await this.request(apiPath, {
      method: "GET",
      headers: {
        accept: "*/*"
      }
    });

    if (!response.ok || !response.body) {
      const body = await response.text();
      throw new Error(`日志下载失败：HTTP ${response.status} ${body.slice(0, 300)}`);
    }

    let downloadedBytes = 0;
    const progressStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.length;
        options.onProgress?.(downloadedBytes);
        callback(null, chunk);
      }
    });

    await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(options.outputPath));
  }

  async execCommand(options: ExecOptions): Promise<ExecResult> {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];

    await this.streamExecOutput({
      ...options,
      onStdout: (chunk) => {
        stdoutChunks.push(chunk);
      },
      onStderr: (chunk) => {
        stderrChunks.push(chunk);
      },
      onErrorChannel: (chunk) => {
        errorChunks.push(chunk);
      }
    });

    return {
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      error: Buffer.concat(errorChunks).toString("utf8")
    };
  }

  async streamExecOutput(options: StreamExecOptions): Promise<void> {
    const websocketUrl = this.buildExecWebSocketUrl(options);
    const cookieHeader = cookieHeaderFromJar(this.cookieJar);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.terminate();
        reject(new Error(`exec 超时：${options.timeoutMs ?? 120000}ms`));
      }, options.timeoutMs ?? 120000);
      const socket = new WebSocket(websocketUrl, "v4.channel.k8s.io", {
        headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
        rejectUnauthorized: !this.insecure
      });

      let settled = false;
      const fail = (error: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        reject(error);
      };
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve();
      };

      socket.on("error", fail);
      socket.on("unexpected-response", (_request, response) => {
        fail(new Error(`exec WebSocket upgrade 失败：HTTP ${response.statusCode}`));
      });
      socket.on("message", (data) => {
        void this.handleExecMessage(data, options).catch(fail);
      });
      socket.on("close", finish);
    });
  }

  private toPodSummary(namespace: string, pod: KubePod): PodSummary | undefined {
    const name = pod.metadata?.name;

    if (!name) {
      return undefined;
    }

    const containerStatuses = pod.status?.containerStatuses ?? [];
    const readyCount = containerStatuses.filter((status) => status.ready).length;
    const declaredContainers = pod.spec?.containers ?? [];
    const containers = declaredContainers
      .map((container) => container.name)
      .filter((containerName): containerName is string => Boolean(containerName));
    const restartCount = containerStatuses.reduce((total, status) => total + (status.restartCount ?? 0), 0);

    return {
      name,
      namespace,
      phase: pod.status?.phase ?? "Unknown",
      ready: `${readyCount}/${declaredContainers.length || containerStatuses.length || containers.length}`,
      restartCount,
      containers,
      nodeName: pod.spec?.nodeName
    };
  }

  private async listPodsForDeployment(namespace: string, deploymentName: string): Promise<PodSummary[]> {
    const [replicaSets, pods] = await Promise.all([
      this.fetchJson<KubeList<KubeReplicaSet>>(
        `/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets?limit=1000`
      ),
      this.fetchJson<KubeList<KubePod>>(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?limit=1000`)
    ]);
    const replicaSetNames = deploymentReplicaSetNames(replicaSets.items ?? [], deploymentName);

    return (pods.items ?? [])
      .filter((pod) => podBelongsToDeployment(pod, deploymentName, replicaSetNames))
      .map((pod) => this.toPodSummary(namespace, pod))
      .filter((pod): pod is PodSummary => Boolean(pod))
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  private async fetchJson<T>(apiPath: string): Promise<T> {
    const response = await this.request(apiPath, {
      headers: {
        accept: "application/json"
      }
    });
    const text = await response.text();

    if (!response.ok) {
      throw new Error(`请求失败：HTTP ${response.status} ${text.slice(0, 300)}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`响应不是 JSON：${text.slice(0, 120)}`);
    }
  }

  private async request(apiPath: string, options: RequestOptions = {}) {
    const headers: Record<string, string> = {
      ...(options.headers ?? {})
    };
    const cookieHeader = cookieHeaderFromJar(this.cookieJar);

    if (cookieHeader) {
      headers.cookie = cookieHeader;
    }

    const response = await fetch(joinUrl(this.baseUrl, apiPath), {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      redirect: options.redirect ?? "follow",
      dispatcher: this.dispatcher
    });

    await this.storeCookies(response.headers);
    return response;
  }

  private buildExecWebSocketUrl(options: ExecOptions): string {
    const query = new URLSearchParams({
      container: options.container,
      stdout: "true",
      stderr: "true",
      stdin: "false",
      tty: "false"
    });

    for (const commandPart of options.command) {
      query.append("command", commandPart);
    }

    const httpUrl = joinUrl(
      this.baseUrl,
      `/api/v1/namespaces/${encodeURIComponent(options.namespace)}/pods/${encodeURIComponent(
        options.pod
      )}/exec?${query.toString()}`
    );
    const url = new URL(httpUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }

  private async handleExecMessage(data: WebSocket.RawData, options: StreamExecOptions): Promise<void> {
    const buffer = Buffer.isBuffer(data)
      ? data
      : Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.from(data as ArrayBuffer);

    if (buffer.length === 0) {
      return;
    }

    const channel = buffer[0];
    const payload = buffer.subarray(1);

    if (channel === 1) {
      await options.onStdout?.(payload);
      return;
    }

    if (channel === 2) {
      await options.onStderr?.(payload);
      return;
    }

    if (channel === 3) {
      const statusError = parseExecStatusError(payload);
      if (statusError) {
        await options.onErrorChannel?.(Buffer.from(statusError));
      }
    }
  }

  private async storeCookies(headers: HeadersLike): Promise<void> {
    const getSetCookie = headers.getSetCookie;
    const setCookieHeaders =
      typeof getSetCookie === "function"
        ? getSetCookie.call(headers)
        : headers.get("set-cookie")
          ? [headers.get("set-cookie") as string]
          : [];

    mergeCookieJar(this.cookieJar, parseSetCookieHeaders(setCookieHeaders));
  }
}

export function parseExecStatusError(payload: Buffer | string): string | undefined {
  const text = Buffer.isBuffer(payload) ? payload.toString("utf8").trim() : payload.trim();

  if (!text) {
    return undefined;
  }

  try {
    const status = JSON.parse(text) as ExecStatus;

    if (status.status === "Success") {
      return undefined;
    }

    const causes = status.details?.causes
      ?.map((cause) => [cause.reason, cause.message].filter(Boolean).join(": "))
      .filter(Boolean);
    const parts = [status.status, status.reason, status.message, ...(causes ?? [])].filter(Boolean);

    return parts.length > 0 ? `exec 状态失败：${parts.join("；")}` : text;
  } catch {
    return text;
  }
}

export function deploymentReplicaSetNames(
  replicaSets: Array<{ metadata?: KubeObjectMeta }>,
  deploymentName: string
): Set<string> {
  return new Set(
    replicaSets
      .map((replicaSet) => replicaSet.metadata)
      .filter((metadata): metadata is KubeObjectMeta => Boolean(metadata?.name))
      .filter((metadata) =>
        (metadata.ownerReferences ?? []).some(
          (owner) => owner.kind === "Deployment" && owner.name === deploymentName
        )
      )
      .map((metadata) => metadata.name as string)
  );
}

export function podBelongsToDeployment(
  pod: { metadata?: KubeObjectMeta },
  deploymentName: string,
  replicaSetNames: Set<string>
): boolean {
  const podName = pod.metadata?.name ?? "";
  const owners = pod.metadata?.ownerReferences ?? [];
  const ownedByReplicaSet = owners.some(
    (owner) => owner.kind === "ReplicaSet" && Boolean(owner.name) && replicaSetNames.has(owner.name as string)
  );

  return ownedByReplicaSet || podName.startsWith(`${deploymentName}-`);
}
