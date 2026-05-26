# Claude 会话查看器

本地查看 Claude Code 的历史会话：列表 + 关键词搜索 + 会话详情。

## 启动

```bash
cd /Users/jeff/Desktop/claude
npm install   # 首次需要
node server.js
```

打开浏览器：<http://localhost:3000>

## 功能

- 自动扫描 `~/.claude/projects/` 下所有 `.jsonl` 会话文件
- 左侧列表：按时间倒序，显示项目路径、首条用户消息预览、问答数
- 顶部搜索框：模糊匹配 **用户消息内容** + **项目路径**（命中处会高亮）
- 右侧详情：完整对话流，区分用户/Claude/工具结果
- 工具调用（Bash / Read / Edit 等）**默认折叠**，点击展开查看参数和结果
- Claude 的 thinking 块默认隐藏，点击可展开
- 代码块带语法高亮
- 右上角 `↻` 按钮：手动重扫文件系统（新会话不会自动出现）

## 端口

默认 `3000`。如需更换：

```bash
PORT=8080 node server.js
```

## 目录结构

```
.
├── server.js          # Express 后端 + 会话解析/索引
├── package.json
└── public/
    ├── index.html
    ├── app.js
    └── style.css
```

## 数据来源

只读访问 `~/.claude/projects/`，不写入任何文件。会话索引保存在内存中。
