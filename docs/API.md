# Wharf API 文档

面向 AI 客户端与集成方。所有接口共用同一套认证与路径规则。

- Base URL：`http://<host>:8787`
- 认证：`Authorization: Bearer <令牌>`
- 除 `/api/health` 外，`/api/*`、`/mcp`、`/acp/*` 均需要令牌
- 下载类接口允许把令牌放在 query：`?token=...`
- 字符编码：UTF-8；请求体 JSON 上限 8 MiB，上传单文件上限 512 MiB

## 目录

1. [通用约定](#1-通用约定)
2. [REST 文件 API](#2-rest-文件-api)
3. [活动流](#3-活动流)
4. [MCP](#4-mcp)
5. [ACP JSON-RPC](#5-acp-json-rpc)
6. [ACP REST](#6-acp-rest)
7. [错误码](#7-错误码)

---

## 1. 通用约定

### 1.1 区域

| 值 | 含义 | 写权限 |
| --- | --- | --- |
| `drive` | 网盘，长期仓库 | 只允许通过链接/发布/写回变更 |
| `workspace` | 工作区，AI 施工台 | 可直接读写 |

### 1.2 路径

- 一律使用相对路径，`/` 分隔，例如 `notes/2026/a.md`
- 根目录写作空字符串 `""` 或 `"/"`
- 拒绝 `..`、空字节等非法字符；越界直接报 `EPATH`
- 重命名目标目录会自动创建

### 1.3 条目状态

| 状态 | 判定 |
| --- | --- |
| `shared` | 另一区域存在同路径条目，且文件 inode 相同（目录看类型一致） |
| `only` | 另一区域不存在同路径条目 |
| `diverged` | 两边都存在，但 inode 不同或类型不同（内容不一致） |

### 1.4 统一响应约定

- 成功：HTTP 200/201 + JSON
- 失败：HTTP 4xx/5xx + `{ "error": "中文说明", "code": "EXXX", "hint": "可选" }`
- 批量接口返回数组，单项失败不影响其他项，失败项形如 `{ "ok": false, "path": "...", "message": "..." }`

---

## 2. REST 文件 API

所有路径前缀 `/api`。

### 2.1 健康检查

`GET /api/health` —— 无需令牌。

```json
{ "ok": true, "name": "wharf", "version": "1.0.0" }
```

### 2.2 整体状态

`GET /api/state`

```json
{
  "ok": true,
  "name": "wharf",
  "version": "1.0.0",
  "baseUrl": "http://192.168.2.16:8787",
  "zones": {
    "drive": { "files": 12, "dirs": 4, "bytes": 1048576, "label": "网盘" },
    "workspace": { "files": 3, "dirs": 2, "bytes": 40960, "label": "工作区" }
  },
  "shared": { "files": 3, "bytes": 40960 },
  "diverged": { "files": 0, "bytes": 0 },
  "activity": { "actions": 37, "files": 19, "windowMs": 86400000 }
}
```

`shared` 是两边同 inode 的文件数；`diverged` 是内容不一致的对数（占用按两份累计）。

### 2.3 列目录

`GET /api/fs/list?zone=drive&path=notes`

```json
{
  "zone": "drive",
  "path": "notes",
  "entries": [
    { "name": "a.md", "path": "notes/a.md", "type": "file", "size": 120, "mtime": 1793375594848.45, "state": "shared", "symlink": false },
    { "name": "img", "path": "notes/img", "type": "dir", "size": null, "mtime": 1793375594799.33, "state": "shared", "symlink": false }
  ]
}
```

### 2.4 搜索

`GET /api/fs/search?zone=drive&path=&q=draft`

按文件名片段匹配，不区分大小写，返回结构同 `list`，最多 300 条。

### 2.5 单条目信息

`GET /api/fs/stat?zone=workspace&path=notes/a.md`

```json
{
  "name": "a.md", "path": "notes/a.md", "zone": "workspace",
  "type": "file", "size": 120, "mtime": 1793375594848.45,
  "birthtime": 1793375449425.2, "state": "shared", "hardlinks": 2
}
```

`hardlinks` 即 `nlink`：`2` 代表两个视图共用同一份数据。

### 2.6 预览

`GET /api/fs/preview?zone=drive&path=notes/a.md`

```json
// 文本
{ "kind": "text", "size": 120, "ext": "md", "text": "...", "truncated": false, "limit": 2097152 }
// 图片
{ "kind": "image", "size": 4096, "ext": "png" }
// 其他二进制
{ "kind": "binary", "size": 8192, "ext": "zip" }
```

图片实际展示用 `download?inline=1`。

### 2.7 下载

`GET /api/fs/download?zone=drive&path=notes/a.md[&inline=1][&token=...]`

- 普通下载：`Content-Disposition: attachment`
- `inline=1`：浏览器内打开（图片预览用这个）
- 每次下载都会写入一条活动事件
- 文件夹不可下载，返回 `EISDIR`

```
http://<host>:8787/api/fs/download?zone=drive&path=notes%2Fa.md&token=wharf_xxx
```

### 2.8 上传

`POST /api/fs/upload`，`multipart/form-data`

| 字段 | 说明 |
| --- | --- |
| `zone` | `drive` 或 `workspace`，默认 `drive` |
| `dir` | 目标目录相对路径，默认根目录 |
| `overwrite` | `"true"` 时覆盖同名文件（覆盖写保留 inode，已链接的视图同步更新） |
| `files` | 可多选，最多 30 个 |

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -F zone=drive -F dir=notes \
  -F files=@./a.md \
  http://192.168.2.16:8787/api/fs/upload
```

```json
{
  "results": [
    { "ok": true, "name": "a.md", "path": "notes/a.md", "zone": "drive", "size": 120, "mtime": 1793375594848.45, "state": "only" }
  ]
}
```

### 2.9 新建文件夹

`POST /api/fs/folder` `{ "zone": "drive", "path": "notes/2026" }`

### 2.10 批量重命名

`POST /api/fs/rename`

```json
{
  "zone": "workspace",
  "items": [
    { "from": "notes/a.md", "to": "notes/b.md" },
    { "from": "notes/b.md", "to": "notes/a.md" }
  ]
}
```

- 两阶段改名，支持 `a→b`、`b→a` 互换
- 若源条目另一区域是硬链接/同名目录，另一个视图会同步改名
- 目标已存在且不是本批次源路径时报 `EEXIST`
- 缺省 `zone` 为 `drive`；若条目实际在另一区域，报错信息会提示应使用的 `zone`

响应：`{ "renamed": [ { "from": "...", "to": "...", "zone": "...", "mirror": true } ] }`

### 2.11 批量删除

`POST /api/fs/delete`

```json
{ "zone": "drive", "paths": ["notes/a.md"], "purge": false }
```

- `purge: false`（默认）：只删除当前区域视图。若条目是 `shared`，另一区域仍可用
- `purge: true`：两边视图都删除

响应：

```json
{
  "results": [
    { "path": "notes/a.md", "ok": true, "type": "file", "state": "shared",
      "note": "只删除了网盘的视图，文件内容仍在工作区" }
  ]
}
```

### 2.12 移到工作区（建立硬链接）

`POST /api/fs/link` `{ "paths": ["notes/a.md"] }`

从 `drive` 建立链接到 `workspace`；目录递归处理。

```json
{ "results": [ { "ok": true, "path": "notes/a.md", "type": "file", "mode": "shared" } ] }
```

`mode` 取值：

- `shared`：硬链接成功，两边同 inode
- `copied`：跨文件系统，降级为复制，两边内容相同但非同一 inode

### 2.13 发布到网盘

`POST /api/fs/publish` `{ "paths": ["drafts/a.md"] }`

把工作区新建的文件/目录链接到 `drive`，语义与 `link` 相反。

### 2.14 写回网盘

`POST /api/fs/sync` `{ "paths": ["notes/a.md"] }`

用于 `diverged` 状态：把工作区内容覆盖到网盘（覆盖写保留网盘 inode），再把工作区视图重建为硬链接，最终恢复 `shared`。

### 2.15 退回网盘

`POST /api/fs/release` `{ "paths": ["notes/a.md"] }`

- `shared`：只移除工作区视图，数据留在网盘
- 工作区独占文件：移动到网盘
- `diverged`：拒绝，要求先 `sync`

响应中的 `mode`：`released`（只关视图）/ `moved`（内容移入网盘）。

### 2.16 复制

`POST /api/fs/copy` `{ "zone": "drive", "from": "a.md", "to": "a-copy.md" }`

同区域内复制文件或目录（真实复制，产生独立 inode）。

### 2.17 从链接导入

`POST /api/fs/import`

```json
{ "url": "https://example.com/logo.png", "zone": "drive", "dir": "assets", "filename": "logo.png" }
```

- 只支持 `http/https`
- 拒绝 `localhost`、`127.*`、`10.*`、`172.16-31.*`、`192.168.*`、`169.254.*`、`0.*`、`::1`、`0.0.0.0`
- 上限 `MAX_IMPORT_BYTES`（默认 64 MiB）
- 同名文件不覆盖，报 `EEXIST`

---

## 3. 活动流

把 AI 的操作合并成人类可读的条目。

### 3.1 事件结构

```json
{
  "id": "evt_175...",
  "at": 1793375951103,
  "actor": "ai",
  "action": "write",
  "zone": "workspace",
  "title": "改写了「上传样例.txt」",
  "detail": "网盘视图同步变更（同一物理文件）",
  "items": [ { "path": "上传样例.txt", "zone": "workspace", "type": "file", "note": "31 B" } ],
  "batchId": "call_ab12cd34ef56",
  "meta": {}
}
```

`actor`：`ai` / `ui` / `api` / `system`。`ai` 来自 MCP、ACP；`ui` 来自网页；`api` 来自直接调 REST 的其他程序。

### 3.2 查询

`GET /api/activity?limit=120&actor=ai&since=<毫秒时间戳>&zone=workspace`

```json
{ "events": [ ... ], "summary": { "actions": 37, "files": 19, "windowMs": 86400000 } }
```

### 3.3 摘要

`GET /api/activity/summary` → `{ "actions": 37, "files": 19, "windowMs": 86400000 }`（24 小时窗口）。

### 3.4 实时订阅

`GET /api/activity/stream?token=...`，`text/event-stream`

```
retry: 3000

data: {"id":"evt_...","title":"把 2 个文件移到了工作区", ...}

: ping
```

- 每 25 秒发一次注释心跳
- 连接断开后浏览器自动重连；连不上时前端降级为 8 秒轮询 `/api/activity`

### 3.5 合并规则

同一 `batchId` 的事件、或同一 `actor` + `action` 且 10 分钟内的连续事件，会被合并为一条（例如「删除了 2 个条目」），避免刷屏。

---

## 4. MCP

### 4.1 传输

- 端点：`POST /mcp`（`GET /mcp` 返回 405 与工具清单，方便探活）
- 协议：JSON-RPC 2.0，无状态
- 协议版本：`2025-06-18`、`2025-03-26`、`2024-11-05`
- 响应：客户端 `Accept: text/event-stream` 时以 SSE 单事件返回，否则返回 `application/json`

### 4.2 支持的方法

| 方法 | 说明 |
| --- | --- |
| `initialize` | 返回 `serverInfo`、`capabilities`、协议版本 |
| `ping` | 空返回 |
| `tools/list` | 16 个工具定义 |
| `tools/call` | 执行工具，参数 `{ name, arguments }` |
| `resources/list` / `prompts/list` | 返回空列表 |

### 4.3 工具一览

| 工具 | 必填参数 | 说明 |
| --- | --- | --- |
| `vault_overview` | — | 网盘/工作区文件数、体积、共用数、分叉数 |
| `list_items` | — | `zone`、`path`、`recursive`、`depth`（默认 2） |
| `search_items` | `query` | `zone`、`path` 起点 |
| `stat_item` | `path` | `zone`；含 `hardlinks` |
| `read_file` | `path` | `zone`、`max_bytes`；二进制返回 base64 |
| `write_file` | `path`、`content` | 仅工作区；`mode`: `overwrite` / `append` |
| `create_folder` | `path` | `zone`，默认 `workspace`，自动建父目录 |
| `move_to_workspace` | `paths` | 网盘 → 工作区硬链接，目录递归 |
| `publish_to_drive` | `paths` | 工作区 → 网盘硬链接 |
| `sync_to_drive` | `paths` | 内容覆盖网盘并恢复同一份数据 |
| `release_to_drive` | `paths` | 关闭工作区视图 / 独占文件移入网盘 |
| `rename_items` | `items[{from,to}]` | `zone`；支持 a↔b 交换，自动同步另一视图 |
| `delete_items` | `paths` | `zone`、`purge` |
| `copy_item` | `from`、`to` | `zone` |
| `import_url` | `url` | `path`、`filename`、`zone` |
| `download_link` | `path` | `zone`；需服务端配置 `PUBLIC_URL` |

### 4.4 调用示例

```bash
curl -s http://192.168.2.16:8787/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc": "2.0", "id": 1, "method": "tools/call",
    "params": { "name": "move_to_workspace", "arguments": { "paths": ["notes/a.md"] } }
  }'
```

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "content": [ { "type": "text", "text": "移到工作区：notes/a.md" } ],
    "isError": false
  }
}
```

工具内部报错会转成 `result.isError = true`，文本为中文错误说明，HTTP 状态仍为 200。

---

## 5. ACP JSON-RPC

### 5.1 传输

- 端点：`POST /acp`
- JSON-RPC 2.0；`notifications/*` 直接返回 `202`
- 路径默认相对**工作区**，也接受 `/data/workspace/notes/a.md` 这类绝对写法（会自动剥离前缀）

### 5.2 方法

| 方法 | 参数 | 返回 |
| --- | --- | --- |
| `initialize` | — | `protocolVersion`、`agentCapabilities`、`serverInfo`、`authMethods: ["bearer"]` |
| `fs/read_text_file` | `path`、可选 `line`、`limit` | `{ content }` |
| `fs/write_text_file` | `path`、`content` | `null` |
| `fs/list_directory` | `path` | `{ entries }` |
| `fs/stat_item` | `path` | 单条目信息 |
| `fs/search` | `path`、`query` | `{ entries }` |
| `fs/create_folder` | `path` | 创建结果 |
| `fs/rename_items` | `items[{from,to}]` | `{ renamed }` |
| `fs/delete_items` | `paths`、可选 `purge` | `{ results }` |
| `fs/move_to_workspace` | `paths` | `{ results }` |
| `fs/publish_to_drive` | `paths` | `{ results }` |
| `fs/sync_to_drive` | `paths` | `{ results }` |
| `fs/release_to_drive` | `paths` | `{ results }` |

除只读方法外，每个写操作都会记录活动事件（`meta.source = "acp"`）。

### 5.3 示例

```bash
curl -s http://192.168.2.16:8787/acp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":7,"method":"fs/write_text_file",
       "params":{"path":"acp-测试.txt","content":"ACP 写入"}}'
```

```json
{ "jsonrpc": "2.0", "id": 7, "result": null }
```

错误：

```json
{ "jsonrpc": "2.0", "id": 7,
  "error": { "code": -32601, "message": "不支持的 ACP 方法：fs/xxx" } }
```

---

## 6. ACP REST

### 6.1 端点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/acp` | 协议信息、可用传输、agent 描述 |
| `GET` | `/acp/agents` | agent 列表 |
| `GET` | `/acp/agents/:name` | agent 详情（仅 `wharf-workspace`） |
| `POST` | `/acp/agents/:name/runs` | 同步执行一次工具调用，返回 run |
| `GET` | `/acp/runs` | 最近 run 列表（`?limit=`，最多 100） |
| `GET` | `/acp/runs/:id` | 单个 run |

### 6.2 创建 run

```bash
curl -s -X POST http://192.168.2.16:8787/acp/agents/wharf-workspace/runs \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"input":{"tool":"list_items","args":{"zone":"workspace","path":""}}}'
```

`input` 也可以是 JSON 字符串，或直接传 `{ "tool": "...", "args": {...} }`、`{ "tool_call": {...} }`。

```json
{
  "id": "run_f3d48f642aed44d6",
  "object": "run",
  "agent_name": "wharf-workspace",
  "status": "completed",
  "created_at": "2026-10-30T15:59:11.243Z",
  "finished_at": "2026-10-30T15:59:11.246Z",
  "input": { "tool": "list_items", "args": { "zone": "workspace", "path": "" } },
  "output": { "tool": "list_items", "content": [ { "type": "text", "text": "...被列出的内容..." } ] }
}
```

- `status`：`completed` / `failed`
- 工具报错不会让接口失败，`status` 变 `failed`，`output` 为 `{ tool, error, hint }`
- runs 保存在内存，上限 200 条，重启清空

---

## 7. 错误码

| code | 含义 | 典型 HTTP |
| --- | --- | --- |
| `EPATH` | 路径非法（空、含 `..`、越界） | 400 |
| `EZONE` | 区域不是 `drive` / `workspace` | 400 |
| `ENOENT` | 条目或目录不存在 | 404 |
| `EISDIR` | 对文件夹做了文件操作 | 400 |
| `ENOTDIR` | 期望目录但拿到文件 | 400 |
| `EEXIST` | 目标已存在 | 409 |
| `EDIVERGED` | 两区域内容不一致，需先写回网盘 | 400 |
| `ENAME` | 文件名无效 | 400 |
| `EPATH` / `ETOOBIG` | 超过体积上限 | 413 |
| `ESSRF` | 导入链接指向内网或保留地址 | 400 |
| `EURL` | 链接格式错误 | 400 |
| `EIMPORT` | 远端下载失败 | 502 |
| `ENOTOOL` | MCP 工具名不存在 | 404 |
| `EINPUT` | ACP run 输入结构错误 | 400 |
| `EAGENT` | ACP agent 不存在 | 404 |
| `ERUN` | run 不存在 | 404 |
| `EUNAUTH` | 缺少或错误的令牌（前端使用） | 401 |
| `EINTERNAL` | 服务端未预期错误 | 500 |
