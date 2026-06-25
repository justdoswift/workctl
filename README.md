# workctl

日常工作工具集 CLI。当前支持在本机终端登录 KubeSphere Console，加载 namespace、工作负载、Pod 和容器，然后下载 Kubernetes 当前保留的容器日志，或通过 exec 从 `/opt/saas-logs` 抽取历史日志。

## 一行安装

```bash
curl -fsSL https://raw.githubusercontent.com/justdoswift/workctl/main/install-node.sh | bash
```

默认安装到：

```text
~/.workctl/cli
~/.workctl/bin/workctl
```

如果安装后终端找不到 `workctl`，把下面这行加入 `~/.zshrc`：

```bash
export PATH="$HOME/.workctl/bin:$PATH"
```

验证安装：

```bash
workctl --version
workctl --help
```

自定义安装目录：

```bash
curl -fsSL https://raw.githubusercontent.com/justdoswift/workctl/main/install-node.sh | \
  WORKCTL_INSTALL_DIR="$HOME/.local/share/workctl" \
  WORKCTL_BIN_DIR="$HOME/.local/bin" \
  WORKCTL_REF="main" \
  bash
```

升级：

```bash
curl -fsSL https://raw.githubusercontent.com/justdoswift/workctl/main/install-node.sh | bash
```

卸载程序文件：

```bash
rm -rf ~/.workctl/cli ~/.workctl/bin/workctl
```

卸载不会删除 `~/.workctl/profiles.json`，避免误删已保存的环境账号。

从旧版 `kslog` 升级时，安装脚本会删除旧程序文件 `~/.kslog/cli` 和 `~/.kslog/bin/kslog`，但不会删除 `~/.kslog/profiles.json`。首次读取配置时，如果 `~/.workctl/profiles.json` 不存在，会自动从旧 profile 复制迁移。

## 本地开发

```bash
npm install
npm run build
```

开发运行：

```bash
npm run dev
```

构建后运行：

```bash
node dist/cli.js
```

注册成全局命令：

```bash
npm link
workctl --help
```

取消全局命令：

```bash
npm unlink -g workctl
```

## 使用

完整交互流程：

```bash
workctl
```

启动后会先选择功能：

- K8s 日志
- 乐企接口

进入 K8s 日志时，会选择已保存环境，或者选择“新增环境”。新增环境需要填写 `name/url/username/password`，登录成功后会自动保存并设为默认环境。

验证登录：

```bash
workctl login-check --url http://192.168.7.191:30880 --username admin
```

下载指定工作负载日志：

```bash
workctl download \
  --url http://192.168.7.191:30880 \
  --username admin \
  --namespace tax-digital \
  --workload tax-invoice-business-server
```

如果不传 `--namespace`，交互列表会默认选中 `tax-digital`。如果不传 `--workload`，会直接展示全部工作负载供选择。旧参数 `--service` 仍可使用，会按工作负载名称处理。

下载当前容器日志：

```bash
workctl current \
  --url http://192.168.7.191:30880 \
  --username admin \
  --namespace tax-digital \
  --workload tax-invoice-business-server \
  --tail-lines 1000
```

下载历史日志，按日志内容日期抽取匹配行：

```bash
workctl history \
  --url http://192.168.7.191:30880 \
  --username admin \
  --namespace tax-digital \
  --workload tax-invoice-business-server \
  --date 2026-06-24
```

如果已知远端历史日志文件，可以直接指定，避免进入多选：

```bash
workctl history \
  --url http://192.168.7.191:30880 \
  --username admin \
  --namespace tax-digital \
  --workload tax-invoice-business-server \
  --date 2026-06-24 \
  --history-file /opt/saas-logs/tax-invoice-business-server-xxx.log
```

## 乐企接口

进入乐企接口工具：

```bash
workctl leqi
```

接口列表使用内置快照，来源是 `lxzsdb.tax_leqi_api_info` 中当前启用的 131 条接口。运行时不会连接 MySQL，也不会询问接口库密码；如果接口表有变化，更新快照并发布新版本即可。

选择接口后会填写 `taxPayerNo/testMode/reqDTO`，默认操作是导出可复制 curl。`reqDTO` 会优先使用随包内置的乐企能力文档模板，并显示文档文件、章节和字段统计；没有模板时才回退为 `{}`。导出的 curl 会使用格式化 JSON，并自动复制到系统剪切板。也可以直达：

```bash
workctl leqi \
  --api 200000001 \
  --tax-payer-no 91150100397352740W \
  --req-dto '{"ptbh":"1fc4107f168694d1efb5","nsrsbh":"91150100397352740W","sqlx":"1","sqed":20000000}' \
  --action curl
```

在源码仓库内重新抽取本机 Word 文档里的 `reqDTO` 模板：

```bash
npm run generate:leqi-templates
```

如果选择直接调用，工具会登录 KubeSphere，并默认进入 `tax-digital` 下的 `tax-api-proxy-server` Pod 执行集群内 curl。可用参数覆盖：

```bash
workctl leqi \
  --api 200000001 \
  --tax-payer-no 91150100397352740W \
  --req-dto '{"sqed":20000000}' \
  --action call \
  --profile 仿真环境 \
  --namespace tax-digital \
  --runner-workload tax-api-proxy-server
```

## Redis 工具

进入 Redis 工具：

```bash
workctl redis
```

Redis 工具会登录 KubeSphere，自动查找可见 namespace 中的 Redis 工作负载，优先进入 `kubesphere-system / redis`，然后在 Redis Pod 内直接执行 `redis-cli`。这和你在 KubeSphere 终端里输入 `redis-cli` 是同一个思路：默认不再询问 host、port、db。

Redis 密码会保存到当前 KubeSphere 环境 profile 的 `redisPassword` 字段，后续进入同一个环境会自动复用，不再重复输入。配置文件仍是 `~/.workctl/profiles.json`，权限为 `0600`。

如果你确实要从其它 Pod 访问 Redis，也可以手动指定工作负载，并用 `--redis-host/--redis-port/--redis-db/--redis-password` 覆盖连接参数；传入 `--redis-password` 且使用已保存环境时，也会同步写入当前 profile。

第一版不会创建临时工具 Pod；如果 Redis 容器没有 `redis-cli`，会提示你切换到带工具的 Pod/容器。

支持的操作包括 `PING`、`INFO`、`GET key`、`SCAN pattern` 和自定义命令。自定义命令如果包含常见写操作（如 `DEL`、`SET`、`HSET`、`EXPIRE`、`FLUSHDB`）会要求二次确认。

也可以直达：

```bash
workctl redis \
  --profile 测试环境 \
  --namespace kubesphere-system \
  --workload redis \
  --redis-action get \
  --key tax:invoice:demo
```

保存环境配置：

```bash
workctl profile add
workctl profile list
workctl profile use 测试环境
workctl --profile 测试环境
```

环境配置保存到：

```text
~/.workctl/profiles.json
```

按需求，`name/url/username/password` 会明文保存到这个 JSON 文件中，文件权限会设置为 `0600`。

下载时会显示进度信息。当前容器日志接口通常没有总大小，所以显示已下载大小、速度和耗时；历史日志会优先读取源文件大小，并显示已处理大小、总大小、速度和耗时。

默认保存到：

```text
~/Downloads/workctl/kubesphere-logs
```

不使用 `profile add` 时，密码、token、refreshToken 都只保存在当前进程内存里。
