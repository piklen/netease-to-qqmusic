# 贡献指南

## 环境

```bash
npm install
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

需要 Node.js ≥ 18、Python ≥ 3.10。

## 修改前

- 先读 `src/core/matching.js`：匹配规则的任何改动都会影响错配率，请说明理由并补测试；
- 写入路径在 `src/core/migrate.js`，改动必须保证断点语义（已成功项不重复写）；
- Python 侧 `src/py/qq_bridge.py` 使用 stdio JSON Lines 协议，新增命令需同时更新 Node 侧的调用与测试替身 `test/mock_qq_bridge.py`。

## 必须通过的检查

```bash
npm test
npm run test:py
node bin/n2q.js doctor
```

## 新增依赖

请谨慎。Node 侧只应有网易云接口库与二维码渲染；Python 侧保持 `qqmusic-api-python`、`qrcode`、`Pillow` 三项。新增依赖需说明必要性，并更新 `requirements.txt`、`package.json` 与 README 的安装说明。

## 测试约定

- 不连接真实账号，不写入任何真实平台；
- QQ 交互一律通过 `test/mock_qq_bridge.py`；
- 涉及网络的行为用协议层替身验证，而不是依赖在线接口。

## 提交信息

```
feat: 支持按歌单名筛选匹配
fix: Live 版不再被自动当作录音室版
docs: 补充断点恢复说明
```

## 不接受的改动

- 删除、清空、取消收藏类写操作；
- 绕过确认步骤的默认行为；
- 把凭据写入日志、报告或终端明文；
- 将匹配失败强行选择最热结果而不留记录。
