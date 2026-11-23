# 必应积分双容器套件

把 Microsoft Rewards 后端和中文管理面板放在同一个仓库，用一份 Docker Compose 部署。后端负责运行任务，面板负责查看积分、管理配置和安排每天的运行时间。

本仓库是个人维护整合版，包含截至 **2026-11-23** 的本地修复，源码与 Dockerfile 均可直接构建。仓库不包含任何真实账号、密码、Cookie、登录会话或积分历史。

## 包含什么

| 服务 | 用途 | 端口 |
| --- | --- | --- |
| `ms-rewards` | TypeScript 后端、浏览器任务和 Control API | `3010`，仅容器网络内部 |
| `rewards-dashboard` | 中文面板、SQLite 历史和定时任务 | 默认 `127.0.0.1:8890` |

保留的修复包括：单账号失败正确上报、桌面初始化重试、邮箱大小写统一、读文积分去重、默认搜索打卡、Edge 浏览、初始化回滚、Patchright TLS 空证书保护，以及搜索额度查询超时重读和“未完成不能报成功”。面板保留每天最多两次、间隔 2／5 分钟的失败账号补跑。

## 快速部署

建议使用 **Linux x86_64、Docker Engine 和 Docker Compose v2**，准备 Bash、Git、OpenSSL。初次构建需要访问 Docker Hub、Debian 软件源、npm 和 Chromium 下载站；浏览器运行时也需要足够的内存。已验证的平台以 [验证记录](docs/VALIDATION.md) 为准。

```bash
git clone https://github.com/buluw/bing-rewards-stack.git
cd bing-rewards-stack
bash scripts/init.sh
```

私有仓库需先登录有权限的 GitHub 账号，也可以使用 `gh repo clone buluw/bing-rewards-stack`。

用编辑器打开 `.env`，填入你自己的 `ACCOUNT_1_EMAIL` 和密码。需要第二个账号时，复制相同字段并把编号改为 `2`。无密码账号可留空密码，首次运行时按页面或日志提示在 Authenticator 中确认登录。`.env` 中的密码若含 `$`、`#` 等字符，使用单引号包住整个值；不要把文件当成 shell 脚本 `source`。

初始化脚本自动生成面板密码和 API 令牌，重复执行会保留已有文件。面板登录名默认 `admin`，密码在本机 `.env` 的 `DASHBOARD_PASSWORD` 中。

```bash
docker compose config --quiet
docker compose build
docker compose up -d --wait --wait-timeout 180
bash scripts/check.sh
```

本机浏览器打开 <http://127.0.0.1:8890>。如果装在服务器上，可使用 SSH 转发：

```bash
ssh -L 8890:127.0.0.1:8890 your-user@your-server
```

如需局域网访问，在 `.env` 中把 `DASHBOARD_BIND` 改为服务器的局域网地址，再执行 `docker compose up -d`。公网访问应放在 HTTPS 反向代理后；面板 Basic Auth 本身不加密 HTTP 连接。

**启动容器不会自动搜索。** 首次部署的定时任务默认关闭。先核对账号和配置，再手动运行一个账号完成登录和验证。随后在面板“计划任务”中启用本地计划，例如 `0 9 * * *`，即 `Asia/Shanghai` 时区每天 09:00。只使用面板这一套主计划，不再添加宿主机 cron 或后端计划。

## 配置和数据放在哪里

| 路径 | 内容 | 是否需要备份 |
| --- | --- | --- |
| `.env` | 账号、API 令牌、面板登录信息 | 是，秘密文件 |
| `config/` | `config.json` 和可能存在的后端计划文件 | 是 |
| `sessions/`、`browser_data/` | 登录会话和浏览器数据 | 是，秘密文件 |
| `dashboard-data/` | SQLite 积分历史、运行记录和面板计划 | 是 |
| `data/`、`logs/` | 后端运行数据和日志 | 建议备份，可能有敏感信息 |

首次配置来源是 `backend/config.example.json`。高级选项可在面板“配置”或本机 `config/config.json` 中调整。修改 `.env` 后需 `docker compose up -d` 重新创建受影响容器；正在运行任务时先等待结束。

默认使用真实国内 DNS `223.5.5.5`、`119.29.29.29`，不注入业务代理。请按实际部署地区修改 `DNS_PRIMARY`、`DNS_SECONDARY`、`GEO_LOCALE` 和 `LANG_CODE`。拿到 `198.18.x.x` 这种 fake-IP 却没有走对应代理的容器通常会超时。

## 日常维护

```bash
docker compose ps
bash scripts/check.sh
docker compose logs --tail 100 ms-rewards rewards-dashboard
```

日志可能出现账号和登录信息，分享前先脱敏。检查脚本只访问本地健康和状态接口，不启动任务，也不查询微软账号余额。

更新、备份、恢复和回滚见 [运维文档](docs/OPERATIONS.md)。面向自动化 agent 的完整步骤、验收标准和可复制提示词见 [agent 部署文档](docs/AGENT_DEPLOY.md)，agent 入口是 [AGENTS.md](AGENTS.md)。

## 打包镜像

GitHub Actions 会运行离线回归、从零构建两个 Linux 镜像，并进行无账号启动及浏览器检查。在 Actions 手动运行 `Verify stack`、填写 `release_tag`（例如 `v2026.11.23`），验证成功后会把双镜像压缩包和 SHA-256 校验文件发布到仓库 Release。

下载同一版本的源码和镜像包后，在源码根目录执行：

```bash
sha256sum -c SHA256SUMS
gzip -dc bing-rewards-images-linux-amd64.tar.gz | docker load
bash scripts/init.sh
# 编辑 .env 填写你自己的账号；Release 镜像使用 local 标签。
docker compose up -d --no-build --wait --wait-timeout 180
```

镜像包只包含程序和浏览器，不包含部署数据。源码构建路径始终可用。

## 来源和许可

后端基于 [chiihero/Microsoft-Rewards-Script](https://github.com/chiihero/Microsoft-Rewards-Script)；面板基于 [mgrimace/rewards-dashboard](https://github.com/mgrimace/rewards-dashboard)。保留原作者版权与许可证，详见 [THIRD_PARTY.md](THIRD_PARTY.md)。本地修复和发布边界见 [变更记录](CHANGELOG.md)。
