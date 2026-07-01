# bosscli

日常工作工具集 CLI。当前支持在本机终端登录 KubeSphere Console，加载 namespace、工作负载、Pod 和容器，然后下载 Kubernetes 当前保留的容器日志，或通过 exec 从 `/opt/saas-logs` 抽取历史日志。

## 一行安装

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/justdoswift/bosscli@main/install-node.sh | bash
```

备用 GitHub raw 地址：

```bash
curl -fsSL https://raw.githubusercontent.com/justdoswift/bosscli/main/install-node.sh | bash
```

默认安装到：

```text
~/.bosscli/cli
~/.bosscli/bin/bosscli
```

如果安装后终端找不到 `bosscli`，把下面这行加入 `~/.zshrc`：

```bash
export PATH="$HOME/.bosscli/bin:$PATH"
```

验证安装：

```bash
bosscli --version
bosscli --help
```

自定义安装目录：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/justdoswift/bosscli@main/install-node.sh | \
  BOSSCLI_INSTALL_DIR="$HOME/.local/share/bosscli" \
  BOSSCLI_BIN_DIR="$HOME/.local/bin" \
  BOSSCLI_REF="main" \
  bash
```

升级：

```bash
curl -fsSL https://cdn.jsdelivr.net/gh/justdoswift/bosscli@main/install-node.sh | bash
```

卸载程序文件：

```bash
rm -rf ~/.bosscli/cli ~/.bosscli/bin/bosscli
```

卸载不会删除 `~/.bosscli/profiles.json`，避免误删已保存的环境账号。

从旧版 `workctl` 或 `kslog` 升级时，安装脚本会删除旧程序文件 `~/.workctl/cli`、`~/.workctl/bin/workctl`、`~/.kslog/cli` 和 `~/.kslog/bin/kslog`，但不会删除旧 profile。首次读取配置时，如果 `~/.bosscli/profiles.json` 不存在，会优先从 `~/.workctl/profiles.json` 复制迁移；如果不存在，再从 `~/.kslog/profiles.json` 复制迁移。

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
bosscli --help
```

取消全局命令：

```bash
npm unlink -g bosscli
```

## 使用

完整交互流程：

```bash
bosscli
```

启动后会先选择功能：

- k8s
- 乐企 curl
- 乐享
- 乐企 SM4
- Get Hash Code
- Redis
- MySQL 备份
- 依赖获取
- 中间库 mock
- 文件共享
- 退出

裸 `bosscli` 的交互模式会在每个功能执行完成后回到功能选择菜单；选择 `退出` 才会结束程序。子命令直达模式仍然执行一次后退出，方便脚本使用。

选择 `中间库 mock` 会直接用系统默认浏览器打开 [https://silken-cliff-6z59.here.now/](https://silken-cliff-6z59.here.now/)。

选择 `乐企 SM4` 会直接用系统默认浏览器打开 [https://snowy-tangle-qfja.here.now/](https://snowy-tangle-qfja.here.now/)。

选择 `Get Hash Code` 会直接用系统默认浏览器打开 [https://deep-garnet-bma5.here.now/](https://deep-garnet-bma5.here.now/)。

选择 `文件共享` 会直接用系统默认浏览器打开 [https://wormhole.app/](https://wormhole.app/)。

进入 `k8s` 时，会选择已保存环境，或者选择“新增环境”。新增环境需要填写 `name/url/username/password`，登录成功后会自动保存并设为默认环境。

验证登录：

```bash
bosscli login-check --url http://192.168.7.191:30880 --username admin
```

下载指定工作负载日志：

```bash
bosscli download \
  --url http://192.168.7.191:30880 \
  --username admin \
  --namespace tax-digital \
  --workload tax-invoice-business-server
```

如果不传 `--namespace`，交互列表会默认选中 `tax-digital`。如果不传 `--workload`，会直接展示全部工作负载供选择。旧参数 `--service` 仍可使用，会按工作负载名称处理。

下载当前容器日志：

```bash
bosscli current \
  --url http://192.168.7.191:30880 \
  --username admin \
  --namespace tax-digital \
  --workload tax-invoice-business-server \
  --tail-lines 1000
```

下载历史日志，按日志内容日期抽取匹配行：

```bash
bosscli history \
  --url http://192.168.7.191:30880 \
  --username admin \
  --namespace tax-digital \
  --workload tax-invoice-business-server \
  --date 2026-06-24
```

如果已知远端历史日志文件，可以直接指定，避免进入多选：

```bash
bosscli history \
  --url http://192.168.7.191:30880 \
  --username admin \
  --namespace tax-digital \
  --workload tax-invoice-business-server \
  --date 2026-06-24 \
  --history-file /opt/saas-logs/tax-invoice-business-server-xxx.log
```

## 乐享 curl

在首页选择 `乐享`，先选择 `通用` 或 `医疗`，再从对应文档的内置快照里选择接口并生成标准 REST curl。这个功能独立于 `乐企 curl`，不会使用 `apiIdentity/reqDTO/proxy invoke`。

- `通用`：来自《乐享协同数字化电子发票接口规范v1.0.62（销项）.docx》。
- `医疗`：来自《乐享协同数字化电子发票接口规范（医疗） v1.0.18.docx》。

第一次进入时会新增乐享环境，明文保存到 `~/.bosscli/lexiang-profiles.json`，权限为 `0600`。保存内容包括 `name/baseUrl/appid/appkey/taxPayerNo/version`，后续进入可直接选择环境。

生成 curl 时会把业务参数 JSON 做 UTF-8 Base64 作为 `data`，自动生成 `noise`，并按文档规则用 SM3 生成大写 `sign`。curl 会自动复制到系统剪切板。

业务参数步骤会先询问 `使用默认参数生成 curl` 或 `编辑业务参数 JSON`。生成完成后会留在乐享流程，可继续生成、切换通用/医疗、切换乐享环境、返回首页或退出；返回首页时默认高亮上次使用的功能，避免连续回车误进 `k8s`。

在源码仓库内重新抽取本机 Word 文档里的乐享接口快照：

```bash
npm run generate:lexiang-general
npm run generate:lexiang-medical
```

## 乐企接口

进入乐企接口工具：

```bash
bosscli leqi
```

接口列表使用内置快照，来源是 `lxzsdb.tax_leqi_api_info` 中当前启用的 131 条接口。运行时不会连接 MySQL，也不会询问接口库密码；如果接口表有变化，更新快照并发布新版本即可。

选择接口后会填写 `taxPayerNo/testMode/reqDTO`，默认操作是导出可复制 curl。`reqDTO` 会优先使用随包内置的乐企能力文档模板，并显示文档文件、章节和字段统计；没有模板时才回退为 `{}`。导出的 curl 会使用格式化 JSON，并自动复制到系统剪切板。也可以直达：

```bash
bosscli leqi \
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
bosscli leqi \
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
bosscli redis
```

Redis 工具会登录 KubeSphere，自动查找可见 namespace 中的 Redis 工作负载，优先进入 `kubesphere-system / redis`，然后在 Redis Pod 内执行 `redis-cli`。执行位置只是提供集群内终端和 `redis-cli`，真正连接的 Redis 地址来自当前环境 profile 的 `redisHost/redisPort/redisDb/redisPassword`。

第一次使用时会自动扫描可见 namespace 中名称包含 `redis` 的 Service，优先展示 `tax-component / redis`，选择后保存 Redis host、port、db 和密码。默认 host 是 `redis.tax-component`。这些配置会保存到当前 KubeSphere 环境 profile，后续进入同一个环境会自动复用，不再重复输入。配置文件仍是 `~/.bosscli/profiles.json`，权限为 `0600`。如果保存的密码认证失败，工具会提示重新输入并覆盖保存。

如果你确实要从其它 Pod 访问 Redis，也可以手动指定工作负载，并用 `--redis-host/--redis-port/--redis-db/--redis-password` 覆盖连接参数；传入 `--redis-password` 且使用已保存环境时，也会同步写入当前 profile。

第一版不会创建临时工具 Pod；如果 Redis 容器没有 `redis-cli`，会提示你切换到带工具的 Pod/容器。

支持的操作包括 `PING`、`INFO`、`GET key`、`SCAN pattern` 和自定义命令。自定义命令如果包含常见写操作（如 `DEL`、`SET`、`HSET`、`EXPIRE`、`FLUSHDB`）会要求二次确认。

交互模式下每次 Redis 命令执行完成后会回到 `选择 Redis 操作` 菜单，方便连续查询；可以选择 `切换 database` 在当前 Redis 连接中切换 DB，默认是 `0`，切换后会保存到当前 profile。选择 `返回上一级` 可离开 Redis 工具。命令行直达模式，例如传入 `--redis-action`，仍然执行一次后退出，方便脚本使用。

也可以直达：

```bash
bosscli redis \
  --profile 测试环境 \
  --namespace kubesphere-system \
  --workload redis \
  --redis-action get \
  --key tax:invoice:demo
```

## MySQL 备份

进入 MySQL 备份工具：

```bash
bosscli mysql-backup
```

MySQL 备份用于把同一 MySQL 实例里的 `source` 数据库复制到新的 `dest` 数据库。工具会使用本机 `mysql` 和 `mysqldump` 命令执行，不引入额外数据库驱动。第一次使用时会新增 MySQL 环境并明文保存到 `~/.bosscli/mysql-profiles.json`，权限为 `0600`。

如果本机缺少 `mysql` 或 `mysqldump`，macOS 上会提示是否自动执行 `brew install mysql-client`；安装完成后会继续当前备份。工具也会自动识别 Homebrew 的 `mysql-client` keg-only 路径，例如 `/opt/homebrew/opt/mysql-client/bin`。

如果 `dest` 数据库已经存在，工具会直接报错，不覆盖、不删除。备份时会优先显示表进度和耗时，例如 `MySQL 备份  表 307/3787  8%  已执行 3m07s`；下一行显示 `dump` 诊断信息，例如 `诊断：dump 1.1 MiB  dump速度 6.1KiB/s`。这里的速度是 `mysqldump` SQL 流速度，不等同于真实网络吞吐。

交互模式下 `dest` 会默认生成精确到分钟的数据库名，例如 `lxzsdb_bak_202606260948`，直接回车即可使用。

第一版复制表结构、数据、触发器和事件；暂不导出存储过程/函数，避免 MySQL 9 `mysqldump` 连接 MySQL 8 时触发 `INFORMATION_SCHEMA.LIBRARIES` 兼容错误。

也可以直达：

```bash
bosscli mysql-backup \
  --profile 开发数据库 \
  --source lxzsdb_bak \
  --dest lxzsdb_bak2
```

使用临时连接参数：

```bash
bosscli mysql-backup \
  --host 192.168.7.182 \
  --port 3306 \
  --username root \
  --source lxzsdb_bak \
  --dest lxzsdb_bak2
```

也可以用 `BOSSCLI_MYSQL_PASSWORD` 提供密码，避免把密码写在命令行参数里。

## 依赖获取

进入 Java 服务依赖获取工具：

```bash
bosscli deps
```

依赖获取会登录 KubeSphere，选择 namespace、工作负载、Pod 和容器后，从运行中的 Java 进程或常见目录中查找应用 jar。工具会把应用 jar 下载到本机，并在本机解析 `BOOT-INF/lib`、`WEB-INF/lib`、`lib` 中的依赖 jar，不依赖容器内安装 `jar` 或 `unzip`。

工作负载和应用 jar 选择支持直接输入关键字搜索，方便在服务较多时快速定位。

默认输出到：

```text
~/Downloads/bosscli/dependencies/<namespace>/<workload>/<timestamp>/
```

目录里会包含：

```text
app/<service>.jar
libs/*.jar
dependencies.txt
manifest.json
```

也可以直达：

```bash
bosscli deps \
  --profile 测试环境 \
  --namespace tax-digital \
  --workload tax-api-proxy-server \
  --jar-path /app/tax-api-proxy-server.jar
```

保存环境配置：

```bash
bosscli profile add
bosscli profile list
bosscli profile use 测试环境
bosscli --profile 测试环境
```

环境配置保存到：

```text
~/.bosscli/profiles.json
```

按需求，`name/url/username/password` 会明文保存到这个 JSON 文件中，文件权限会设置为 `0600`。

下载时会显示进度信息。当前容器日志接口通常没有总大小，所以显示已下载大小、速度和耗时；历史日志会优先读取源文件大小，并显示已处理大小、总大小、速度和耗时。

默认保存到：

```text
~/Downloads/bosscli/kubesphere-logs
```

不使用 `profile add` 时，密码、token、refreshToken 都只保存在当前进程内存里。
