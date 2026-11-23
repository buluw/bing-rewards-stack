# 给 agent 的部署说明

## 可直接交给 agent 的提示词

> 将 `https://github.com/buluw/bing-rewards-stack` 部署到我指定的 Linux Docker 主机。先读仓库 AGENTS.md 和 docs/AGENT_DEPLOY.md。使用已有授权连接方式，凭据只留目标机受限文件。新安装时生成随机面板密码和 API_TOKEN，使用 Compose 内部后端连接、真实 DNS、持久化目录及唯一面板计划。完成构建和无任务健康验收，向我报告访问地址、版本和回滚方法。不要启动真实积分任务或启用计划；账号资料从我指定的安全来源读取，不在聊天中索要或回显密码。已有部署先核对 idle、计划和备份，不能覆盖会话或历史。

## 1. 确认部署目标

记录主机、部署目录、架构、Docker／Compose 版本、当前容器和端口占用。命令包括 `uname -m`、`docker version`、`docker compose version`、`docker ps`。当前打包镜像为 `linux/amd64`；ARM 主机需自行构建并验证原生依赖与浏览器，不能声称已经验证。

建议目录 `/opt/bing-rewards-stack`。这是示例路径，不能根据目录名猜测生产角色。对已有实例只读采集镜像 ID、挂载目录、后端状态、计划状态和数据文件清单；不输出完整 `docker inspect` 环境变量。

## 2. 获取指定版本

```bash
git clone https://github.com/buluw/bing-rewards-stack.git /opt/bing-rewards-stack
cd /opt/bing-rewards-stack
git rev-parse HEAD
bash scripts/init.sh
```

私有仓库使用既有 GitHub 登录或 deploy key。令牌不能放在 Git URL 或命令行里。部署固定提交／Release，不在之后的步骤中自动 `git pull`。

## 3. 配置秘密和网络

- 通过安全来源编辑 `.env`；不能在 CI 中填真实账号。文件权限为 `0600`，目录限部署用户访问。
- API_TOKEN 同时供后端和面板使用，Compose 自动映射成 `CONTROL_API_TOKEN`。面板登录凭据是另一套，不要混用。
- 根据用户要求填一个或多个 `ACCOUNT_N_*`，默认 CN／zh-CN；无密码登录可能需要本人确认。没有凭据时仍可做无账号服务验收，明确记录“未配置账号”。
- `DASHBOARD_BIND` 默认 `127.0.0.1`，优先 SSH 转发；如授权局域网访问，设为目标机真实局域网地址。后端不映射宿主机端口。
- 确认业务 DNS 返回真实地址，并核对目标网络的真实出口。构建下载代理与业务账号代理分开，不能把宿主机代理变量随意灌入业务容器。
- 首次计划关闭；保留 `RUN_ON_START=false`，后端 `CRON_SCHEDULE` 为空。迁移时额外读取是否存在 `config/schedule.json`；存在启用的后端计划时先核对停用方案，不能以空环境变量推断它已停用。

`init.sh` 不覆盖现有配置，旧 `.env` 缺新字段时需要人工合并。

## 4. 已有实例先备份

按照 [OPERATIONS.md](OPERATIONS.md) 记录并执行备份。至少覆盖 `.env`、Compose、配置、会话、浏览器数据、后端数据、日志、面板 SQLite，以及旧镜像标签／ID。活跃 SQLite 不能直接复制主文件当成一致性备份。

写下：目标、备份路径、准确命令、预期短暂中断、验证项和回滚命令。确认 idle 后才能重建；发现 running／starting／stopping 时等待，不强停。

## 5. 构建或加载镜像

源码方式：

```bash
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout 180
```

Release 镜像方式：先验证 `SHA256SUMS`，`gzip -dc ... | docker load`，保持 `.env` 的 `STACK_VERSION=local`，再 `docker compose up -d --no-build --wait --wait-timeout 180`。若改为固定标签，请给两个镜像同时打对应标签并更新 `STACK_VERSION`。

本包只替换程序，不包含旧数据迁移。旧环境要保留六个 bind mount 的实际内容和 `.env`；名称相同不代表数据目录相同。

## 6. 验收（不启动真实任务）

执行 `bash scripts/check.sh`，并确认：

1. 两服务运行、health 为 healthy，没有持续重启。
2. 后端 `/health` 为 `ok:true`，`/status.state` 为 `idle`。
3. 面板 `/api/health` 的 `ok`、`controlApi`、`controlApiAuthOk`、`streamConnected` 全部为 true；刚启动时可等一次 5 秒轮询后复查。
4. 不带鉴权访问面板应为 401；从容器网络访问带令牌的后端正常，错令牌为 401。后端无宿主机发布端口。
5. 首次安装面板 `/api/schedule` 的 `local.enabled` 为 false，后端计划未启用。迁移则对照备份确认原计划与唯一性；定时开启需用户已授权。
6. 账号数量与用户提供数量一致，会话和历史在重建前后保持（迁移场景）。只记录数量和脱敏摘要。

CI 另有无网络页面的 Chromium／impit 冒烟验证。健康成功只代表程序能运行，不代表微软已为账号发积分。不要点击“开始”、调用 `/start` 或 `/balance` 来完成这一步。

## 7. 可选：用户已授权运行和计划

首次登录先运行单账号并观察；遇到 Authenticator／验证码交给用户本人确认。不要反复重试导致重复任务。手动启动超时结果不明时先读状态，不盲目再次提交。

用户授权每日计划后，在面板本地计划启用 `0 9 * * *`，时区 `Asia/Shanghai`，`skipIfRunning=true`、`misfirePolicy=skip`。API 为 `PUT /api/schedule`，JSON 示例：

```json
{"target":"local","enabled":true,"cron":"0 9 * * *","skipIfRunning":true,"misfirePolicy":"skip","excludedAccountIndexes":[]}
```

不要同时启用后端远程计划或宿主机 cron。主计划的失败账号补跑由面板自动管理，每天最多两次、分别等 2／5 分钟，不另建循环任务。

## 8. 交付

报告部署目录、提交 SHA、两镜像 ID、访问方式、健康／计划状态、是否执行真实任务，以及备份和准确回滚命令。不要把自动生成密码直接贴到报告中，告诉用户秘密保存在目标机 `.env`。
