# 在线 VWI 发布系统

产线工位**可视化作业指导书（VWI, Visual Work Instruction）**的在线发布与下发系统。
一台 PC 作服务器，每个工位一台安卓主机，内容在服务器统一编辑、发布，工位端自动同步并循环播放。

> 独立自研项目。**不基于任何第三方产品的代码**，内容模型、发布机制、下发协议均为本项目的自主设计。

---

## 一、设计出发点

工位屏幕不是播放器，是**作业依据**。所以这套系统的重点不在"能不能播视频"，而在四件事：

| 要求 | 本项目的做法 |
|---|---|
| 内容必须结构化 | 页（Page）+ 块（Block）模型，不是时间轴节目单 |
| 改了不能立刻影响现场 | **草稿态 / 发布态分离**，现场只看不可变快照 |
| 断网必须继续播 | 终端全量缓存，按版本号判断是否更新 |
| 变更必须可回溯 | 发布单不可变，回滚 = 指针回指旧版本 |

### 与其他做法的主要差异

| 维度 | 常见做法（时间轴播控类系统） | 本项目 |
|---|---|---|
| 内容单位 | 素材 + 节目单，按时间轴播 | 页 + 块，按工位职责组织 |
| 版本 | 无版本概念，改了就是改了 | 发布单不可变，seq 单调递增 |
| 下发 | 推整个节目包 | manifest + sha256 差量，只下本地缺的文件 |
| 日志 | 按天建物理表，N 天 N 次查询 | 单表 + 时间索引，异步批量写 |
| 导出 | 异步线程 + 落盘 + 轮询 | 流式直出，不落盘不排队 |
| 授权 | 加密狗 | 不需要；如需商用可加 Ed25519 离线许可证 |

---

## 二、当前状态

**v1.0.0 — 服务端 P0 已完成，可通过接口跑通全链路。**

| 模块 | 状态 |
|---|---|
| 内容树（产线 / 看板 / 页 / 块） | ✅ 已实现 |
| 媒体仓库（sha256 内容寻址、签名 URL、Range） | ✅ 已实现 |
| 发布与版本（发布、回滚、灰度、吊销） | ✅ 已实现 |
| 终端令牌与工位清单拉取 | ✅ 已实现 |
| 心跳与在线状态 | ✅ 已实现 |
| 管理端 Web 界面 | ⬜ 未开始 |
| 工单（建单 / 开工锁版 / 报工） | ⬜ 未开始 |
| 播放日志、统计、报表导出 | ⬜ 未开始 |
| 安卓工位端 App | ⬜ 未开始 |

> **本期无登录、无角色。** 这是刻意的取舍（见 `docs/01-服务端规划.md` 2.1）。
> 因此有一条硬性约束：**服务端只能跑在车间内网，不得做端口映射到公网。**

---

## 三、快速启动

要求：**Node.js ≥ 22.5**（依赖内置 `node:sqlite`，不需要任何 npm 包）。

```bash
cd 在线VWI发布项目
node server.js --port=8091
```

首次启动会自动建库并写入演示数据（产线 `L01`，工位 `OP10 / OP30 / OP50`），数据落在 `data/` 目录。

```bash
curl http://127.0.0.1:8091/api/health
```

### 让一台终端跑起来

```bash
# 1. 取工位 id
curl "http://127.0.0.1:8091/api/stations"

# 2. 为工位签发终端令牌（返回的 token 写进终端配置）
curl -X POST "http://127.0.0.1:8091/api/stations/<stationId>/token"

# 3. 终端拉取本工位的内容清单
curl "http://127.0.0.1:8091/display/manifest?code=L01-OP30&token=<token>"
```

清单里带 `seq`（发布版本号）和 `digest`（内容摘要）。终端只要比对这两个值，就知道要不要重新拉取。

---

## 四、目录结构

```
在线VWI发布项目/
├─ server.js              入口：HTTP 服务、静态资源、媒体流、路由分发
├─ src/
│  ├─ db.js               SQLite 建表、种子数据、索引
│  ├─ model.js            内容契约：5 种版式、11 种块、槽位校验、发布预检
│  ├─ media.js            媒体仓库：sha256 内容寻址、HMAC 签名 URL、Range
│  ├─ router.js           轻量路由：路径参数、终端令牌鉴权、统一错误
│  ├─ util.js             时间、ID、清洗、JSON 解析
│  └─ api/
│     ├─ content.js       产线、看板、页、块、工位、令牌
│     ├─ mediaApi.js      上传、列表、回收
│     ├─ release.js       发布、回滚、灰度、吊销
│     └─ display.js       终端专用：清单、心跳
├─ data/                  运行期数据（已 gitignore）：db、媒体、签名密钥
└─ docs/
   └─ 01-服务端规划.md      服务端完整规划：板块、数据表、接口、约束
```

---

## 五、核心模型

### 内容层级

```
产线 Line ─┬─ 看板 Board ─── 页 Page ─── 块 Block
           └─ 工位 Station ──(引用)──> 看板
```

**为什么看板要单独一层**：一条线上多个工位常常共用同一份内容（线首安全提示、共用的检验标准）。
把看板抽出来，改一次即可覆盖多台工位；把内容直接挂在工位上，就会退化成"改十次"。

### 版式与块

- **5 种版式**：`step-focus`（步骤主视 + 侧栏）、`split`（左右分栏）、`stack`（纵向堆叠）、
  `video-focus`（视频主视 + 脚注）、`grid`（四宫格）
- **11 种块**：标题、正文、图片、视频、参数、警示（L1/L2/L3）、清单、二维码、时钟、倒计时、分隔

服务端只校验"这个块能不能放进这个版式的槽位"，**不生成任何图片**。渲染完全交给终端。

### 发布单

发布时把整条线的看板内容压成一份 manifest 存进 `release` 表，**写入后不可修改**。改动就是新发一版。

- `seq` 单调递增 → 终端据此判断新旧，也天然防重放
- 回滚 = 把产线的活跃发布指针指回旧的 `seq`，**不重新生成**
- 灰度 = 先把单台工位指向新发布单，验证后再整线切换

### 媒体仓库

按 `sha256` 内容寻址存储，同一文件只存一份。访问走 HMAC 签名 URL，链接过期即失效。
必须支持 `Range`，否则视频无法拖动，断点续传也无从实现。

---

## 六、已实现的接口

```
GET    /api/health                    健康检查
GET    /api/meta                      版式、块类型、槽位等契约元数据

GET    /api/lines                     产线列表（含活跃版本、工位数）
POST   /api/lines                     新建产线
PUT    /api/lines/:id                 修改产线
DELETE /api/lines/:id                 删除产线

GET    /api/lines/:id/boards          看板列表
GET    /api/boards/:id                看板详情（含所有页与块）
POST   /api/boards                    新建看板
PUT    /api/boards/:id                修改看板
DELETE /api/boards/:id                删除看板
PUT    /api/boards/:id/pages          整批保存页与块

GET    /api/stations                  工位列表
POST   /api/stations                  新建工位
PUT    /api/stations/:id              修改工位
DELETE /api/stations/:id              删除工位
GET    /api/stations/:id/token        查询工位令牌状态
POST   /api/stations/:id/token        签发 / 重置令牌
DELETE /api/stations/:id/token        吊销令牌

POST   /api/media/upload              流式上传（自动算 sha256 去重）
GET    /api/media                     媒体列表
GET    /api/media/:id                 媒体详情
POST   /api/media/gc                  回收未被引用的媒体

GET    /api/releases                  发布历史
GET    /api/releases/:id              发布单详情
POST   /api/releases                  发布新版本
POST   /api/releases/:id/rollback     回滚到该版本
POST   /api/releases/:id/revoke       吊销该版本
POST   /api/releases/:id/gray         加入灰度
DELETE /api/releases/:id/gray/:sid    移出灰度

GET    /display/manifest              终端拉取本工位清单（令牌鉴权）
POST   /display/heartbeat             终端心跳（令牌鉴权）
GET    /m/:id                         媒体流（签名 + Range）
```

---

## 七、数据表

| 分组 | 表 |
|---|---|
| 内容 | `line` `board` `page` `station` |
| 发布 | `release` |
| 媒体 | `media` |
| 终端 | `station_token` |
| 预留 | `workorder` `play_log` `event_log` `command` |

`page.blocks` 存 JSON 一列，不单独建表 —— 块永远整页一起读写，拆表只会让每页变成 N 次查询。

---

## 八、路线图

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0**（已完成） | 内容树 + 媒体 + 发布 + 终端拉取 | 工位能拉到清单，重发后取到新 `seq` |
| **P1** | 管理端界面 + 工单 + 日志统计 + 报表导出 | 改一页 → 发布 → 工位 30 秒内生效；能导出报表 |
| **P2** | 安卓工位端 App（Kotlin + ExoPlayer） | 断网继续播，开机自启，崩溃自恢复 |
| **P3** | SSE 实时通知、备份自动化、离线许可证 | 发布后 2 秒内终端收到通知 |

---

## 九、边界：明确不做的事

划这条线是为了避免项目被拖成半个 MES。

- ❌ 不做 MRP、排产、BOM 展开、物料齐套
- ❌ 不做 SN 级全流程追溯（只做"工单 → 工序 → 内容 → 报工数量"）
- ❌ 不做视频转码（格式由工程部按规范产出：1080p / H.264 / ≤4Mbps）
- ❌ 不做多租户、不做公网部署
- ❌ 不用 WebSocket（P3 用 SSE 足够，少一个依赖）
- ❌ 不接加密狗

---

## 十、许可

内部项目，暂未选定开源许可。
