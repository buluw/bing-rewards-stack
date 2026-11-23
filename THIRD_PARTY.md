# 来源与许可

| 组件 | 直接来源 | 导出时的上游基线 | 许可 |
| --- | --- | --- | --- |
| backend | https://github.com/chiihero/Microsoft-Rewards-Script | `823cc6624668573d203ad734afd09771a5467024` | GPL-3.0-or-later，见 backend/LICENSE |
| dashboard | https://github.com/mgrimace/rewards-dashboard | `352008f17d7ec8d1fcd3d1a3b3f818254b1a92c9` | MIT，见 dashboard/LICENSE |

上表是本地检出所基于的提交，不代表本仓库未经修改；本地修复一并保存在源码中，见 CHANGELOG.md。后端也保留 Netsky 等原作者声明，面板保留原 MIT 声明。原上游 README 保存在各组件的 README.upstream.md，仅供来源参考，部署以仓库根 README 为准。

本仓库新增的部署脚本、配置和文档按 GPL-3.0-or-later 发布，后端许可证全文同时作为根 LICENSE 保留。面板代码继续按其 MIT 许可。镜像中的 Node.js、Chromium、Patchright 和 npm 依赖仍遵守各自许可证，锁定依赖见 backend/package-lock.json。
