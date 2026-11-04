# 网易云音乐 → QQ 音乐

[![CI](https://github.com/piklen/netease-to-qqmusic/actions/workflows/ci.yml/badge.svg)](https://github.com/piklen/netease-to-qqmusic/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)

在**你自己的电脑上**把网易云音乐的歌单、我喜欢、收藏专辑和关注歌手迁移到 QQ 音乐。全程本地运行，不经过第三方服务器，写入前必须手动确认。

[English](README.en.md) · [常见问题](#常见问题) · [安全说明](SECURITY.md)

---

## 为什么不直接用现成方案

| 方案 | 局限 |
| --- | --- |
| QQ 官方文本导入 | 只支持公开歌单文本，不覆盖完整账号收藏，无法处理“我喜欢”、专辑、歌手 |
| [ToQQMusic](https://github.com/alex3236/ToQQMusic) | 已归档，只处理歌单且需逐首确认 |
| [GoMusic](https://github.com/Bistutu/GoMusic) | 目标平台是 Apple Music / YouTube Music / Spotify |
| Soundiiz 等商业服务 | 需要把账号授权给第三方，免费版每张歌单 200 首，批量功能付费 |

本项目补的是这块空白：**完整账号级迁移，本地可控，带可审计的匹配结果和断点恢复。**

## 能迁移什么

| 内容 | 默认行为 |
| --- | --- |
| 本人创建的歌单 + 歌曲顺序 | 创建对应 QQ 歌单，保持源顺序 |
| “我喜欢的音乐” | 直接写入 QQ「我喜欢」（`dirid=201`），不创建同名歌单 |
| 收藏的专辑 | 导出并匹配，`--albums` 时收藏 |
| 关注的歌手 | 导出并匹配，`--artists` 时关注 |
| 收藏他人的歌单 | **默认只备份**；`--copy-collected` 才复制为 `网易云收藏-<原名>` |

**不迁移**：评论、动态、播放历史、封面与描述、云盘音频、已下载文件、会员/购买权益、社交关系。两家曲库不同，没有对应版本的歌曲会进入报告，不会被硬凑。

## 安装

需要 **Node.js ≥ 18** 和 **Python ≥ 3.10**。

```bash
git clone https://github.com/piklen/netease-to-qqmusic.git
cd netease-to-qqmusic
npm run setup        # 安装 Node 依赖，创建 .venv 并安装 Python 依赖
```

`npm run setup` 幂等，可重复执行；它只做检查和安装，不会触碰任何账号。也可 `npm link` 后直接使用 `n2q` 命令，或始终用 `node bin/n2q.js`。

## 六步完成迁移

```bash
# 1. 登录网易云（扫码；风控拦截时可粘贴网页 Cookie，输入不回显）
n2q login

# 2. 备份全部收藏 —— 只读，不写 QQ
n2q export

# 3. 搜索 QQ 音乐并生成匹配 —— 只读，不写 QQ
n2q prepare

# 4. 处理待确认项（交互式；直接回车采用推荐版本，s 跳过，q 结束）
n2q review

# 5. 先演练，看清楚会做什么
n2q import --dry-run --albums --artists

# 6. 正式写入（必须手动输入 IMPORT）
n2q import --albums --artists

# 7. 只读核对写入结果
n2q verify
```

首次登录 QQ 会在终端弹二维码，同时自动打开一张放大图片。手机 QQ、微信、QQ 音乐 App 都可以扫。

> **建议先用 `--limit` 或一张小歌单试跑**，确认匹配质量后再全量。

## 匹配是怎么做的

1. 先用 `歌名 + 全部歌手` 搜索，不足时退化为 `歌名 + 主歌手`、`歌名`；
2. 逐候选打分：歌名（70）、歌手重叠（30）、专辑（6）、时长（±5）、版本标签（Live/Remix/DJ/伴奏… −22 ~ −30）；
3. **只有** 总分 ≥ 92、歌名完全一致、歌手一致、专辑或时长佐证、无同分候选，才自动通过；
4. 其余进入待确认；如果你开了替代建议，会优先“同歌手”再“相关歌名 + 热度”，并在报告里标出来源；
5. 所有自动决策都写入 `data/fallback-audit.json`，可以回溯每一首为什么选了这个版本。

`data/overrides.json` 按 **歌单 ID + 曲目位置** 记录人工决定，所以同一首歌在多个歌单出现时可以分别处理。

## 命令一览

| 命令 | 作用 |
| --- | --- |
| `n2q login` | 保存网易云登录态 |
| `n2q export` | 备份收藏，生成官方文本导入分片 |
| `n2q prepare` | 匹配 QQ 音乐（`--owned-only`、`--playlist`、`--no-fallback`、`--rebuild`） |
| `n2q review` | 交互处理待确认项（`--list` 只列出，`--only all` 复查全部） |
| `n2q import` | 写入 QQ（`--dry-run`、`--albums`、`--artists`、`--copy-collected`、`--limit`、`--strict`） |
| `n2q verify` | 只读读取 QQ 歌单并比对 |
| `n2q status` | 断点、匹配统计、上次导入结果（`--json`） |
| `n2q report` | 重新生成 `review.csv` / `review.md` / `unresolved.json` |
| `n2q doctor` | 检查 Node、Python、依赖、登录态和数据目录 |
| `n2q logout` | 删除本机保存的登录凭据 |

任何命令加 `--help` 查看详细选项。

### 中断与恢复

```bash
n2q import --albums --artists     # 直接重跑：已成功的歌单/歌曲自动跳过
n2q status                        # 查看还剩多少、失败在哪
```

- 建单成功但加歌中断？重跑不会重复建单；
- 单首失败默认**记录后继续**，不拖垮整轮；`--strict` 才首个失败即停；
- 批量写入失败会自动降级为逐首重试，定位到具体歌曲；
- 版权/下架类错误不重试，记为跳过；
- 网络在“已写入但没收到响应”时断开，仍可能产生一次重复添加——非官方接口无法替 QQ 做事务回滚。

### 可选：QQ 官方文本导入

`n2q export` 会在 `data/official-import/` 生成每 100 首一份的文本，可直接粘贴到 [QQ 官方导入页](https://y.qq.com/y/static/mymusic/songlist_import.html)。适合只需要公开歌单、且不想扫码的场景。

## 数据目录

```
data/
├── .secrets/                     # 登录态与设备信息，权限 0600/0700
├── netease-backup-<time>.json    # 带时间的完整备份，不会互相覆盖
├── latest-backup.json            # 最新备份
├── matches.json                  # 匹配结果与候选
├── search-cache-authenticated.json
├── overrides.json                # 人工决定（唯一需要手改的文件）
├── migration-state.json          # 断点
├── fallback-audit.json           # 每首替代版本的来源与热度
├── import-report.json            # 最近一轮写入结果
├── verify-report.json            # 只读核验结果
├── review.csv / review.md        # 人工审阅
└── unresolved.json               # 无可靠对应的清单
```

用 `--data-dir /path/to/data` 或环境变量 `N2Q_DATA_DIR` 隔离多个账号。

## 常见问题

**扫码提示“检测环境异常”？**
网易云风控。不要重复刷新二维码，改用 `n2q login` 粘贴已登录网页的 Cookie（输入不回显）。

**QQ 搜不到某首歌？**
曲库差异或版权原因。`unresolved.json` 会保留它，`n2q review` 可以在候选里挑一个近似版本，或直接跳过。

**“我喜欢”数量对不上？**
`n2q verify` 按唯一歌曲 ID 比对。QQ 会折叠重复歌曲，所以「位置数」和「实际歌曲数」本来就可能不同。

**会删东西吗？**
不会。所有写操作只有：建歌单、加歌、收藏专辑、关注歌手。没有删除、没有取消收藏、没有退出登录。

**接口失效了？**
QQ 写入依赖非官方接口，平台调整后可能失效。报错会保留断点，修复后可直接重跑。

## 安全

- 登录态只保存在 `data/.secrets/`，目录 `0700`、文件 `0600`；
- 网易云接口只监听 `127.0.0.1`，不对外开放；
- 日志和错误信息会对 `MUSIC_U`、`qqmusic_key`、`skey` 等字段做脱敏；
- 备份和报告含个人收藏数据，**不要公开分享**；
- 凭据一旦出现在截图、聊天或终端历史中，请到平台侧使旧会话失效；
- 完整说明见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
npm test                                      # 29 项 Node 测试
npm run test:py                               # 5 项 Python 测试
node bin/n2q.js doctor                        # 环境自检
```

测试不连接任何真实账号：QQ 侧用 `test/mock_qq_bridge.py` 模拟 JSON Lines 协议，网易云侧只测纯函数与本地状态机。

## 技术依据

- 网易云只读导出：[NeteaseCloudMusicApiEnhanced/api-enhanced](https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced)
- QQ 扫码登录、建单、加歌、收藏专辑、读取歌单：[L-1124/QQMusicApi](https://github.com/L-1124/QQMusicApi)
- 歌手关注使用旧网页接口，可能随平台变动失效

**QQ 写入接口不是官方开放 API。** 仅供迁移自己的账号使用，请遵守平台条款；遇到风控请停止，而不是重试轰炸。

## License

[MIT](LICENSE)。项目与网易、腾讯均无关联。
