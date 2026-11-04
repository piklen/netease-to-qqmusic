# 安全说明

## 凭据存放

| 文件 | 内容 | 权限 |
| --- | --- | --- |
| `data/.secrets/netease-session.json` | 网易云 Cookie | 0600 |
| `data/.secrets/qq-credential.json` | QQ 音乐登录凭据 | 0600 |
| `data/.secrets/qq-device.json` | QQ 设备标识 | 0600 |
| `data/.secrets/qq-login-preview.png` | 临时二维码，登录成功后自动删除 | 0600 |

`data/.secrets/` 目录权限为 `0700`。这些文件等价于登录凭据，**不要提交到 Git、不要发到聊天或截图**。

## 网络行为

- 网易云接口由 `@neteasecloudmusicapienhanced/api` 在本机 `127.0.0.1` 启动，只注册登录与收藏读取所需路由，不监听外部地址；
- 与 QQ 音乐的通信直接从本机发起，不经过任何中间服务器；
- 作者不收集、不上传任何数据；项目不含遥测。

## 日志脱敏

终端输出、`import-report.json`、错误信息会对以下字段做替换：

`MUSIC_U`、`MUSIC_A`、`__csrf`、`qm_keyst`、`qqmusic_key`、`p_skey`、`skey`、`uin`、`wxuin`。

底层第三方库的请求日志（包含带 Cookie 的本地 URL）会被拦截，不进入终端或报告。这样仍不能覆盖所有情况：如果你自己用 `--verbose` 或 `DEBUG=1` 排查问题，请在分享输出前自行检查。

## 如果你怀疑凭据泄露

1. 在网易云 / QQ 音乐中退出所有设备或修改密码，使旧会话失效；
2. 运行 `n2q logout` 删除本机保存的凭据；
3. 不要只删除聊天记录——Cookie 可能已被缓存或转发。

## 风险边界

本项目使用非官方接口完成写入。它不会删除数据，也无法保证平台长期兼容；遇到风控提示请停止操作。仅用于迁移你本人的账号。
