# Wharf

**面向 AI 的网盘 + 工作区，单一物理文件的双视图存储。**
网盘是仓库，工作区是 AI 的操作台。两个视图指向同一份磁盘数据，所以「看起来两份，实际只有一份」。

- 单容器 Docker，ARM64 / AMD64 均可
- 自带 MCP（16 个工具）、ACP（JSON-RPC `fs/*` + REST `agents/runs`）与 REST 文件 API
- Web 界面把 AI 的操作翻译成人话卡片，而不是日志流

---

## 1. 它解决什么问题

大多数「AI 网盘」把读写权限一股脑交给模型：删了就是删了，改了也不知道改了哪儿。Wharf 的做法是**分权 + 可回溯**：

| 区域 | 定位 | AI 权限 |
| --- | --- | --- |
| 网盘 `drive` | 长期仓库 | 只读（可下载、可预览、可搜索） |
| 工作区 `workspace` | AI 施工台 | 可新建、可改写、可批量改名、可删除 |

要改网盘里的文件，必须先把条目 **移到工作区**（`move_to_workspace`）。这一步在磁盘上是一次 `link()` 系统调用——两个目录出现同名条目，但 inode 相同、`nlink = 2`，实际只有一份数据。

### 三个条目状态

| 状态 | 含义 | 磁盘事实 |
| --- | --- | --- |
| `shared` 共用 | 两边都有，且是同一个文件 | 同 inode |
| `only` 单区 | 只在当前区域出现 | 一份 |
| `diverged` 已分叉 | 两边都有，但内容不同 | 两份，需要 `sync_to_drive` |

正常操作永远停留在 `shared`。只有用外部工具绕过 Wharf 直接写盘、或跨文件系统（硬链接不支持）时才会出现 `diverged` / 副本，并通过 `sync_to_drive` 重新合并回一份。

---

## 2. 快速开始

### Docker（推荐）

```bash
docker compose up -d --build
```

默认映射宿主机 `8686` → 容器内 `8787`（宿主机 8787 常被其他服务占用），数据落在 `./data`。首次启动会在日志里打印**带令牌的入口地址**：

```
Web 界面    : http://localhost:8686
带令牌入口  : http://localhost:8686/?token=wharf_xxxxxxxx
```

打开带令牌链接即可，令牌会存进浏览器 localStorage，地址栏随即被清理。

### 本地开发

```bash
npm install
npm start          # 或 npm run dev（node --watch）
```

需要 Node.js 18+（推荐 22/24）。

### 预构建镜像（GHCR）

仓库内置 [.github/workflows/docker.yml](.github/workflows/docker.yml)，每次推送 `main` 会自动构建 `linux/amd64` + `linux/arm64` 双架构镜像：

```bash
docker login ghcr.io                     # 包默认私有，用自己的 GitHub 账号登录
docker pull ghcr.io/xkx121029/wharf:latest
```

### 在 NAS 上本地构建

```bash
docker buildx build --platform linux/arm64 -t wharf:arm64 --load .
# 或直接构建到目标机器
docker buildx build --platform linux/arm64 -t wharf:arm64 --push .
```

NAS 上运行：

```bash
docker run -d --name wharf \
  -p 8686:8787 \
  -v /volume1/docker/wharf/data:/data \
  -e TZ=Asia/Shanghai \
  -e PUBLIC_URL=http://192.168.2.x:8686 \
  --restart unless-stopped \
  wharf:arm64
```

> `PUBLIC_URL` 只影响日志里打印的入口地址和 `download_link` 工具生成的链接，不影响监听。

---

## 3. 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `DATA_DIR` | `./data` | 数据根目录（容器内 `/data`） |
| `AUTH_TOKEN` | 自动生成 | 访问令牌；留空则读取/生成 `<DATA_DIR>/.token` |
| `PUBLIC_URL` | 空 | 对外地址，用于生成下载链接 |
| `MAX_TEXT_BYTES` | `2 MiB` | 单次读取文本上限，超出截断 |
| `MAX_UPLOAD_BYTES` | `512 MiB` | 单文件上传上限 |
| `MAX_IMPORT_BYTES` | `64 MiB` | `import_url` 抓取上限 |
| `TZ` | 容器默认 | 建议 `Asia/Shanghai` |

数据目录结构：

```
data/
├── drive/          # 网盘
├── workspace/      # 工作区
├── tmp/            # 上传中转，自动清理
├── activity.jsonl  # 活动事件流（超过 8 MiB 自动轮转）
└── .token          # 自动生成的访问令牌
```

---

## 4. 把 AI 接进来

所有端点在 `http://<host>:8787`，认证统一使用：

```
Authorization: Bearer <令牌>
```

> 详细的请求/响应示例见 [docs/API.md](docs/API.md)。

### MCP

Streamable HTTP，无状态，`POST /mcp`，协议版本 `2025-06-18` / `2025-03-26` / `2024-11-05`。

```json
{
  "mcpServers": {
    "wharf": {
      "type": "http",
      "url": "http://192.168.2.x:8787/mcp",
      "headers": { "Authorization": "Bearer wharf_xxxx" }
    }
  }
}
```

16 个工具：`vault_overview`、`list_items`、`search_items`、`stat_item`、`read_file`、`write_file`、`create_folder`、`move_to_workspace`、`publish_to_drive`、`sync_to_drive`、`release_to_drive`、`rename_items`、`delete_items`、`copy_item`、`import_url`、`download_link`。

### ACP

两种形态都提供：

- **JSON-RPC（Agent Client Protocol 风格）**：`POST /acp`，方法 `fs/read_text_file`、`fs/write_text_file`、`fs/list_directory`、`fs/stat_item`、`fs/search`、`fs/create_folder`、`fs/rename_items`、`fs/delete_items`、`fs/move_to_workspace`、`fs/publish_to_drive`、`fs/sync_to_drive`、`fs/release_to_drive`。路径默认相对工作区，也接受 `/data/workspace/...` 绝对写法。
- **REST（Agent Communication Protocol 风格）**：`GET /acp/agents`、`POST /acp/agents/wharf-workspace/runs`、`GET /acp/runs`、`GET /acp/runs/:id`。

```bash
curl -s http://192.168.2.x:8787/acp \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"fs/list_directory","params":{"path":"/"}}'
```

### 规划中的典型工作流

```text
AI 收到任务
  ├─ list_items (drive)          看一眼网盘有什么
  ├─ move_to_workspace           把要改的文件硬链接进工作区
  ├─ read_file / write_file      在工作区里读写
  ├─ rename_items / delete_items 批量整理
  └─ publish_to_drive 或 sync_to_drive
                                 收工，把成果写回网盘
```

---

## 5. 界面

四个区域：左侧区域切换与占用统计、中间文件表、右侧「AI 动态」、底部统一抽屉。

- **AI 动态**不是日志流：服务端把事件合并成人类可读的句子，例如「把 3 个文件移到了工作区」「删除了 2 个条目（只删除了网盘的视图，文件内容仍在工作区）」，点击卡片里的文件名可直接跳到对应位置。
- 所有弹窗都是页面内的底部抽屉，不使用系统 `alert` / `confirm`。
- 上传支持拖拽与进度条；下载走 `/api/fs/download`，链接自带令牌，可直接粘到浏览器或下载器。

---

## 6. 安全

- 除 `/api/health` 与静态页面外，所有接口都需要 Bearer 令牌；比较使用 `timingSafeEqual`。
- 路径统一规范化，拒绝 `..` 与越界。
- `import_url` 拒绝 `localhost`、`127.*`、`10.*`、`172.16-31.*`、`192.168.*`、`169.254.*` 等内网与保留地址，防 SSRF。
- 下载令牌可以出现在 URL query 中，方便直接下载；因此**不要把这个链接发给不受信任的人**。
- 容器以非 root 用户 `node` 运行。

---

## 7. 已知边界

- 硬链接依赖同一文件系统。`drive` 与 `workspace` 若被挂到不同卷，会自动降级为复制副本，状态显示为 `diverged`，需要 `sync_to_drive` 合并。
- 目录的「共用」是逐文件判断的：目录本身是两边各自创建的同名目录，内部文件才是硬链接。
- ACP REST 的 runs 保存在内存中（上限 200 条），容器重启即清空。
- 活动流保存在内存环形缓冲 + `activity.jsonl`，最多回溯 2500 条。

---

## 8. 开发

```
server/
  config.js    环境与目录
  store.js     双视图存储核心（硬链接、分叉合并、批量改名）
  activity.js  事件缓冲、中文标题、SSE
  api.js       REST 文件接口
  tools.js     MCP 工具定义与调度
  mcp.js       MCP JSON-RPC 传输
  acp.js       ACP JSON-RPC 与 REST
  index.js     入口
public/
  index.html / app.css / app.js
docs/
  API.md       全部接口的独立文档
```

## License

MIT
