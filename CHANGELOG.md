# Changelog

本项目遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## 1.0.0 — 2026-11-04

首个公开版本。

### 功能

- 完整备份：本人歌单、我喜欢、收藏专辑、关注歌手，以及收藏他人歌单（仅备份）。
- 匹配引擎：多轮查询、歌手/专辑/时长加权、Live/Remix/DJ 等版本标签区分、替代版本审计。
- 交互式 `review`：逐项确认、跳过或采用推荐版本。
- 断点恢复：以“源歌单 ID + 曲目位置”为键，支持重复歌曲与中断重跑。
- 批量写入：默认每批 10 首并自动降级逐首重试；`--strict` 可切换为首错即停。
- `--dry-run` 演练，不连接 QQ、不写入。
- `verify`：只读读回 QQ 歌单，按唯一歌曲 ID 比对。
- `doctor` 环境自检；`status --json` 供脚本消费。
- 凭据脱敏与 `0600/0700` 权限；`logout` 一键清理本机登录态。
- 跨平台：macOS / Linux / Windows 的 Python 路径与二维码预览。

### 兼容性

- 数据目录沿用 `data/`，与开发期格式兼容；
- `migration-state.json` v1 可直接被 `status` / `import` 复用。
