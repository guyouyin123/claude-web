# claude-web

> 本地查看 Claude Code 历史会话的 Web 工具。一行命令拉起、零配置即用、纯本地、不上传任何数据。

[![npm version](https://img.shields.io/npm/v/claude-web-gyy.svg)](https://www.npmjs.com/package/claude-web-gyy)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## 这是什么

Claude Code 把你和 Claude 的每一次对话都以 `.jsonl` 形式保存在本机 `~/.claude/projects/` 里，但官方没有图形界面查看。本工具补这一环：

- 🧭 **会话浏览**：左侧按项目分组的可折叠树，按时间倒序
- 🔍 **全文搜索**：用户消息 / Claude 回复 / 项目路径 / 标签名 模糊匹配，命中处高亮
- 📌 **置顶 / 收藏 / 自定义名**：把重要会话钉住，给会话起便于辨认的名字
- 🏷️ **标签系统**：自定义颜色 tag，多标签 AND 过滤
- 📅 **时间范围过滤**：近 7 / 30 / 90 天或自定义起止
- 📊 **Token 统计**：列表卡显示累计输入/输出；详情显示缓存命中率、末次上下文占用进度条；每条 Claude 回复显示本轮 token
- 📝 **完整 Markdown 渲染**：代码块语法高亮、表格、列表、引用
- 🤖 **子 Agent 折叠**：Task 子 agent 的内部消息聚合成可折叠块
- ♻️ **文件变化实时同步**：监听 jsonl 增量更新，正在跑的会话实时追加；离开页面自动暂停 SSE
- 📈 **统计仪表盘**：按项目 / 按日 / 按模型 / Top 消耗会话
- 🎨 **柔和暗色主题**

---

## 截图

**会话搜索、模糊查询、标签、收藏、置顶**

![](https://img2024.cnblogs.com/blog/1736414/202605/1736414-20260526095325637-1994515318.png)

**标签管理**

![](https://img2024.cnblogs.com/blog/1736414/202605/1736414-20260526095846344-1136647341.png)

**统计看板**

![](https://img2024.cnblogs.com/blog/1736414/202605/1736414-20260526095541867-1401288135.png)

**配置 Claude 路径**

![](https://img2024.cnblogs.com/blog/1736414/202605/1736414-20260526095755906-768935349.png)

---

## 快速开始

### 前置：装 Node.js（≥ 18）

[nodejs.org](https://nodejs.org/) 下载 LTS 版本，一路 Next 装完。验证：

```bash
node -v   # 应 ≥ v18
npm -v
```

### macOS / Linux

```bash
# 推荐：npx 临时运行，不留任何全局安装
npx claude-web-gyy

# 或者全局装一次，后面直接用 claude-web
npm install -g claude-web-gyy
claude-web
```

### Windows

在 **PowerShell** 或 **Windows Terminal** 里：

```powershell
npx claude-web-gyy
```

第一次运行 Windows 防火墙弹窗 → 允许 **专用网络** 即可（公用网络不需要勾选，本服务只监听 localhost）。

> 如果命令报"找不到 npx"，重启 PowerShell 或重启电脑让 Node 的 PATH 生效。
>
> 全局安装后 `claude-web` 命令报执行策略错误：以管理员身份打开 PowerShell 跑一次 `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`。

### 启动后

- 自动打开默认浏览器到 **`http://localhost:2888`**
- 在终端 `Ctrl+C` 停止服务

### 后台常驻运行（关掉终端也不会停）

**macOS / Linux**

```bash
nohup npx claude-web-gyy > ~/claude-web.log 2>&1 &
```

- `nohup` 让进程脱离当前终端，关 iTerm/Terminal 不会被 SIGHUP 杀掉
- `--no-open` 防止每次都重复弹浏览器
- 日志写到 `~/claude-web.log`，需要看就 `tail -f ~/claude-web.log`
- 末尾的 `&` 让它在后台跑，立即把命令行交还给你

随时停止：

```bash
lsof -ti :2888 | xargs kill
```

**Windows（PowerShell）**

```powershell
Start-Process -WindowStyle Hidden npx -ArgumentList "claude-web-gyy","--no-open" -RedirectStandardOutput "$env:USERPROFILE\claude-web.log"
```

随时停止：

```powershell
Get-NetTCPConnection -LocalPort 2888 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## 默认配置（零配置即用）

| 项 | 默认值 | 说明 |
|---|---|---|
| **端口** | `2888` | 被占用时会自动杀掉占用进程，仍在 2888 启动 |
| **Claude 数据目录** | `~/.claude` | Claude Code 官方默认路径，本工具自动读 |
| **自动开浏览器** | 开启 | 启动后约 600ms 自动 `open` 浏览器 |
| **应用数据目录** | `<claudeDir>/claude-web/` | 自定义名 / tags / 置顶 / 收藏 都存这里 |
| **bootstrap 配置** | `~/.claude-web/bootstrap.json` | 只存 claudeDir 路径覆盖 |

只要你装了 Claude Code 且用过几次，**绝大多数情况无需任何配置**，直接 `npx claude-web-gyy` 就能看到全部会话。

---

## 可修改配置

可以从三个维度调整：**CLI 参数**、**环境变量**、**App UI 内修改**。优先级：`环境变量 > CLI > bootstrap.json > 默认值`。

### 1. 命令行参数

| 参数 | 默认 | 作用 |
|---|---|---|
| `--port <number>` | `2888` | 指定监听端口；被占用时自动杀进程重启同端口 |
| `--no-open` | — | 启动后不自动打开浏览器（后台/服务器/容器/CI 场景） |
| `-h`, `--help` | — | 打印帮助并退出 |

**用法示例**

```bash
claude-web --help                       # 看所有选项
claude-web --port 8080                  # 换端口
claude-web --no-open                    # 不弹浏览器
claude-web --port 8080 --no-open        # 组合使用
```

`npx` 和全局安装两种调用方式参数完全一致：

```bash
npx claude-web-gyy --port 8080 --no-open
```

### 2. 环境变量

| 变量 | 作用 | 示例 |
|---|---|---|
| `PORT` | 端口（同 `--port`，但 env 优先级更高） | `PORT=8080 claude-web` |
| `CLAUDE_DIR` | Claude 数据目录（覆盖 bootstrap 配置） | `CLAUDE_DIR=/path/to/.claude claude-web` |
| `CLAUDE_WEB_HOME` | bootstrap 配置目录（默认 `~/.claude-web`） | `CLAUDE_WEB_HOME=/tmp/cw claude-web` |
| `CLAUDE_WEB_NO_OPEN` | 设为 `1` 时等同于 `--no-open` | `CLAUDE_WEB_NO_OPEN=1 claude-web` |

**组合示例**

```bash
# 指向另一台机器 rsync 过来的 .claude，固定端口 9000，不开浏览器
CLAUDE_DIR=/backup/colleague-claude PORT=9000 claude-web --no-open
```

**优先级**：`环境变量 > 命令行参数 > bootstrap.json > 默认值`

### 3. App UI 里修改

点击页面右上角 **⚙** 按钮，可以改 claudeDir 路径，保存后立即重新扫描索引。
路径覆盖会写入 `~/.claude-web/bootstrap.json`，下次启动也生效。

![](https://img2024.cnblogs.com/blog/1736414/202605/1736414-20260526095755906-768935349.png)

### 4. 应用数据落盘的位置

```
<claudeDir>/claude-web/
├── config.json            # tags 库 + tag 与会话的绑定
├── session-names.json     # 会话自定义名映射
├── pinned.json            # 置顶 sessionId 列表
└── favorite.json          # 收藏 sessionId 列表

~/.claude-web/
└── bootstrap.json         # claudeDir 路径覆盖（UI 里改路径时生成）
```

**把这两个目录一起备份就能跨机器迁移所有偏好。**

---

## 数据安全

- ✅ 只**读**访问 `~/.claude/projects/*.jsonl`，不修改你的对话历史
- ✅ 服务**仅监听 `localhost`**，不对外暴露端口
- ✅ 所有自定义数据落本地磁盘，**不上传任何东西到云端**
- ✅ 完整源代码开放：<https://github.com/guyouyin/claude-web>

---

## 进阶：从源码运行（开发者）

```bash
git clone https://github.com/guyouyin/claude-web.git
cd claude-web
npm install
npm start
```

修改代码后 `Ctrl+C` 停止，再次 `npm start` 即可。

---

## 故障排查

| 现象 | 原因 / 解决 |
|---|---|
| 启动后页面空白 | 没装 Claude Code、或 claudeDir 路径不对。点右上角 ⚙ 设置正确路径 |
| 浏览器没自动打开 | 用 `--no-open` 关掉，自己复制 `http://localhost:2888` 打开 |
| 端口 2888 被占用 | 程序会自动杀掉占用进程并重启在 2888（macOS/Linux 用 lsof、Windows 用 netstat+taskkill） |
| Windows 中文显示乱码 | 用 PowerShell 或 Windows Terminal，不要用老 cmd（GBK 编码） |
| WSL 里启动后 Windows 浏览器访问不到 | WSL2 一般会自动转发；如果不行手动 `localhost:2888` 浏览器访问 |
| 升级到最新版 | `npm install -g claude-web-gyy@latest` |
| 卸载 | `npm uninstall -g claude-web-gyy`；删除 `<claudeDir>/claude-web/` 和 `~/.claude-web/` 即可彻底清理 |

---

## 环境要求

- Node.js ≥ 18
- macOS / Linux / Windows

## 许可证

[MIT](LICENSE) © 2026 guyouyin
