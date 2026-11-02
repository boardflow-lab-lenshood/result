# 卡 G：baseline_epoch=3 同步验收

卡 `fa18bbf1d51f43a29cf7bfc33e169bca`；execution `b6f47d42a7614ae4a280423e4b05e9e0`；action=SYNC_MAIN；spec_revision=`b135a204392848a094993415b22b4f65`，delivery_round=1，baseline_epoch=3。

继续原会话56、分支 `codex/fa18bbf1-result-runtime`、已登记的 result worktree 和 [PR46](https://github.com/boardflow-lab-lenshood/result/pull/46)。本轮完整固定 target_main：

- result：`155679ec7983279ce683f259669df80bb2820060`
- vote：`c9c5fd496b85b67c0d50473266b44056a89a58d7`
- worker：`36d5f71fd38f9c194b0650fdd5268015e7377083`

只修改 result，vote/worker 无本卡改动。result 基线已由合并提交 `3a60d1c78fa7c2f77f5ea1500cc4f27896572805` 纳入；本轮开始 HEAD 为 `82f8d943332761649d8176f9a2c6287978275719`，`git merge-base --is-ancestor 155679ec7983279ce683f259669df80bb2820060 HEAD` 退出0，因此无需重复合并。相对本轮基线，生产代码仍只新增9行 runtime 路由；Dockerfile、追踪代码与追踪测试保持基线内容。保留基线完整 npm test 和 G 的 test:runtime。

## 本轮重新执行的验证

```sh
RUNTIME_EVIDENCE_DIR="$PWD/evidence/fa18bbf1-runtime-sync-epoch3" npm --prefix cards/fa18bbf1-result run test:runtime
```

退出0，runtime 7/7，0失败、0跳过。其中实际执行旧结果API、汇总15项与追踪42项共57/57（0跳过）、regression自测，子命令均退出0。Node `24.15.0`，PostgreSQL `17.11`。

独占夹具 `result-runtime-owned-fbAocO`，归属 result-runtime-test，自建initdb目录，数据库端口50766。停机恢复仅对本次夹具dataDir执行pg_ctl，未触及共享候选或其他卡。

- 同进程PID17574连续五次runtime均200，实际uptime从0.133749416增至0.245830833，Node版本与启动服务的实际可执行文件一致。
- 正常时runtime/healthz均200；停止独占数据库后runtime仍200（约1.380ms），healthz503、结果API503。
- 恢复数据库后runtime/healthz均200，首页、结果、三种汇总、Socket.IO握手兼容通过。
- 数据库已停止时冷启动PID17588，runtime200（约3.129ms）、healthz503。
- TCP接受连接但不完成PostgreSQL握手时PID17598，runtime200（约3.458ms）。这两个runtime请求均设1000ms限时，小于数据库连接超时2000ms。

夹具没有trace_id列，runtime正常、故障、冷启动测试均通过，未依赖追踪迁移。测试后PID17574/17588/17598均退出、数据库和服务端口不再监听、自建dataDir已删除、TCP夹具已关闭。固定development_context的required_checks为空，已完成上述需求行为和同步兼容自测。

原始证据：[test-output.log](test-output.log)、[evidence.json](evidence.json)、[postgres.log](postgres.log)、[provenance.json](provenance.json)。包含真实命令与退出码、HTTP方法/URL/头/状态/原始响应、进程/可执行文件、夹具归属、祖先链和清理核验。

本轮仅追加epoch3真实验收材料；此前epoch1/2证据保留作历史记录。本轮以epoch3 manifest为准。没有更新实际main、部署、手工组批或移动卡。
