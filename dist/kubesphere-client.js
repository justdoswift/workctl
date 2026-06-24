import fs from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Agent, fetch } from "undici";
import WebSocket from "ws";
import { cookieHeaderFromJar, encryptPassword, joinUrl, mergeCookieJar, normalizeBaseUrl, parseSetCookieHeaders, selectorToString } from "./utils.js";
export class KubeSphereClient {
    baseUrl;
    cookieJar = new Map();
    dispatcher;
    insecure;
    constructor(options) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl);
        this.insecure = Boolean(options.insecure);
        this.dispatcher = options.insecure
            ? new Agent({ connect: { rejectUnauthorized: false } })
            : undefined;
    }
    async login(username, password) {
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
    async getLoginConfig() {
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
        }
        catch {
            return { encryptKey: "kubesphere" };
        }
    }
    async listNamespaces() {
        const data = await this.fetchJson("/kapis/resources.kubesphere.io/v1alpha3/namespaces?limit=1000");
        return (data.items ?? [])
            .map((item) => item.metadata?.name)
            .filter((name) => Boolean(name))
            .sort((left, right) => left.localeCompare(right));
    }
    async listTargets(namespace) {
        const [services, deployments] = await Promise.all([
            this.fetchJson(`/api/v1/namespaces/${encodeURIComponent(namespace)}/services`),
            this.fetchJson(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/deployments`)
        ]);
        const targets = [];
        const serviceNames = new Set();
        for (const service of services.items ?? []) {
            const name = service.metadata?.name;
            const selector = service.spec?.selector;
            if (!name || !selector || Object.keys(selector).length === 0) {
                continue;
            }
            serviceNames.add(name);
            targets.push({
                kind: "Service",
                name,
                namespace,
                selector
            });
        }
        for (const deployment of deployments.items ?? []) {
            const name = deployment.metadata?.name;
            const selector = deployment.spec?.selector?.matchLabels;
            if (!name || !selector || Object.keys(selector).length === 0 || serviceNames.has(name)) {
                continue;
            }
            targets.push({
                kind: "Deployment",
                name,
                namespace,
                selector
            });
        }
        return targets.sort((left, right) => left.name.localeCompare(right.name));
    }
    async resolveTarget(namespace, targetName) {
        const targets = await this.listTargets(namespace);
        const target = targets.find((item) => item.kind === "Service" && item.name === targetName) ??
            targets.find((item) => item.name === targetName);
        if (!target) {
            throw new Error(`在 namespace ${namespace} 中未找到服务或工作负载：${targetName}`);
        }
        return target;
    }
    async listPods(namespace, selector) {
        const selectorText = selectorToString(selector);
        const encodedSelector = encodeURIComponent(selectorText);
        const data = await this.fetchJson(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?labelSelector=${encodedSelector}`);
        return (data.items ?? [])
            .map((pod) => this.toPodSummary(namespace, pod))
            .filter((pod) => Boolean(pod))
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    async listPodsForTarget(target) {
        const pods = await this.listPods(target.namespace, target.selector);
        if (pods.length > 0 || target.kind !== "Deployment") {
            return pods;
        }
        return this.listPodsForDeployment(target.namespace, target.name);
    }
    async downloadLog(options) {
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
        const apiPath = `/api/v1/namespaces/${encodeURIComponent(options.namespace)}/pods/${encodeURIComponent(options.pod)}/log?${query.toString()}`;
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
            transform(chunk, _encoding, callback) {
                downloadedBytes += chunk.length;
                options.onProgress?.(downloadedBytes);
                callback(null, chunk);
            }
        });
        await pipeline(Readable.fromWeb(response.body), progressStream, fs.createWriteStream(options.outputPath));
    }
    async execCommand(options) {
        const stdoutChunks = [];
        const stderrChunks = [];
        const errorChunks = [];
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
    async streamExecOutput(options) {
        const websocketUrl = this.buildExecWebSocketUrl(options);
        const cookieHeader = cookieHeaderFromJar(this.cookieJar);
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                socket.terminate();
                reject(new Error(`exec 超时：${options.timeoutMs ?? 120000}ms`));
            }, options.timeoutMs ?? 120000);
            const socket = new WebSocket(websocketUrl, "v4.channel.k8s.io", {
                headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
                rejectUnauthorized: !this.insecure
            });
            let settled = false;
            const fail = (error) => {
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
    toPodSummary(namespace, pod) {
        const name = pod.metadata?.name;
        if (!name) {
            return undefined;
        }
        const containerStatuses = pod.status?.containerStatuses ?? [];
        const readyCount = containerStatuses.filter((status) => status.ready).length;
        const declaredContainers = pod.spec?.containers ?? [];
        const containers = declaredContainers
            .map((container) => container.name)
            .filter((containerName) => Boolean(containerName));
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
    async listPodsForDeployment(namespace, deploymentName) {
        const [replicaSets, pods] = await Promise.all([
            this.fetchJson(`/apis/apps/v1/namespaces/${encodeURIComponent(namespace)}/replicasets?limit=1000`),
            this.fetchJson(`/api/v1/namespaces/${encodeURIComponent(namespace)}/pods?limit=1000`)
        ]);
        const replicaSetNames = deploymentReplicaSetNames(replicaSets.items ?? [], deploymentName);
        return (pods.items ?? [])
            .filter((pod) => podBelongsToDeployment(pod, deploymentName, replicaSetNames))
            .map((pod) => this.toPodSummary(namespace, pod))
            .filter((pod) => Boolean(pod))
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    async fetchJson(apiPath) {
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
            return JSON.parse(text);
        }
        catch {
            throw new Error(`响应不是 JSON：${text.slice(0, 120)}`);
        }
    }
    async request(apiPath, options = {}) {
        const headers = {
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
    buildExecWebSocketUrl(options) {
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
        const httpUrl = joinUrl(this.baseUrl, `/api/v1/namespaces/${encodeURIComponent(options.namespace)}/pods/${encodeURIComponent(options.pod)}/exec?${query.toString()}`);
        const url = new URL(httpUrl);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        return url.toString();
    }
    async handleExecMessage(data, options) {
        const buffer = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data);
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
            await options.onErrorChannel?.(payload);
        }
    }
    async storeCookies(headers) {
        const getSetCookie = headers.getSetCookie;
        const setCookieHeaders = typeof getSetCookie === "function"
            ? getSetCookie.call(headers)
            : headers.get("set-cookie")
                ? [headers.get("set-cookie")]
                : [];
        mergeCookieJar(this.cookieJar, parseSetCookieHeaders(setCookieHeaders));
    }
}
export function deploymentReplicaSetNames(replicaSets, deploymentName) {
    return new Set(replicaSets
        .map((replicaSet) => replicaSet.metadata)
        .filter((metadata) => Boolean(metadata?.name))
        .filter((metadata) => (metadata.ownerReferences ?? []).some((owner) => owner.kind === "Deployment" && owner.name === deploymentName))
        .map((metadata) => metadata.name));
}
export function podBelongsToDeployment(pod, deploymentName, replicaSetNames) {
    const podName = pod.metadata?.name ?? "";
    const owners = pod.metadata?.ownerReferences ?? [];
    const ownedByReplicaSet = owners.some((owner) => owner.kind === "ReplicaSet" && Boolean(owner.name) && replicaSetNames.has(owner.name));
    return ownedByReplicaSet || podName.startsWith(`${deploymentName}-`);
}
//# sourceMappingURL=kubesphere-client.js.map