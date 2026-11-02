# 七卡 G：独立运行信息接口验收

卡：`fa18bbf1d51f43a29cf7bfc33e169bca`；执行：`0e1e7d0b80274079a3880ffa162b511f`。
需求版本：`b135a204392848a094993415b22b4f65`，delivery_round=1，baseline_epoch=1。

仅修改 result。精确基线为 `65b9eccdddff2c1e938259e60ffb175c52458294`，PR 目标为 `codex/arena-seven-20261103-latest`，开发分支为 `codex/fa18bbf1-result-runtime`。没有修改实际 main、共享候选、其他仓库或平台配置；不依赖新增追踪链路。固定输入的 required_checks 为空，以下为需求所需的实际行为验证。

## 行为

`GET /api/arena/seven-20261103/runtime` 直接返回 `service: "result"`、`process.versions.node` 和 `process.uptime()`，设置 `Cache-Control: no-store`。处理函数没有数据库调用，不等待连接、迁移或查询。原有数据库连接、广播、结果读取及 healthz 逻辑保持原样。

## 复现

需要 Node.js、锁定依赖和 PostgreSQL 原生工具（`pg_config`、`initdb`、`pg_ctl`，可用 `PG_BINDIR` 指定工具目录）。以非 root 用户运行：

```sh
npm ci --no-audit --no-fund
RUNTIME_EVIDENCE_DIR="$PWD/runtime-evidence" npm run test:runtime
```

测试自行创建唯一目录、独占 PostgreSQL 数据目录和随机 loopback 端口。故障测试不接受外部数据库 URL；只对本次创建的 dataDir 执行 pg_ctl。测试结束停止自己启动的服务、TCP 夹具和数据库，移除临时数据库文件，保存命令输出、进程信息、HTTP 请求/响应及 PostgreSQL 日志。

## 实际执行结果

2026-11-03（Asia/Shanghai），Node `24.15.0`，PostgreSQL `17.11`。执行命令：

```sh
RUNTIME_EVIDENCE_DIR="$PWD/evidence/fa18bbf1-runtime" npm --prefix cards/fa18bbf1-result run test:runtime
```

退出码 0。新增真实 HTTP 测试 7/7，通过且无跳过；其中执行原有结果 API 自测、原有真实 PostgreSQL 汇总测试 15/15（无跳过），以及完整 regression feature 自测，退出码均为 0。独占夹具为 `result-runtime-owned-i5GQGt`，数据库端口 `52857`，归属记录和完整路径见 evidence.json。

同一 result PID `92143`，HTTP 端口 `52859`：

| 场景 | runtime | healthz | 证据 |
| --- | --- | --- | --- |
| 停库前 | 200 | 200 | node_version=24.15.0，uptime_seconds=0.132838667 |
| 同进程连续五次 | 全部 200 | — | uptime 从 0.134653417 增至 0.248245625 |
| pg_ctl 停独占库后 | 200 | 503 | uptime_seconds=0.403740417，runtime 实际约 1.103ms；结果 API 503 |
| 恢复独占库后 | 200 | 200 | uptime_seconds=0.540671542；首页、结果 API、三种汇总与 Socket.IO 握手保持正常 |

另外，数据库已停时冷启动新 result PID `92165`，runtime 仍 200，约 3.608ms，healthz 503。独占 TCP 夹具接受连接但不完成 PostgreSQL 握手时，新 result PID `92176` 的 runtime 仍 200，约 3.340ms；请求设定 1000ms 上限，短于服务的数据库连接超时 2000ms。三个场景的 runtime Node 版本均与启动子进程使用的实际 Node 可执行文件版本一致。

原始材料：

- [test-output.log](test-output.log)：实际测试命令输出。
- [evidence.json](evidence.json)：完整命令及退出码、旧测试输出、进程 PID/可执行文件、HTTP 方法/URL/状态/头/原始响应体/耗时，以及服务日志。
- [postgres.log](postgres.log)：独占数据库启动、停机、恢复和 SQL 日志。

夹具数据库已停止，数据目录已删除，所启动 result 进程及 TCP 监听均已回收。本轮为 DEVELOP；后续精确基线同步和批次接纳由平台按流程调度，不宣称已经执行 SYNC_MAIN、合入或部署。
