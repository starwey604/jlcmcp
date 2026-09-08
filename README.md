# jlceda-mcp-server（官方栈迁移版）

嘉立创 EDA MCP Server — 让 AI 编程助手直接操控嘉立创 EDA 专业版的 PCB/原理图自动化工具集。

**v1.0 已完整迁移到官方 JLC AI 栈**：不再依赖自研 WebSocket 协议与自研插件，改为
[Run API Gateway 扩展](https://github.com/easyeda/eext-run-api-gateway)（EDA 侧）
+ [easyeda-api-skill](https://github.com/easyeda/easyeda-api-skill) Bridge Server（协议侧）。
MCP Server 把每个工具动作编译成 eda.* 官方 API 代码，通过官方 Bridge Server 在 EDA 内执行。

## 架构

```
AI IDE ──stdio(MCP)──> mcp-server ──HTTP /execute──> 官方 Bridge Server(49620-49629)
                                                        │ WS /eda（握手 easyeda-bridge）
                                                        ▼
                                               Run API Gateway 扩展 ──> 嘉立创EDA专业版
```

- MCP server（本仓库）通过 stdio 与 AI IDE 通信；
- 官方 Bridge Server（scripts/bridge-server.mjs，来自 easyeda-api-skill）自动发现/拉起，
  监听端口 49620-49629，单例运行；
- Run API Gateway 扩展在嘉立创EDA专业版内自动扫描端口并连接（需在扩展管理器中勾选
  **允许外部交互**），接收 execute 消息以 new AsyncFunction('eda', code) 执行。

## 前置条件

- Node.js >= 18（建议 22 LTS）
- 嘉立创EDA专业版 V3.2+
- 在嘉立创EDA中安装官方 **Run API Gateway** 扩展：
  - 扩展广场：https://jlcext.com/item/oshwhub-official/run-api-gateway
  - 源码：https://github.com/easyeda/eext-run-api-gateway
  - 安装后在 高级 → 扩展管理器 → Run API Gateway → 配置 勾选 **允许外部交互**
- （可选）官方 easyeda-api skill：https://github.com/easyeda/easyeda-api-skill

## 安装 & 构建

```bash
npm install
npm run port         # 修改 handlers.ts / routing-geometry.ts 后重新生成模板并做语法自检
npm run build        # tsc 编译
npm run start:bridge # （可选）手动启动官方 Bridge Server；MCP server 也会自动拉起
npm run test:bridge  # 端到端协议冒烟测试（无需真实 EDA，内置 mock）
```

## 配置

在项目目录创建 .mcp.json：

```json
{
  "mcpServers": {
    "jlceda": {
      "command": "node",
      "args": ["<path-to>/jlceda-mcp-server/dist/index.js"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

首次使用时先启动 Bridge Server（或让 MCP server 自动拉起），并在嘉立创EDA中确认
Run API Gateway 扩展已连接（顶部菜单出现 **API Gateway**）。

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| GATEWAY_BASE_URL | 自动扫描 | 显式指定官方 Bridge Server 地址（如 http://127.0.0.1:49620） |
| AUTO_SPAWN_BRIDGE | true | 未发现 Bridge Server 时自动拉起 scripts/bridge-server.mjs |
| BRIDGE_SERVER_PATH | scripts/bridge-server.mjs | 自定义 Bridge Server 路径 |
| KILL_BRIDGE_ON_EXIT | 0 | 退出时是否结束自拉起的 Bridge Server（官方单例共享，默认不结束） |
| ANTHROPIC_API_KEY | — | Anthropic API Key（设置后启用 pcb_agent 工具） |
| AGENT_MODEL | claude-sonnet-4-20250514 | Agent 使用的模型 |

## 工具清单（60 个）

### 状态查询 (9)
pcb_get_state / pcb_screenshot / pcb_run_drc / pcb_get_tracks / pcb_get_pads
pcb_get_net_primitives / pcb_get_board_info / pcb_get_feature_support / pcb_ping

### 元件操作 (6)
pcb_move_component / pcb_relocate_component / pcb_batch_move / pcb_select_component
pcb_delete_selected / pcb_create_component

### 走线 / 过孔 (5)
pcb_route_track / pcb_check_route_geometry / pcb_check_route_endpoints / pcb_create_via / pcb_delete_tracks / pcb_delete_via

默认角度约束、转角整理、预览参数及验证范围见 [走线路径约束与整理](docs/routing-geometry.md)。

### 铺铜 / 禁布区 (4)
pcb_create_copper_pour / pcb_delete_pour / pcb_create_keepout / pcb_delete_keepout

### 丝印 (3)
pcb_get_silkscreens / pcb_move_silkscreen / pcb_auto_silkscreen

### 高级约束 (6)
pcb_create_diff_pair / pcb_list_diff_pairs / pcb_delete_diff_pair
pcb_create_equal_length / pcb_list_equal_lengths / pcb_delete_equal_length

### 原理图 / 文档 (4)
sch_get_state / sch_get_netlist / sch_run_drc / pcb_open_document

### PCB Agent (1，需 ANTHROPIC_API_KEY)
pcb_agent — 智能 Agent，自主编排多步操作完成复杂任务

### 计算工具 (2)
calc_impedance / calc_trace_width

### 官方 Bridge 运维 (4，v1.0 新增)
pcb_bridge_status — Bridge Server 健康状态（EDA 连接数/活动窗口）
pcb_list_eda_windows — 列出所有已连接 EDA 窗口
pcb_select_eda_window — 选择活动 EDA 窗口（多开时指定目标）
pcb_execute_code — 在 EDA 内直接执行任意 eda.* 官方 API 代码（高级/调试）

> 坐标单位均为 mil。pcb_execute_code 与官方 easyeda-api-skill 用法一致：
> 代码以 return await eda.dmt_Project.getCurrentProjectInfo(); 形式返回结果。

### 高级功能 (6，v1.1 新增)
pcb_bom_export — 导出 PCB BOM（JSON + CSV，按元件名聚合数量/位号/网络）
pcb_net_connectivity_check — 网络连通性检查（标记未布线/单焊盘网络）
pcb_current_density_report — 各网络载流能力估算（IPC-2221），标记偏低网络
pcb_fanout_component — 在指定元件带网络焊盘中心创建通孔（盘中过孔模式，需工艺支持）
pcb_auto_route_nets — 默认水平/垂直/45°连接草稿，整理直角并复查障碍；可 dryRun，分别报告几何检查及 DRC
pcb_drc_autofix — DRC 自修复（当前支持丝印冲突自动排列），返回修复前后对比

### 高级功能 v2 (4，v1.2 新增)
pcb_component_clearance_check — 元件两两间距检查，标记低于阈值的违规对
pcb_route_differential_pairs — 差分对双网连接草稿，保持焊盘端点并报告实际长度；不保证恒定间距或等长
pcb_design_health_report — 一键设计健康报告（BOM+连通性+载流+DRC+间距，READY/NEEDS_WORK/POOR 评分）
pcb_auto_fanout_and_route — 流水线：全部元件扇出 → 全部网络自动布线 → DRC → 丝印自修复

### 高级功能 v3 (4，v1.3 新增)
pcb_auto_place_components — 元件原点对齐自身焊盘质心；不提供按网络或拥挤度优化的自动布局
pcb_netlist_report — 从 PCB 焊盘生成网表报告（元件→引脚→网络 / 网络→元件）
pcb_design_snapshot / pcb_design_diff — 设计快照与差异对比（新增/移除/移动）
pcb_auto_route_nets 升级 — 单层障碍规避布线（绕开焊盘+clearance）或两层 L 型（useVias）
pcb_bom_export 升级 — 支持 lcscCodes 料号映射（LCSC API 受保护无法自动查询）

### 高级功能 v4 (3，v1.4 新增)
sch_generate_from_netlist — 提交客户端异步网表导入；verifyOnly=true 仅回读验证，不能自动增删元件或重建导线
sch_generate_from_pcb — 导出 PCB 官方网表，打开并保留关联原理图页；支持仅验证，不保证自动画图
pcb_eprj3_project_info — .eprj3 工程检查器（目录/文件：索引、原理图/PCB/面板清单、源文件记录统计）

原理图导入的 `status: "submitted"` 只表示请求已提交，返回 `ok: false, verified: false, changed: null`，不代表导入完成。LCEDA 3.2.186 的接口会异步显示“确认导入信息”；检查该窗口与客户端日志，界面操作完成后再次调用 `sch_generate_from_netlist`，传入相同网表、返回的 `pageUuid` 和 `verifyOnly: true`，即可只读验证。`sch_generate_from_pcb` 的仅验证模式需从 PCB 页调用，会打开关联原理图比较当前 PCB 网表。`pageUuid` 可指定关联原理图内的目标图页。

网表一致时返回 `unchanged`（无需导入）或 `verified`（仅验证成功）；不一致返回 `mismatch`。Protel2 验证包含所有元件属性和网络引脚，`logicalContentMatches` 仅比较位号、封装、型号和连接，不能单独作为成功依据。其余格式比较规范化换行后的文本。当前客户端的原理图导入比较器只处理元件属性；元件集合不匹配会中断，也不能据此重建网络连接。详细实机证据见 [LINUX-LIVE-TEST.md](LINUX-LIVE-TEST.md)。

## 项目结构

```
├── src/
│   ├── index.ts            # MCP 入口（stdio）
│   ├── gateway-client.ts   # 官方 Bridge Server HTTP 客户端（发现/拉起/execute）
│   ├── bridge-client.ts    # 工具层接口（command(action, params)），基于 gateway-client
│   ├── codegen.ts          # 动作 → eda 代码编译（含 ping/select/delete 内联实现）
│   ├── codegen/generated.ts# 自动生成：32 个经典动作的代码模板（npm run port）
│   ├── agent.ts            # pcb_agent（Anthropic tool-use 循环）
│   ├── calculators.ts      # 阻抗/线宽计算
│   └── tools/              # 工具注册（state/components/routing/copper/silkscreen/advanced/schematic/gateway...）
├── scripts/
│   ├── bridge-server.mjs   # 官方 Bridge Server（vendored from easyeda/easyeda-api-skill）
│   ├── port-plugin.mjs     # legacy 插件 → codegen 模板移植工具
│   └── smoke-bridge.mjs    # 端到端协议冒烟测试（mock EDA，无需真实 EDA）
├── legacy-jlc-bridge/      # v0.1 自研插件（已弃用，仅存档）
└── package.json
```

## 验证

```bash
npm run build
npm run test:bridge   # 80 项协议级检查（无需 EDA）
npm run test:regressions # 缺陷、端点和生成处理器回归测试（无需 EDA）
```

冒烟测试发现已有 Bridge 时会退出，避免操作真实 EDA。Linux 上可以在隔离网络中测试，保持真实连接在线：

```bash
unshare --user --map-root-user --net --pid --fork --mount-proc sh -c 'ip link set lo up && npm run test:bridge'
```

真实 CachyOS / LCEDA 3.2.186 的结果及功能限制见 [LINUX-LIVE-TEST.md](LINUX-LIVE-TEST.md)。

`pcb_fanout_component` 和 `pcb_auto_route_nets` 的过孔默认孔径为 12 mil、外径为 22 mil，可通过 `viaDrill` / `viaDiameter` 按工程规则调整。自动布线按所选外径检查过孔障碍；这些默认值不替代当前工程的 DRC。

官方 API 兼容修复放在 `src/codegen/handlers.ts`，生成器优先使用这些函数覆盖旧插件模板。修改后运行 `npm run port && npm run build`；不要只修改 `generated.ts`，否则重新生成时会丢失。

阻抗计算使用 [TI SLLU319 的近似模型](https://www.ti.com/lit/ug/sllu319/sllu319.pdf)，带状线几何参照 [ADI 图 7-118](https://www.analog.com/media/en/training-seminars/design-handbooks/P2%20Ch7_final.pdf)。`height` 在微带线中表示走线到参考平面的距离，在中心带状线中表示上下参考平面之间的总间距；超出对数公式正值范围会报错。载流报告按 IPC-2221 的最弱走线段估算，默认 1.4 mil 铜厚、10°C 温升，不把串联线段宽度相加。它们用于初步估算，不能代替板厂叠层及制造校核。

## 迁移说明（v0.1 → v1.0）

- EDA 侧：自研 jlc-bridge 插件 → 官方 **Run API Gateway** 扩展（无需维护插件代码）
- 协议侧：自研 ws://127.0.0.1:18800/ws/bridge → 官方 Bridge Server（49620-49629，握手校验）
- 工具侧：35 个动作处理器原样移植为官方 eda.* 代码模板（scripts/port-plugin.mjs 生成），
  MCP 工具接口与 v0.1 完全兼容
- 新增：pcb_bridge_status / pcb_list_eda_windows / pcb_select_eda_window / pcb_execute_code

## License

MIT
