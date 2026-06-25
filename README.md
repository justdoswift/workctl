# workctl

`workctl` 是一个日常工作工具集 TUI。当前用 Rust + Ratatui 重写，启动后直接进入终端界面：

- `K8s 日志`：登录 KubeSphere，选择 namespace、Deployment、Pod、容器，下载当前日志或从 `/opt/saas-logs` 抽取历史日志。
- `乐企接口`：使用内置的 131 条乐企接口快照，选择接口后导出 curl，或在集群内 Pod 里直接调用。
- `环境配置`：新增、删除、设置默认 KubeSphere 环境。

> 这是破坏性重写。旧版 Node/TypeScript 运行时和 `current/history/download/leqi/profile/login-check` 子命令已移除；除 `--help`、`--version` 外，裸 `workctl` 是主入口。

## 一行安装

```bash
curl -fsSL https://raw.githubusercontent.com/justdoswift/workctl/main/install.sh | bash
```

安装脚本会下载 GitHub 源码并在本机执行 `cargo build --release`，所以需要先安装 Rust 工具链：

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

默认安装到：

```text
~/.workctl/cli
~/.workctl/bin/workctl
```

如果终端找不到 `workctl`，把下面这行加入 `~/.zshrc`：

```bash
export PATH="$HOME/.workctl/bin:$PATH"
```

验证：

```bash
workctl --version
workctl --help
workctl
```

自定义安装目录：

```bash
curl -fsSL https://raw.githubusercontent.com/justdoswift/workctl/main/install.sh | \
  WORKCTL_INSTALL_DIR="$HOME/.local/share/workctl" \
  WORKCTL_BIN_DIR="$HOME/.local/bin" \
  WORKCTL_REF="main" \
  bash
```

重复执行同一条 curl 命令即可升级。

卸载程序文件：

```bash
rm -rf ~/.workctl/cli ~/.workctl/bin/workctl
```

卸载不会删除 `~/.workctl/profiles.json`。

## 配置

环境配置保存到：

```text
~/.workctl/profiles.json
```

按需求，`name/url/username/password` 会明文保存，文件权限会设置为 `0600`。首次读取配置时，如果 `~/.workctl/profiles.json` 不存在但旧版 `~/.kslog/profiles.json` 存在，会自动复制迁移，旧文件保留不删除。

默认日志输出目录：

```text
~/Downloads/workctl/kubesphere-logs
```

## 功能

### K8s 日志

启动 `workctl` 后选择 `K8s 日志`：

1. 选择已保存环境，或新增环境。
2. 选择 namespace，默认高亮 `tax-digital`。
3. 选择 Deployment。列表会显示运行状态，例如 `(1/1)`、`(0/0)`。
4. 选择 Pod 和 container。
5. 选择当前容器日志或历史文件日志。
6. 确认摘要后下载，进度页显示已处理大小、总大小、速度和耗时。

当前容器日志使用 Kubernetes Pod log API；历史日志通过 Kubernetes exec WebSocket 进入容器读取 `/opt/saas-logs`，按日志内容日期筛选，只导出匹配日期的行。

### 乐企接口

选择 `乐企接口` 后，可以搜索并选择内置接口。接口目录来源于 `lxzsdb.tax_leqi_api_info` 当前启用接口快照，共 131 条；运行时不会连接 MySQL，也不会询问接口库密码。

填写 `taxPayerNo/testMode/reqDTO` 后可以：

- 导出可复制 curl。
- 直接调用。直接调用前会二次确认，并选择 KubeSphere 环境与执行 curl 的 Pod。

默认集群内调用地址：

```text
http://tax-api-proxy-server.tax-digital.svc.cluster.local:8080/leqi/proxy/invoke
```

## 本地开发

```bash
cargo test
cargo build --release
target/release/workctl --version
target/release/workctl
```

安装脚本语法检查：

```bash
bash -n install.sh
```
