# 备份、更新与回滚

## 备份

以下为已授权维护窗口中的冷备份方式，会短暂停止这两个服务。先从面板确认任务空闲、记录当前计划并关闭面板计划，确认后端无启用计划；在操作期间保持计划关闭。停止前再次查询后端 `/status.state` 为 `idle`。不要在任务运行中直接执行这些命令。

```bash
cd /opt/bing-rewards-stack
umask 077
stamp=$(date +%Y%m%d-%H%M%S)
backup_dir="$(pwd)/backups/$stamp"
mkdir -p "$backup_dir"
git rev-parse HEAD > "$backup_dir/commit.txt"
docker compose images --format json > "$backup_dir/images.json"
# 保留旧镜像，避免新构建覆盖 local 标签后无法回退。
docker image tag "bing-rewards-backend:$(sed -n 's/^STACK_VERSION=//p' .env)" "bing-rewards-backend:rollback-$stamp"
docker image tag "bing-rewards-dashboard:$(sed -n 's/^STACK_VERSION=//p' .env)" "bing-rewards-dashboard:rollback-$stamp"
docker compose stop rewards-dashboard ms-rewards
tar -czf "$backup_dir/state.tar.gz" .env compose.yaml config data logs browser_data sessions dashboard-data
sha256sum "$backup_dir/state.tar.gz" > "$backup_dir/SHA256SUMS"
docker compose start ms-rewards rewards-dashboard
```

示例要求 `.env` 中 `STACK_VERSION` 是不加引号的显式标签，默认初始化值为 `local`；自定义镜像名时先按实际镜像 ID 调整打标签命令，不猜测。冷备份完成后恢复之前记录的面板计划并核对下一次触发时间，避免重复启动。备份包有完整秘密，权限应为 `0600`，不要上传 GitHub。

需要不停服备份时，对每个实际存在的 SQLite 数据库使用 SQLite Backup API 或 `VACUUM INTO` 生成一致性副本，再打包配置和会话；不能只复制活跃 `.sqlite` 而忽略 WAL。先核对当前版本的数据库路径，不依赖猜测。

## 更新

1. 记录提交和旧镜像 ID，完成备份并确认任务仍空闲。
2. 更新到指定提交，阅读 CHANGELOG；保留 `.env` 和所有持久化目录。
3. 先构建，成功后才重建；使用 `docker compose build`、`docker compose up -d --wait --wait-timeout 180`。
4. 执行 `bash scripts/check.sh`。检查账号数量、会话、历史和计划保持，再恢复之前计划。

不要用 Watchtower 自动替换本套件；Compose 已禁用其自动更新标签。不要执行 `docker compose down -v`、清空会话或删除数据库。

## 程序回滚

如果新程序健康检查失败，使用备份时的准确时间戳。确认没有真实任务运行，然后把 `.env` 的 `STACK_VERSION` 改为 `rollback-<时间戳>`，执行：

```bash
docker compose up -d --no-build --wait --wait-timeout 180
bash scripts/check.sh
```

先回退程序，保留当前业务数据。若涉及不兼容的数据结构，另外制定数据恢复方案；不能自动用旧备份覆盖更新后产生的积分历史。

需要完整灾难恢复时，先停止两个服务，把现有数据另行备份，再在独立目录解压受限备份包、恢复匹配的旧源码／镜像后启动。启动前核对原计划，避免恢复出来的计划立刻触发任务。

## 常见问题

| 现象 | 检查 |
| --- | --- |
| 面板提示后端无法访问 | 两容器是否在同一 Compose 网络；`CONTROL_API_URL` 是否为 `http://ms-rewards:3010` |
| 401 | 面板登录凭据与 API_TOKEN 是不同层；不要把两者混用 |
| 配置显示星号 | 默认禁止 reveal；面板按字段 PATCH，不应把脱敏值覆盖真实秘密 |
| 登录或搜索超时 | DNS 是否真实地址、业务出口是否符合账号地区、是否需要本人登录确认 |
| 改了 .env 没生效 | 等任务结束后 `docker compose up -d`，单纯 restart 不会重新载入环境变量 |
| 重启后定时重复触发 | 检查面板计划、`config/schedule.json` 和宿主机 cron，确保只有面板主计划 |
| 微软仍不发满积分 | 查看官方额度和明确失败原因；健康通过不能保证账号获得积分 |
