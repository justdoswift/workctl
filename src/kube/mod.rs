use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use regex::Regex;
use reqwest::header::{ACCEPT, CONTENT_TYPE, COOKIE, SET_COOKIE};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use tokio::fs::File;
use tokio::io::AsyncWriteExt;
use tokio_tungstenite::{connect_async, tungstenite::Message};
use url::Url;

use crate::util::{
    cookie_header_from_jar, encrypt_password, join_url, merge_cookie_jar, normalize_base_url,
    parse_set_cookie_headers, selector_to_string, CookieJar,
};

#[derive(Debug, Clone)]
pub struct ClientOptions {
    pub base_url: String,
    pub insecure: bool,
}

#[derive(Debug, Clone)]
pub struct KubeSphereClient {
    pub base_url: String,
    cookie_jar: CookieJar,
    http: reqwest::Client,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KubeTarget {
    pub name: String,
    pub namespace: String,
    pub selector: BTreeMap<String, String>,
    pub desired_replicas: u32,
    pub ready_replicas: u32,
    pub available_replicas: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PodSummary {
    pub name: String,
    pub namespace: String,
    pub phase: String,
    pub ready: String,
    pub restart_count: u32,
    pub containers: Vec<String>,
    pub node_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LogRange {
    All,
    Tail(u32),
    SinceMinutes(u32),
}

#[derive(Debug, Clone)]
pub struct ExecOptions {
    pub namespace: String,
    pub pod: String,
    pub container: String,
    pub command: Vec<String>,
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct ExecResult {
    pub stdout: String,
    pub stderr: String,
    pub error: String,
}

#[derive(Debug, Deserialize)]
struct LoginGlobals {
    config: Option<LoginGlobalsConfig>,
}

#[derive(Debug, Deserialize)]
struct LoginGlobalsConfig {
    #[serde(rename = "encryptKey")]
    encrypt_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KubeList<T> {
    items: Option<Vec<T>>,
}

#[derive(Debug, Deserialize)]
struct KubeObjectMeta {
    name: Option<String>,
    #[serde(rename = "ownerReferences")]
    owner_references: Option<Vec<KubeOwnerReference>>,
}

#[derive(Debug, Deserialize)]
struct KubeOwnerReference {
    kind: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KubeDeployment {
    metadata: Option<KubeObjectMeta>,
    spec: Option<KubeDeploymentSpec>,
    status: Option<KubeDeploymentStatus>,
}

#[derive(Debug, Deserialize)]
struct KubeDeploymentSpec {
    replicas: Option<u32>,
    selector: Option<KubeDeploymentSelector>,
}

#[derive(Debug, Deserialize)]
struct KubeDeploymentSelector {
    #[serde(rename = "matchLabels")]
    match_labels: Option<BTreeMap<String, String>>,
}

#[derive(Debug, Deserialize)]
struct KubeDeploymentStatus {
    #[serde(rename = "readyReplicas")]
    ready_replicas: Option<u32>,
    #[serde(rename = "availableReplicas")]
    available_replicas: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct KubePod {
    metadata: Option<KubeObjectMeta>,
    spec: Option<KubePodSpec>,
    status: Option<KubePodStatus>,
}

#[derive(Debug, Deserialize)]
struct KubePodSpec {
    #[serde(rename = "nodeName")]
    node_name: Option<String>,
    containers: Option<Vec<KubeContainer>>,
}

#[derive(Debug, Deserialize, Clone)]
struct KubeContainer {
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct KubePodStatus {
    phase: Option<String>,
    #[serde(rename = "containerStatuses")]
    container_statuses: Option<Vec<KubeContainerStatus>>,
}

#[derive(Debug, Deserialize, Clone)]
struct KubeContainerStatus {
    ready: Option<bool>,
    #[serde(rename = "restartCount")]
    restart_count: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct KubeReplicaSet {
    metadata: Option<KubeObjectMeta>,
}

impl KubeSphereClient {
    pub fn new(options: ClientOptions) -> Result<Self> {
        let base_url = normalize_base_url(&options.base_url)?;
        let http = reqwest::Client::builder()
            .danger_accept_invalid_certs(options.insecure)
            .redirect(reqwest::redirect::Policy::limited(10))
            .build()?;
        Ok(Self {
            base_url,
            cookie_jar: CookieJar::new(),
            http,
        })
    }

    pub async fn login(&mut self, username: &str, password: &str) -> Result<()> {
        let encrypt_key = self.get_login_encrypt_key().await?;
        let encrypted = encrypt_password(&encrypt_key, password);
        let response = self
            .request(reqwest::Method::POST, "/login")
            .header(CONTENT_TYPE, "application/json")
            .json(&serde_json::json!({
                "username": username,
                "encrypt": encrypted
            }))
            .send()
            .await?;
        self.store_cookies(response.headers());
        let status = response.status();
        let text = response.text().await.unwrap_or_default();

        if !self.cookie_jar.contains_key("token") {
            return Err(anyhow!(
                "登录失败：{}",
                text.chars().take(300).collect::<String>()
            ));
        }
        if !(status.is_success() || status.is_redirection()) {
            return Err(anyhow!("登录失败：HTTP {status}"));
        }
        Ok(())
    }

    async fn get_login_encrypt_key(&mut self) -> Result<String> {
        let response = self.request(reqwest::Method::GET, "/login").send().await?;
        self.store_cookies(response.headers());
        let html = response.text().await?;
        let regex = Regex::new(r#"(?s)globals\s*=\s*JSON\.parse\(`(.*?)`\)"#)?;
        let Some(captures) = regex.captures(&html) else {
            return Ok("kubesphere".to_string());
        };
        let globals: LoginGlobals =
            serde_json::from_str(&captures[1]).unwrap_or(LoginGlobals { config: None });
        Ok(globals
            .config
            .and_then(|config| config.encrypt_key)
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "kubesphere".to_string()))
    }

    pub async fn list_namespaces(&mut self) -> Result<Vec<String>> {
        #[derive(Debug, Deserialize)]
        struct Namespace {
            metadata: Option<KubeObjectMeta>,
        }
        let data: KubeList<Namespace> = self
            .fetch_json("/kapis/resources.kubesphere.io/v1alpha3/namespaces?limit=1000")
            .await?;
        let mut names = data
            .items
            .unwrap_or_default()
            .into_iter()
            .filter_map(|item| item.metadata.and_then(|metadata| metadata.name))
            .collect::<Vec<_>>();
        names.sort();
        Ok(names)
    }

    pub async fn list_targets(&mut self, namespace: &str) -> Result<Vec<KubeTarget>> {
        let path = format!(
            "/apis/apps/v1/namespaces/{}/deployments",
            urlencoding::encode(namespace)
        );
        let data: KubeList<KubeDeployment> = self.fetch_json(&path).await?;
        let mut targets = Vec::new();
        for deployment in data.items.unwrap_or_default() {
            let name = deployment
                .metadata
                .as_ref()
                .and_then(|metadata| metadata.name.clone());
            let selector = deployment
                .spec
                .as_ref()
                .and_then(|spec| spec.selector.as_ref())
                .and_then(|selector| selector.match_labels.clone());
            let (Some(name), Some(selector)) = (name, selector) else {
                continue;
            };
            if selector.is_empty() {
                continue;
            }
            targets.push(KubeTarget {
                name,
                namespace: namespace.to_string(),
                selector,
                desired_replicas: deployment
                    .spec
                    .as_ref()
                    .and_then(|spec| spec.replicas)
                    .unwrap_or(0),
                ready_replicas: deployment
                    .status
                    .as_ref()
                    .and_then(|status| status.ready_replicas)
                    .unwrap_or(0),
                available_replicas: deployment
                    .status
                    .as_ref()
                    .and_then(|status| status.available_replicas)
                    .unwrap_or(0),
            });
        }
        targets.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(targets)
    }

    pub async fn resolve_target(
        &mut self,
        namespace: &str,
        target_name: &str,
    ) -> Result<KubeTarget> {
        self.list_targets(namespace)
            .await?
            .into_iter()
            .find(|target| target.name == target_name)
            .ok_or_else(|| anyhow!("在 namespace {namespace} 中未找到工作负载：{target_name}"))
    }

    pub async fn list_pods(
        &mut self,
        namespace: &str,
        selector: &BTreeMap<String, String>,
    ) -> Result<Vec<PodSummary>> {
        let selector = urlencoding::encode(&selector_to_string(selector)).to_string();
        let path = format!(
            "/api/v1/namespaces/{}/pods?labelSelector={selector}",
            urlencoding::encode(namespace)
        );
        let data: KubeList<KubePod> = self.fetch_json(&path).await?;
        let mut pods = data
            .items
            .unwrap_or_default()
            .into_iter()
            .filter_map(|pod| to_pod_summary(namespace, pod))
            .collect::<Vec<_>>();
        pods.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(pods)
    }

    pub async fn list_pods_for_target(&mut self, target: &KubeTarget) -> Result<Vec<PodSummary>> {
        let pods = self.list_pods(&target.namespace, &target.selector).await?;
        if !pods.is_empty() {
            return Ok(pods);
        }
        self.list_pods_for_deployment(&target.namespace, &target.name)
            .await
    }

    pub async fn download_log<F>(
        &mut self,
        namespace: &str,
        pod: &str,
        container: &str,
        range: &LogRange,
        output_path: &Path,
        mut on_progress: F,
    ) -> Result<()>
    where
        F: FnMut(u64) + Send,
    {
        let mut query = vec![
            format!("container={}", urlencoding::encode(container)),
            "timestamps=true".to_string(),
        ];
        match range {
            LogRange::All => {}
            LogRange::Tail(lines) => query.push(format!("tailLines={lines}")),
            LogRange::SinceMinutes(minutes) => query.push(format!("sinceSeconds={}", minutes * 60)),
        }
        let path = format!(
            "/api/v1/namespaces/{}/pods/{}/log?{}",
            urlencoding::encode(namespace),
            urlencoding::encode(pod),
            query.join("&")
        );
        let response = self
            .request(reqwest::Method::GET, &path)
            .header(ACCEPT, "*/*")
            .send()
            .await?;
        self.store_cookies(response.headers());
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(anyhow!(
                "日志下载失败：HTTP {status} {}",
                body.chars().take(300).collect::<String>()
            ));
        }
        if let Some(parent) = output_path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        let mut file = File::create(output_path).await?;
        let mut stream = response.bytes_stream();
        let mut downloaded = 0u64;
        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            downloaded += chunk.len() as u64;
            file.write_all(&chunk).await?;
            on_progress(downloaded);
        }
        file.flush().await?;
        Ok(())
    }

    pub async fn exec_command(&mut self, options: ExecOptions) -> Result<ExecResult> {
        let websocket_url = self.build_exec_websocket_url(&options)?;
        let cookie = cookie_header_from_jar(&self.cookie_jar);
        let mut request = http::Request::builder()
            .uri(websocket_url)
            .header("Sec-WebSocket-Protocol", "v4.channel.k8s.io");
        if !cookie.is_empty() {
            request = request.header(COOKIE.as_str(), cookie);
        }
        let request = request.body(())?;

        let (mut socket, _) = tokio::time::timeout(
            std::time::Duration::from_millis(options.timeout_ms),
            connect_async(request),
        )
        .await
        .context("exec 超时")??;

        let mut result = ExecResult::default();
        while let Some(message) = tokio::time::timeout(
            std::time::Duration::from_millis(options.timeout_ms),
            socket.next(),
        )
        .await
        .context("exec 超时")?
        {
            let message = message?;
            match message {
                Message::Binary(data) => decode_exec_message(data.as_ref(), &mut result),
                Message::Text(text) => result.stdout.push_str(&text),
                Message::Close(_) => break,
                _ => {}
            }
        }
        Ok(result)
    }

    pub async fn stream_exec_output<F, G, H>(
        &mut self,
        options: ExecOptions,
        mut on_stdout: F,
        mut on_stderr: G,
        mut on_error: H,
    ) -> Result<()>
    where
        F: FnMut(&[u8]) + Send,
        G: FnMut(&[u8]) + Send,
        H: FnMut(&[u8]) + Send,
    {
        let websocket_url = self.build_exec_websocket_url(&options)?;
        let cookie = cookie_header_from_jar(&self.cookie_jar);
        let mut request = http::Request::builder()
            .uri(websocket_url)
            .header("Sec-WebSocket-Protocol", "v4.channel.k8s.io");
        if !cookie.is_empty() {
            request = request.header(COOKIE.as_str(), cookie);
        }
        let request = request.body(())?;

        let (mut socket, _) = tokio::time::timeout(
            std::time::Duration::from_millis(options.timeout_ms),
            connect_async(request),
        )
        .await
        .context("exec 超时")??;

        while let Some(message) = tokio::time::timeout(
            std::time::Duration::from_millis(options.timeout_ms),
            socket.next(),
        )
        .await
        .context("exec 超时")?
        {
            let message = message?;
            match message {
                Message::Binary(data) => {
                    decode_exec_chunk(data.as_ref(), &mut on_stdout, &mut on_stderr, &mut on_error)
                }
                Message::Text(text) => on_stdout(text.as_bytes()),
                Message::Close(_) => break,
                _ => {}
            }
        }
        Ok(())
    }

    async fn list_pods_for_deployment(
        &mut self,
        namespace: &str,
        deployment_name: &str,
    ) -> Result<Vec<PodSummary>> {
        let replica_sets: KubeList<KubeReplicaSet> = self
            .fetch_json(&format!(
                "/apis/apps/v1/namespaces/{}/replicasets?limit=1000",
                urlencoding::encode(namespace)
            ))
            .await?;
        let pods: KubeList<KubePod> = self
            .fetch_json(&format!(
                "/api/v1/namespaces/{}/pods?limit=1000",
                urlencoding::encode(namespace)
            ))
            .await?;
        let replica_set_names =
            deployment_replica_set_names(&replica_sets.items.unwrap_or_default(), deployment_name);
        let mut pods = pods
            .items
            .unwrap_or_default()
            .into_iter()
            .filter(|pod| pod_belongs_to_deployment(pod, deployment_name, &replica_set_names))
            .filter_map(|pod| to_pod_summary(namespace, pod))
            .collect::<Vec<_>>();
        pods.sort_by(|left, right| left.name.cmp(&right.name));
        Ok(pods)
    }

    async fn fetch_json<T>(&mut self, api_path: &str) -> Result<T>
    where
        T: for<'de> Deserialize<'de>,
    {
        let response = self
            .request(reqwest::Method::GET, api_path)
            .header(ACCEPT, "application/json")
            .send()
            .await?;
        self.store_cookies(response.headers());
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            return Err(anyhow!(
                "请求失败：HTTP {status} {}",
                text.chars().take(300).collect::<String>()
            ));
        }
        serde_json::from_str(&text).map_err(|_| {
            anyhow!(
                "响应不是 JSON：{}",
                text.chars().take(120).collect::<String>()
            )
        })
    }

    fn request(&self, method: reqwest::Method, api_path: &str) -> reqwest::RequestBuilder {
        let mut builder = self
            .http
            .request(method, join_url(&self.base_url, api_path));
        let cookie = cookie_header_from_jar(&self.cookie_jar);
        if !cookie.is_empty() {
            builder = builder.header(COOKIE, cookie);
        }
        builder
    }

    fn store_cookies(&mut self, headers: &reqwest::header::HeaderMap) {
        let set_cookie_headers = headers
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok())
            .map(|value| value.to_string())
            .collect::<Vec<_>>();
        merge_cookie_jar(
            &mut self.cookie_jar,
            parse_set_cookie_headers(&set_cookie_headers),
        );
    }

    fn build_exec_websocket_url(&self, options: &ExecOptions) -> Result<String> {
        let mut query = vec![
            format!("container={}", urlencoding::encode(&options.container)),
            "stdout=true".to_string(),
            "stderr=true".to_string(),
            "stdin=false".to_string(),
            "tty=false".to_string(),
        ];
        for command_part in &options.command {
            query.push(format!("command={}", urlencoding::encode(command_part)));
        }
        let http_url = join_url(
            &self.base_url,
            &format!(
                "/api/v1/namespaces/{}/pods/{}/exec?{}",
                urlencoding::encode(&options.namespace),
                urlencoding::encode(&options.pod),
                query.join("&")
            ),
        );
        let mut url = Url::parse(&http_url)?;
        url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" })
            .map_err(|_| anyhow!("无法转换 exec WebSocket URL"))?;
        Ok(url.to_string())
    }
}

fn to_pod_summary(namespace: &str, pod: KubePod) -> Option<PodSummary> {
    let name = pod.metadata.as_ref()?.name.clone()?;
    let declared_containers = pod
        .spec
        .as_ref()
        .and_then(|spec| spec.containers.clone())
        .unwrap_or_default();
    let container_statuses = pod
        .status
        .as_ref()
        .and_then(|status| status.container_statuses.clone())
        .unwrap_or_default();
    let ready_count = container_statuses
        .iter()
        .filter(|status| status.ready.unwrap_or(false))
        .count();
    let containers = declared_containers
        .iter()
        .filter_map(|container| container.name.clone())
        .collect::<Vec<_>>();
    let restart_count = container_statuses
        .iter()
        .map(|status| status.restart_count.unwrap_or(0))
        .sum();
    let ready_total = declared_containers
        .len()
        .max(container_statuses.len())
        .max(containers.len());

    Some(PodSummary {
        name,
        namespace: namespace.to_string(),
        phase: pod
            .status
            .and_then(|status| status.phase)
            .unwrap_or_else(|| "Unknown".to_string()),
        ready: format!("{ready_count}/{ready_total}"),
        restart_count,
        containers,
        node_name: pod.spec.and_then(|spec| spec.node_name),
    })
}

fn deployment_replica_set_names(
    replica_sets: &[KubeReplicaSet],
    deployment_name: &str,
) -> HashSet<String> {
    replica_sets
        .iter()
        .filter_map(|replica_set| replica_set.metadata.as_ref())
        .filter(|metadata| {
            metadata
                .owner_references
                .as_ref()
                .map(|owners| {
                    owners.iter().any(|owner| {
                        owner.kind.as_deref() == Some("Deployment")
                            && owner.name.as_deref() == Some(deployment_name)
                    })
                })
                .unwrap_or(false)
        })
        .filter_map(|metadata| metadata.name.clone())
        .collect()
}

fn pod_belongs_to_deployment(
    pod: &KubePod,
    deployment_name: &str,
    replica_set_names: &HashSet<String>,
) -> bool {
    let pod_name = pod
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.name.as_deref())
        .unwrap_or_default();
    let owned_by_replica_set = pod
        .metadata
        .as_ref()
        .and_then(|metadata| metadata.owner_references.as_ref())
        .map(|owners| {
            owners.iter().any(|owner| {
                owner.kind.as_deref() == Some("ReplicaSet")
                    && owner
                        .name
                        .as_ref()
                        .map(|name| replica_set_names.contains(name))
                        .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    owned_by_replica_set || pod_name.starts_with(&format!("{deployment_name}-"))
}

fn decode_exec_message(data: &[u8], result: &mut ExecResult) {
    if data.is_empty() {
        return;
    }
    let channel = data[0];
    let payload = String::from_utf8_lossy(&data[1..]);
    match channel {
        1 => result.stdout.push_str(&payload),
        2 => result.stderr.push_str(&payload),
        3 => result.error.push_str(&payload),
        _ => {}
    }
}

fn decode_exec_chunk<F, G, H>(data: &[u8], on_stdout: &mut F, on_stderr: &mut G, on_error: &mut H)
where
    F: FnMut(&[u8]),
    G: FnMut(&[u8]),
    H: FnMut(&[u8]),
{
    if data.is_empty() {
        return;
    }
    match data[0] {
        1 => on_stdout(&data[1..]),
        2 => on_stderr(&data[1..]),
        3 => on_error(&data[1..]),
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_exec_channels() {
        let mut result = ExecResult::default();
        decode_exec_message(&[1, b'o', b'k'], &mut result);
        decode_exec_message(&[2, b'e'], &mut result);
        decode_exec_message(&[3, b'x'], &mut result);
        assert_eq!(result.stdout, "ok");
        assert_eq!(result.stderr, "e");
        assert_eq!(result.error, "x");
    }
}
