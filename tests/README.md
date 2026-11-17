# 结果页回归

无需服务即可检查模板的中文语言声明、唯一 main/h1、main 内的三项计数绑定，以及原有标题和脚本入口：

```sh
node --test tests/test_page_semantics.js
```

既有接口与功能回归沿用隔离 PostgreSQL。测试会清空和准备自己的测试表，禁止连接共享或生产数据库：

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:45432/postgres node tests/test_api_results.js
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:45432/postgres node tests/test_regression_features.js
```

浏览器回归入口位于 vote 仓 `tests/browser_semantics.py`，启动和变量说明见该仓 `tests/README.md`。它用真实页面和 scores 推送检查 main、可见 h1、两项计数和总票数，并保存桌面/移动端截图及无障碍树。该脚本使用隔离数据库夹具，不代替真实部署的 worker 计票验收。
