# 卡 G：baseline_epoch=2 精确基线同步验收

卡 `fa18bbf1d51f43a29cf7bfc33e169bca`；本轮执行 `b7f1d529e5994f52906158cdade3f744`，action=SYNC_MAIN；spec_revision=`b135a204392848a094993415b22b4f65`，delivery_round=1，baseline_epoch=2。

继续原会话 56、原 worktree、分支 `codex/fa18bbf1-result-runtime` 和 PR https://github.com/boardflow-lab-lenshood/result/pull/46，目标仍为 `codex/arena-seven-20261103-latest`。只修改 result。本轮固定 result 基线 `155679ec7983279ce683f259669df80bb2820060` 已合入；合并提交 `3a60d1c78fa7c2f77f5ea1500cc4f27896572805` 的父提交依次为原交付 `9cde118a64ca0eab5fd2e6bb4b77fb6d77307762` 与本轮精确基线 `155679ec7983279ce683f259669df80bb2820060`。

## 合并与兼容

唯一内容冲突发生在 package.json 的 scripts：保留基线完整的 `test`（结果 API、汇总、追踪与 regression），并保留 G 的 `test:runtime`。runtime 自动验收同步扩展为执行基线汇总和追踪两套真实 HTTP/数据库测试，并断言两套均实际执行、零跳过。

相对本轮基线，server.js 仍只新增 9 行 runtime 路由；Dockerfile、追踪查询与追踪测试保持基线内容不变。runtime 的正常、停库、冷启动与握手等待验证继续在没有 trace_id 列的独占夹具中通过，证明 G 不依赖新增追踪列或迁移。

## 本轮实际验证

执行命令（岗位工作目录）：

```sh
RUNTIME_EVIDENCE_DIR="$PWD/evidence/fa18bbf1-runtime-sync-epoch2" npm --prefix cards/fa18bbf1-result run test:runtime
```

退出码 0，runtime 测试 7/7，无失败、无跳过；其内执行结果 API 自测、汇总 15 项与追踪 42 项合计 57/57（两套均执行，零跳过）、regression 自测，均退出码 0。实际 Node `24.15.0`、PostgreSQL `17.11`。原始输出保存在 test-output.log 和 evidence.json commands 中。

夹具 `result-runtime-owned-ThkUTs`，归属 result-runtime-test，独占 initdb 数据目录，数据库端口 `49536`。仅对本次夹具的 dataDir 执行 pg_ctl stop/start，未触及共享候选或其他环境。

同进程 result PID `14708`：

| 场景 | runtime | healthz | 原始回执重点 |
| --- | --- | --- | --- |
| 正常 | 200 | 200 | node_version=24.15.0，uptime_seconds=0.129344708 |
| 连续五次请求 | 全部 200 | — | uptime_seconds 从 0.131125708 增至 0.241606166 |
| 独占数据库停止 | 200 | 503 | runtime 约 1.398ms，uptime_seconds=0.396144666；结果 API 503 |
| 独占数据库恢复 | 200 | 200 | uptime_seconds=0.543227708；首页、结果、三种汇总、Socket.IO 正常 |

独占数据库已停时冷启动 PID `14722`：runtime 200（约 3.004ms），healthz 503。自建 TCP 数据库握手等待夹具、PID `14732`：runtime 200（约 3.177ms）。两者实际 HTTP 请求均设置 1000ms 上限，小于数据库连接超时 2000ms。

测试结束已核验三个 result PID 均退出，数据库/服务端口均不再监听，独占 dataDir 已删除，TCP 夹具已关闭。固定输入的 required_checks 为空；本轮已运行与同步改动相符的实际行为自测。没有部署、更新实际 main、手工组批或移动卡。

## 材料

- [test-output.log](test-output.log)：本轮真实命令输出。
- [evidence.json](evidence.json)：完整 HTTP 方法、URL、状态、头、响应体、耗时，Node/PID/可执行文件与旧测试输出。
- [postgres.log](postgres.log)：本轮自建独占数据库启停和 SQL 日志。
- [provenance.json](provenance.json)：固定上下文、合并父链、基线祖先检查、代码文件 SHA256、夹具回收核验。

本文件及邻接证据为 epoch 2 同步记录；上层 README 和原始证据保留 epoch 1 开发记录。本轮接纳以 epoch 2 manifest 为准，后续批次由平台 Loop 处理。
