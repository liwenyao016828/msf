# MSF 命令行完整指南

本文说明当前 `msf` 二进制提供的全部用户命令。普通安装只运行一个 MSF 服务，常用命令会自动使用已安装实例；除开发、迁移旧安装或排错外，不需要手工填写数据目录。

运行以下命令可随时查看中英双语速查：

```bash
msf help
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `sudo msf start` | 启动 MSF。检测到 systemd 时通过 systemd 启动，否则在后台启动当前二进制。重复执行不会启动第二个进程。 |
| `sudo msf status` | 显示 MSF、systemd、MosDNS、Mihomo 的运行状态。 |
| `sudo msf stop` | 优雅停止 MSF，并等待它托管的 MosDNS、Mihomo 退出。 |
| `sudo msf restart` | 重启 MSF；systemd 安装会执行 `systemctl restart msf`。 |
| `sudo msf logs` | 查看 MSF 日志。 |
| `sudo msf logs mosdns` | 查看 MosDNS 日志。 |
| `sudo msf logs mihomo` | 查看 Mihomo 日志。 |
| `sudo msf doctor` | 检查数据目录、组件、常用端口和系统命令。 |
| `sudo msf reset-password` | 安全重置唯一管理员的密码。 |
| `sudo msf update` | 更新 Linux tarball/systemd 安装。 |
| `sudo msf uninstall` | 卸载 Linux tarball/systemd 安装，交互确认是否保留数据。 |
| `msf version` | 显示版本和构建来源。 |
| `msf help` | 显示中英双语命令速查。 |

### 启动、停止与日志

```bash
sudo msf start
sudo msf status
sudo msf restart
sudo msf stop
```

停止默认等待 15 秒。需要延长等待或在超时后强制终止：

```bash
sudo msf stop --timeout 30s --force
```

查看最近 200 行日志：

```bash
sudo msf logs --lines 200
sudo msf logs --lines 200 mosdns
sudo msf logs --lines 200 mihomo
```

## 忘记管理员密码

只有一个管理员时，直接运行：

```bash
sudo msf reset-password
```

CLI 会自动找到本机唯一的 MSF 安装，显示两次密码输入提示。输入过程不会回显，密码必须至少 8 个字符，两次输入必须一致。

如果有多个管理员，命令会列出可选用户名并要求明确指定：

```bash
sudo msf reset-password --user admin
```

这里的 `--user admin` 只是在选择要重置的管理员。新密码不作为命令行参数；执行后再在 `新密码 / New password:` 和 `再次输入 / Confirm password:` 两个隐藏提示中输入。

密码重置完成后：

- 只修改指定管理员，不会改动其他管理员。
- 已签发给该账号的旧登录 JWT 立即失效。
- 该账号的刷新会话全部撤销。
- 新密码不会出现在成功输出中。
- 独立创建的 API Token 是单独的自动化凭据，不会被密码重置静默撤销；如怀疑凭据泄露，请登录后在 API Token 页面单独撤销。
- 如果账号已被禁用，重置密码不会擅自重新启用账号。

不同平台的入口：

```bash
# Linux tarball/systemd、Unraid
sudo msf reset-password

# Docker（把 msf 替换为实际容器名）
docker exec -it msf msf reset-password

# fnOS
sudo /var/apps/msf/target/msf reset-password

# macOS 菜单栏版
sudo /Library/PrivilegedHelperTools/io.github.scoltzero.msf.daemon reset-password
```

上述命令都不需要附加数据目录。

## `start`、`serve`、`init` 和 `migrate` 的区别

### `msf start`

这是普通用户的启动命令。systemd 安装会交给 systemd 启动；没有 systemd 单元时会把 MSF 放到后台，并将日志写入安装数据目录的日志文件。

### `msf serve`

这是服务进程的前台入口，不会自行转入后台。systemd、Docker、Unraid/fnOS 启动脚本和开发调试会调用它。直接运行时，终端关闭或进程收到 `SIGTERM` 后服务就会退出。

开发示例：

```bash
go run ./cmd/msf serve --config ./data --host 127.0.0.1 --port 7777
```

### `msf init`

创建基础目录、数据库和默认运行结构。安装脚本或平台启动脚本可在第一次启动前调用；普通用户通常不需要手工执行。

### `msf migrate`

打开目标数据库（不存在时会创建）、执行当前版本需要的数据库迁移，并检查基础目录。MSF 每次启动都会自动执行同一套迁移，因此它主要用于离线检查、升级排错或维护脚本，不是日常启动命令。

## Linux 安装维护

以下命令只适用于 Linux tarball/systemd：

```bash
sudo msf update
sudo msf service status
sudo msf service install
sudo msf service uninstall
sudo msf uninstall
```

指定发布仓库或发布包地址：

```bash
sudo msf update --repo scoltzero/msf
sudo msf update --url https://example.invalid/msf-linux-amd64.tar.gz
```

非交互环境默认保留数据。明确删除二进制、服务和数据：

```bash
sudo msf uninstall --purge --yes
```

明确保留数据：

```bash
sudo msf uninstall --keep-data
```

Docker、Unraid 和 fnOS 会拦截不适用的 Linux 安装/卸载命令，应通过各自的容器、插件或应用管理器更新和移除。

## Cloudflare Redirect

```bash
sudo msf cloudflare-redirect status
sudo msf cloudflare-redirect scan
sudo msf cloudflare-redirect apply
sudo msf cloudflare-redirect start
sudo msf cloudflare-redirect stop
```

`start` 启动定时扫描/应用守护进程；`scan` 只执行一次扫描；`apply` 应用当前结果；`stop` 同时移除已有 MosDNS 注入。该功能为实验功能，结果取决于实际网络与配置。

## macOS 菜单栏配对

`menu-bar-token` 只用于 macOS 后台与菜单栏 App 的本机配对，必须由 root 执行。正常情况下请在 App 的“连接本机后台”或后台安装/修复流程中完成，不要把命令输出的凭据复制到聊天、日志或文档。

## 版本与许可证状态

```bash
msf version
msf version --json
msf license status
msf license fingerprint
```

MSF 当前为 free/unlocked；旧商业许可证动作仅保留兼容提示，不执行激活或绑定。

## 平台适用范围

| 能力 | Linux systemd | Docker | Unraid | fnOS | macOS |
|---|---:|---:|---:|---:|---:|
| `start/status/stop/restart/logs/doctor` | 是 | 容器内有限适用 | 服务脚本优先 | 应用管理器优先 | 菜单栏 App 优先 |
| `reset-password` | 是 | 容器内执行 | 是 | 使用应用内二进制 | 使用后台 helper |
| `update/uninstall/service` | 是 | 否 | 否 | 否 | 否 |
| `menu-bar-token` | 否 | 否 | 否 | 否 | 是 |

`msf -h` 和 `msf --help` 是底层参数参考；面向普通用户的说明以 `msf help` 和本文为准。
