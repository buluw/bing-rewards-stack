# Agent 工作入口

- 面向用户使用简体中文和简单说明。
- 部署前阅读 `README.md`、`docs/AGENT_DEPLOY.md` 和 `docs/OPERATIONS.md`。
- 用户要求部署服务时，可完成所指定目标上的构建和启动；单独启动真实积分任务、领取奖励或启用定时计划，需要用户已授权该操作。
- `.env`、账号、Cookie、会话、数据库及日志不提交 Git，不显示在聊天、CI 输出或 Issue 中。不要执行会展开凭据的 `docker compose config`；使用 `docker compose config --quiet`。
- 新部署不继承维护者的 IP、账号或网关配置。默认保持 `RUN_ON_START=false`，后端无 cron，面板计划关闭。
- 只用面板本地计划作为主调度器。迁移已有环境时，检查 `config/schedule.json`，它会覆盖后端 `CRON_SCHEDULE`；先停用旧重复计划并备份，不静默覆盖。
- 修改已有服务前核对任务 idle、计划和数据目录，先完成受限备份与可执行回滚记录。不得删除卷、会话或历史来“修复”。
- 健康检查仅访问本地 `/health`、`/status`、`/api/health`。不要把真实搜索或余额查询当成部署验收。
- 验证后端：`cd backend && npm ci --ignore-scripts && npm run test:rewards-fixes`；验证面板：`cd dashboard && npm test`。Node.js 使用 24。
- Dockerfile 必须能从公开 Node 基础镜像构建，不能依赖维护者本机旧镜像。保留 lockfile 与 Patchright 1.61.1 的版本检查。
- 完成后报告提交 SHA、镜像标签／ID、健康结果、计划状态、备份及回滚位置、真实任务是否执行。无法完成的检查要明确标出。
