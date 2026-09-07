# CachyOS / 嘉立创 EDA 真实连接测试

测试日期：2026-09-07。环境：CachyOS x86_64、lceda-pro-bin 3.2.186-1、EDA 3.2.186、Node.js 26.8.1、jlcmcp 1.4.0。

结论：MCP → Bridge → Linux EDA 链路可以运行，主要兼容问题已修复；客户端重启后，DRC 与连通性检查已完成实机验证。PCB → 原理图自动生成仍未成功，不能认定所有高级功能均正常。

## 提交基线后的继续排查（2026-09-07，最新状态）

按用户要求，先以本机 Git 身份 `WindWeaver <moonbite233@gmail.com>` 提交当时全部更改：`8358366 fix: restore LCEDA desktop MCP compatibility and validate automation`。以下排查和修复发生在该提交之后。

### 原理图导入的实际行为

本机 UI 包 `/opt/lceda-pro/resources/app/assets/pro-ui/3.2.181.db96fbff/js/ui.js` 的调用链为 `SCH_Netlist.setNetlist → Yre → qMe → import-netlist`。`Yre` 没有等待 `qMe`，后者异步比较数据并打开“确认导入信息”。因此 setter 返回不代表用户界面已应用修改。实测 setter 刚返回时窗口尚未出现，3 秒后的 DOM 已能读取到该窗口。

此外，原理图导入使用的 `JGe.compare()` 在元件键集合不同的情况下中断并显示需要手动修改的提示；集合相同时只调用元件属性比较，没有调用网络连接比较。Protel2 解析器以位号作为匹配键，测试原理图导出的 Unique ID 为 `gge1/gge2`；这条路径存在匹配差异。实机 PCB 导入时确实出现“原理图 Schematic2 和 网表 部分差异需要手动修改”的提示，确认窗口没有变更行。

这修正了前次记录中“beta setter 无效”的过度概括：**存在异步界面流程和原理图导入能力限制，不能把立即回读不变解释成同步写入失败，也不能把原样写回后相同解释成已验证 setter 能修改设计。** 当前接口不能当作 PCB 自动生成原理图的实现。

### 本轮修复与验证

- `sch_generate_from_netlist` 返回 `submitted / unchanged / verified / mismatch`，仅提交导入时明确 `ok=false, verified=false, changed=null`，不进行过早的完成判定。
- 新增 `verifyOnly`，用于界面导入完成后的独立只读比较；`pageUuid` 检查目标图页。相同内容直接返回 `unchanged`，不再弹出多余窗口。
- Protel2 验证包含所有元件属性，避免只改 Value 或 Unique ID 时误报成功；空白目标原理图可正常返回不匹配。`logicalContentMatches` 只表示位号、封装、型号和连接相同，不能替代完整验证。
- PCB 导入保留关联原理图页，避免 setter 返回后立即切回 PCB。可用 `pageUuid` 选择关联原理图内的目标图页，也支持仅比较模式。
- 从导入格式列表移除客户端导入分支未处理的 `DSNET`。

TypeScript 构建通过，**31/31 缺陷回归通过**。真实 MCP 调用也验证了相同内容不弹窗、属性差异不会误报成功、只读验证不提交导入、PCB 提交后保留正确目标页，并观察到客户端异步确认窗口。测试结束取消了本轮窗口，完整属性和网络回读与测试前一致，已返回测试 PCB；当时 Bridge 为 1 个在线窗口、0 个待处理请求。

本轮未修改 Bridge；基线提交已有 80/80 隔离 Bridge 检查通过的记录。新增实机证据保存于 `/tmp/jlcmcp-live-20260907/import-fixed-live.log`、`import-fixed-before.txt`、`import-fixed-after.txt`、`import-ui-*.json` 和累计 `results.jsonl`。

### 仍未解决的格式导出超时

再次显式调用 `sch_Netlist.getNetlist('JLCEDA')`，仍在 30 秒超时；Protel2 可正常导出。本机 SDK 的 JLCEDA/EasyEDA 分支会额外逐元件调用 `/PrjDB/footprint/getDisplayTitleById`，而 Protel2 分支没有这一步。

诊断时，直接对测试原理图调用本机 UI 使用的 `sch/getSpecifiedTypeNetlistBySchematicId`，**705 ms 返回完整 JLCEDA JSON**，包含两个元件、真实引脚、网络和 `FootprintName`。对 SDK 使用的同一窗口封装名称 RPC 单独执行带时限探测，**3001 ms 仍未响应**。这把问题进一步收窄到了 SDK 补全封装名称所走的消息通路；尚未修改客户端 SDK，也没有在生产工具中引入内部消息总线替代官方 API。默认继续使用 Protel2。证据为 `import-native-backend.json`、`import-native-footprint-rpc.json`，均位于上述临时证据目录。

## 客户端重启后的复测（2026-09-07，历史记录）

用户重启 LCEDA 后，Bridge 重新连接一个真实窗口；通过 API 打开原专用测试工程，继续复测上轮未完成的项目。

| 项目 | 结果 |
|---|---|
| DRC 超时 | **已恢复响应**：首次调用 1473 ms，后续调用均返回结果，没有重现 30 秒超时。重启前异常的具体根因仍未证实 |
| DRC 错误统计 | 未布线测试板返回 **5 条错误**：4 条焊盘连接错误、1 条 PCB/原理图网表不匹配；消息、网络和图元引用均可读 |
| 有走线但未接通 | 只从 R1 引出一段 MCP_P 走线时，连通性仍正确返回 `unrouted=1, trackCount=1` |
| 差分连接草稿 | 正负网络各生成 2 段、各长 1000 mil；读取和 DRC 确认 **2 个网络连通、0 条连接错误**。全板 DRC 剩 1 条网表不匹配 |
| 设计健康报告 | 正确返回 `routedNets=2, drcIssues=1, score=NEEDS_WORK`；不会因走线连通就报告整个设计已通过 |
| 双层布线与过孔 | 最初生成 4 段线、4 个过孔并确认两网连通；DRC 暴露原有固定 16 mil 外径小于本工程 19.7 mil 下限。外径修正后，又检测到孔径小于本工程 11.8 mil 下限 |
| 本轮补充修复 | 扇出和自动布线默认改为 **孔径 12 mil、外径 22 mil**；新增 `viaDrill` / `viaDiameter` 参数，过孔避障同步使用所选外径，并在写入前校验孔径/外径关系 |
| 新过孔尺寸实测 | 扇出生成的 2 个过孔，以及双层布线生成的 4 个过孔，均回读为 **12/22 mil**；尺寸违规消失。双层连接仍为 2 个网络已连通，最终 DRC 860 ms 返回唯一的网表不匹配错误 |
| 原理图网表原样写回 | 重启后仍可完成，读取验证为 `verified=true, changed=false` |
| PCB → 原理图导入 | **重启未解决**：导入后连接关系没有改变，工具明确报错；比较导入前后网表确认原测试原理图保持不变 |

“DRC 恢复正常”指检查调用、错误详情和连通性判定正常，**不等于测试板全板 DRC 通过**。测试 PCB 使用 MCP_P/MCP_N，而原理图仍是原测试连接，所以接通 PCB 后保留一条网表不匹配错误。清理测试走线后，未连接错误会按实际状态重新出现。

本轮补充修复已编译，**80 项隔离 Bridge 检查 + 25 项缺陷回归全部通过**。新增验证覆盖 MCP 过孔参数传递、默认尺寸、较大过孔的障碍预检及非法尺寸拒绝；实机验证同时覆盖未连接和已连接两种状态。

结束状态：测试工程已保存；PCB 保留原两个电阻和独立丝印，走线/过孔/差分对为 0；Bridge 一个窗口在线、待处理请求为 0。证据为 `/tmp/jlcmcp-live-20260907/restart-*.log`、相应脚本和累计 `results.jsonl`。原理图前后网表保存在 `restart-sch-before.txt`、`restart-sch-after.txt`。

## 首次修复后的复测（2026-09-07，历史记录）

以下表格记录首次修复时的状态；其中 DRC 超时已在上节的客户端重启复测中消失。后面的“初测发现”和 59 工具逐项表同样保留历史结果，供对照。

| 项目 | 本轮结果 |
|---|---|
| Bridge 窗口选择崩溃 | 修复保持有效；成功/失败选择后的健康检查与执行均有回归测试 |
| 过孔参数 | MCP 传入 `drill=16, diameter=30`，真实 API 回读孔径 **16 mil** |
| 差分对创建 | MCP `posNet/negNet` 正确映射；实机创建、列表回读、删除通过 |
| 元件选择、删除 | 使用官方选择及按图元类型删除接口；新增第三个测试电阻后选中删除，回读仍为两个原有电阻 |
| PCB 元件与焊盘信息 | 实机型号、封装、料号、外框均可读；R1 筛选返回 **2 个焊盘**，编号为 **2/1**，网表包含两元件及四个真实引脚 |
| Linux 焊盘 ID | 客户端的元件 `Pads` 返回 `e12/e13` 局部 ID；全局焊盘 ID 是元件 ID 与局部 ID 拼接。已兼容这种格式以及有 parent getter 的格式 |
| 铜层与板框 | 实机启用铜层数为 **2**，未使用的内层不会算入；没有板框时返回 `null`，不再用元件范围冒充板框 |
| 走线宽度与移动断线 | 12 mil 走线回读 **12**；移动 R1 时删除实际接触焊盘的那段线，删除数 **1** |
| 重叠检查 | R1/R2 重叠时返回 **1 处违规，gap=-45.26 mil**；已恢复两元件原位置 |
| 扇出 | R1 创建 **2 个过孔**并回读，测试后删除；当前仍是盘中过孔模式，不是通用扇出规划 |
| 原理图读取与默认网表 | 两电阻返回 **4 个引脚**；默认显式使用 Protel2，实机导出成功 |
| 原理图网表写回 | 1335 字符完整官方网表原样写回后逻辑内容一致，`verified=true, changed=false`；简化的 `[GND…]` 输入会明确拒绝 |
| PCB → 原理图 | 修复了网表内容、文档上下文和读取验证；**客户端 beta setter 仍未改变实际连接关系**，现返回错误，不能认定自动生成能力可用。回读确认原测试原理图未变化 |
| 原生源文件 | 真实 `.esch2` 文件 **96/96 条记录**解析成功，无解析错误 |
| DRC / 连通性 | 已改为展开嵌套错误并依据 EDA 连接检查判断，不再以走线数量判断已连接；离线回归通过。**本轮实机 DRC 连续 30 秒超时，尚未完成修复后的实机 DRC 验证** |
| 自动布线 | 实机在端点放置异网过孔后，正确跳过网络并生成 **0 段线**；双层样例生成 **2 段线、2 个过孔**，回读过孔坐标分别等于两端 SMD 焊盘中心。DRC 超时时保留路径信息并标为未确认连接 |
| 差分连接草稿 | 实机正负网络各 **2 段线、1000 mil**，四个端点回读均对应真实焊盘中心，无原先的 Y 偏移；本例长度差为 0，但算法不保证一般情形下恒定耦合间距或等长 |
| 计算器 | 修正带状线/差分带状线模型及反算，拒绝非正/非有限输入、超出公式范围和不可达目标；载流估算使用最弱线段，不再叠加串联线宽 |

验证：TypeScript 构建通过；隔离 Bridge 协议检查 **80/80**；缺陷回归 **23/23**。回归包含官方 getter 契约、MCP 参数传递、嵌套 DRC、孤立线段、重叠外框、堵塞路线、差分端点、换层两端过孔、空网表属性和 setter 无效等情况。

实机 DRC 超时期间，桌面处于锁屏状态，但心跳和其他 API 读写继续正常；锁屏是否导致 DRC 卡住尚未证实。未将超时算作检查通过。差分和自动布线仍是有限候选路径算法，原理图自动生成仍受官方 beta API 限制；丝印属性文字的完整支持、通用自动布局、复杂板框/铺铜与制造输出不在本轮已验证能力内。

后续实机几何回归已全部通过，测试走线、过孔和差分对均已清理，保留原两个电阻及独立丝印。BOM 回读正确聚合为两颗 `0402WGF1002TCE / R0402 / C25744`；阻抗工具在 `width=8,height=6,spacing=8` 下分别返回 10.99 Ω 和 21.8 Ω（带状线 height 按参考平面总间距），超出公式范围的输入会报错。

本轮实现位于 `src/codegen/handlers.ts`、`src/tools/pro.ts`、`src/calculators.ts` 及新增解析/几何模块；生成模板可重复生成。回归脚本为 `scripts/test-regressions.mjs`。实机证据仍保存在 `/tmp/jlcmcp-live-20260907/` 的 `fix-*` 日志及累计 `results.jsonl`。

## 方法与范围

- 通过 MCP SDK 的 stdio 客户端启动 `dist/index.js`，调用 `tools/list` 和 `tools/call`；逐项调用全部 59 个已注册工具。
- 单独创建了 `MCP 功能测试 20260907` 工程，在 PCB 和原理图中放置两个 C25744 电阻，用 MCP 操作并通过官方 API 回读核对。
- 结合实际图元、尺寸、网络、截图和 DRC 判断结果；返回 `isError: false` 不等于功能正确。
- 只有一个真实 EDA 窗口；多窗口选择中的“选择当前窗口”已验证，两个真实窗口之间的切换未覆盖。
- `pcb_agent` 未注册，本次未使用 Anthropic API Key，也未测试该可选功能。
- “通过”仅表示本次样例通过；不代表所有参数、工程规模和边界条件都通过。

## 已修复的崩溃

调用 `pcb_select_eda_window` 导致用户终端出现 `ERR_HTTP_HEADERS_SENT`，Bridge 随即退出。

根因在 `scripts/bridge-server.mjs`：先调用 `writeHead(200)`，再序列化包含未定义变量 `activeWindowId` 的对象。第一次异常被 catch 捕获后，catch 再调用 `writeHead(400)`，触发第二次异常并终止进程。

已将响应字段修正为 `activeWindowId: activeEdaWindowId`。在 `scripts/smoke-bridge.mjs` 增加五项回归检查：成功选择、选择后健康检查、选择后代码执行、拒绝不存在的窗口、失败后服务存活并保留活动窗口。模拟测试合计 **80 项通过 / 0 失败**。

模拟测试在独立 Linux 网络/PID 命名空间中运行，避免测试脚本的 mock 操作进入真实 EDA。修复后已重启 Bridge，真实窗口重新连接；再次通过 MCP 选择窗口及调用 `pcb_ping` 均成功。

## 初测发现（修复前）

| 问题 | 实测证据 | 定位 |
|---|---|---|
| 过孔孔径参数被忽略 | 传入 `drill: 16, diameter: 30`，真实过孔回读孔径为 **10 mil** | `src/tools/routing.ts` 传 `drill`，生成模板读取 `holeDiameter` |
| 差分对创建报错 | 合法 MCP 参数 `name/posNet/negNet` 返回 `name/positiveNet/negativeNet are required` | `src/tools/advanced.ts` 与模板参数名不一致 |
| 元件选择、删除不可用 | 分别返回 `select not supported`、`delete not supported`；对应 API 的类型实际为 `undefined` | `src/codegen.ts` 使用了不存在的 `selectByDesignator` / `deleteSelected` |
| 焊盘所属元件丢失 | R1/R2 实际共 4 个焊盘，返回的 `designator` 和 `parentPrimitiveId` 全为空；筛选 R1 仍返回 4 个 | `src/codegen/generated.ts` 未读取 `getState_ParentComponentPrimitiveId()` 并关联元件，且忽略工具传入的 `designator` |
| 走线宽度错误 | 创建 12 mil 走线，官方 `getState_LineWidth()` 返回 12，MCP 查询返回 **0** | 模板错误使用 `getState_Width()` |
| 间距检查漏报 | R1/R2 外框实际重叠，最小间距 20 mil 检查返回 `violationCount: 0` | 状态读取把元件宽高置为 0，后续算法基于错误尺寸计算 |
| 连通性误报 | R1 已移离原走线、R2 也未连接，仍把 MCP_P 标为 `routed` | `src/tools/pro.ts` 以“有走线段”代替电气连通判断 |
| 自动扇出和网表报告失效 | R1 明明有 2 个带网络焊盘，却返回 `padCount: 0, fanoutCreated: 0`；PCB 网表报告的 `components/nets` 均为空 | 焊盘到元件的映射丢失传导到高级工具 |
| 差分自动布线端点偏移 | 负网络焊盘 Y 为 1050/1000，生成线端点 Y 为 **1058/1008**，仍报告完成 | `src/tools/pro.ts` 对负网络路径整体加 gap，端点未保持在焊盘上；本例 gap=8 |
| DRC 摘要统计错误 | 官方结果包含 4 个连接错误，工具摘要只报 `totalCount: 1`，消息和图元 ID 为空 | 把 DRC 分组节点作为一条具体错误，没有展开嵌套列表 |
| 原理图默认网表导出超时 | 无 `type` 参数的调用两次均在 30 秒超时；明确传 `type: "Protel2"` 则成功 | 默认格式路径需继续排查，不能仅凭超时断言具体根因 |
| 实际源文件无法解析 | 从 EDA 导出的原理图源文件 96 行，检查器返回 `parsedRecords: 0` | 实际每行形如 `{"type":"DOCHEAD"}||{...}|`，不是检查器假定的单个 JSON 对象 |
| 阻抗计算缺少有效性检查 | `width=8,height=6,spacing=8` 时 stripline=-6 Ω，diff_stripline=-87.75 Ω，仍作为正常结果返回 | `src/calculators.ts` 的公式适用范围、差分模型和输入校验需要复核 |

此表记录初次测试时的问题。后续修复状态见本文开头。

## 初测逐项结果（修复前）

“有限验证”表示调用有响应，但本次没有证明其完整效果；“异常”包括显式报错、错误数据以及没有完成目标的成功响应。

| 工具 | 结果 | 说明 |
|---|---|---|
| pcb_bridge_status | 通过 | 能返回真实连接状态、窗口数和待处理请求数 |
| pcb_list_eda_windows | 通过 | 列出唯一真实窗口 |
| pcb_select_eda_window | 修复后通过 | 原先导致 Bridge 崩溃；修复后选择并继续执行成功 |
| pcb_execute_code | 通过 | 多次执行官方 API，完成上下文查询、测试工程创建和回读 |
| pcb_ping | 通过 | 真实扩展返回 pong |
| pcb_get_feature_support | 通过 | 返回能力标记；标记只说明 API 存在，不保证工具封装正确 |
| pcb_get_state | 部分异常 | 元件位置可读，但宽高为 0；板框实际是元件范围估算，代码还固定返回两层 |
| pcb_screenshot | 通过 | PCB、原理图均返回可解码 PNG；等待渲染完成后的截图能看到测试元件 |
| pcb_run_drc | 部分异常 | 能检测测试错误，但分组未展开，错误数量和详情有误 |
| pcb_get_tracks | 部分异常 | 能读取图元和坐标，12 mil 线宽被报告为 0 |
| pcb_get_pads | 部分异常 | 坐标、网络可读；归属、编号等数据缺失，按位号筛选无效 |
| pcb_get_net_primitives | 部分异常 | 能返回走线及焊盘，但线宽和焊盘位号有同样缺陷 |
| pcb_get_board_info | 部分异常 | 板名正确；PCB/原理图 UUID 为空，官方实际字段为嵌套的 pcb.uuid / schematic.uuid |
| pcb_create_component | 通过 | 两个真实库电阻成功放置，并回读确认 |
| pcb_move_component | 通过 | 移动/旋转成功，快照差异及实际坐标可验证 |
| pcb_batch_move | 通过 | 两个测试元件批量移动成功 |
| pcb_relocate_component | 异常 | 元件移动，但未清除原先连接该元件的走线；返回删除数 0 |
| pcb_select_component | 异常 | 使用不存在的官方 API，返回 select not supported |
| pcb_delete_selected | 异常 | 使用不存在的官方 API，返回 delete not supported |
| pcb_route_track | 通过 | 两段路径生成真实 12 mil 走线，官方 API 回读一致 |
| pcb_create_via | 部分异常 | 过孔创建成功，但 drill=16 被忽略，实际生成 10 mil 孔径 |
| pcb_delete_via | 通过 | 删除后官方查询返回 null |
| pcb_delete_tracks | 通过 | 删除后走线列表为空 |
| pcb_create_copper_pour | 通过 | 创建真实铺铜图元；未认证铺铜计算结果或制造输出 |
| pcb_delete_pour | 通过 | 删除成功，最终铺铜图元数为 0 |
| pcb_create_keepout | 通过 | 创建真实禁布区图元；未逐项验证所有禁布规则 |
| pcb_delete_keepout | 通过 | 删除成功，最终区域图元数为 0 |
| pcb_get_silkscreens | 部分可用 | 能读独立创建的文字；本次未返回元件自身的 R1/R2 位号文字 |
| pcb_move_silkscreen | 通过 | 独立文字移动和旋转后回读 x=1200、y=1300、rotation=90 |
| pcb_auto_silkscreen | 有限验证 | 能执行，但测试文字被跳过，moved=0；自动整理效果未证实 |
| pcb_create_diff_pair | 异常 | MCP 层参数名与执行模板不一致 |
| pcb_list_diff_pairs | 通过 | 用正确官方 API 建立测试差分对后，能读出名称与两个网络 |
| pcb_delete_diff_pair | 通过 | 删除真实测试差分对后再次查询为空 |
| pcb_create_equal_length | 通过 | 成功建立两个测试网络的等长组 |
| pcb_list_equal_lengths | 通过 | 组名、网络成员可读；未验证颜色显示 |
| pcb_delete_equal_length | 通过 | 删除后查询为空 |
| pcb_open_document | 通过 | PCB 与原理图间切换，并核对当前文档 UUID |
| sch_get_state | 部分异常 | 能读元件和导线；两个电阻实际有 4 个引脚，但 pins 为空，库信息也缺失 |
| sch_get_netlist | 部分可用 | Protel2 导出成功；缺省格式两次超时 |
| sch_run_drc | 通过 | 对测试原理图返回 passed=false；工具仅提供布尔值 |
| calc_impedance | 异常 | 微带线计算及 50 Ω 反算有结果，但带状线/差分带状线可返回负阻抗而不报错 |
| calc_trace_width | 通过 | 1 A 示例外层 11.64 mil、内层 30.28 mil；仅验证代码所用公式计算，不作生产设计认证 |
| pcb_bom_export | 部分可用 | 能统计两个元件及网络，但名称返回字面表达式 =\{Value\}，无法可靠按真实物料聚合 |
| pcb_net_connectivity_check | 异常 | 把存在孤立走线的未连通网络标成 routed |
| pcb_current_density_report | 异常 | 受线宽读取为 0 影响，载流能力报告为 0；代码还把各段宽度相加，不能当作可靠载流校核 |
| pcb_fanout_component | 异常 | R1 的真实焊盘存在，但工具认为无焊盘，未创建过孔 |
| pcb_auto_route_nets | 部分可用 | 单层模式生成真实线段；本次与既有走线出现 DRC 间距错误，不能当作已完成可用布线；双层模式未覆盖 |
| pcb_drc_autofix | 有限验证 | 能返回前后 DRC，但 fixedCount=0；没有证明能自动解决实际问题 |
| pcb_component_clearance_check | 异常 | 两元件外框重叠时仍报告 0 违规 |
| pcb_route_differential_pairs | 异常 | 生成线段，但负线端点被整体偏移 8 mil，未正确终止于焊盘中心 |
| pcb_design_health_report | 异常 | 能生成报告，但继承错误的连通性、间距、线宽和 DRC 摘要结果 |
| pcb_auto_fanout_and_route | 部分异常 | 流程执行、布线生成；扇出数 0，最终 DRC 仍失败 |
| pcb_auto_place_components | 异常 | 焊盘归属缺失导致本例两元件均没有进入有效处理，moved=0 |
| pcb_netlist_report | 异常 | 真实 PCB 有两个带网络电阻，却返回空 components/nets |
| pcb_design_snapshot | 通过 | 建立包含 R1/R2 的基线 |
| pcb_design_diff | 通过 | 正确检测 R1 从 (1000,1000) 移到 (1100,1100) |
| sch_generate_from_netlist | 有限验证 | 完整 Protel2 网表原样写回并重新导出一致；工具文档中的简化输入返回 ok=true，却未实现期望连接变化，不能确认“从网表生成原理图” |
| sch_generate_from_pcb | 异常 | PCB 网表报告为空，随后报 netlist 不能为空 |
| pcb_eprj3_project_info | 异常 | 实际 .esch2 源文件 96 行全部解析失败；完整 .eprj3 工程容器未测试 |

## 保存的证据与结束状态

- 原始 MCP 调用记录：`/tmp/jlcmcp-live-20260907/results.jsonl`；初始连接记录：同目录 `initial.jsonl`。
- 测试脚本：同目录 `harness.mjs`、`pcb-tests.mjs`、`extra-pcb-tests.mjs`、`sch-tests.mjs`。这些脚本只针对本次工程 UUID，勿直接用于其他工程。
- 截图：同目录 `final-pcb-screenshot-0.png`、`focused-schematic-screenshot-0.png`。
- 真实原理图源文件：同目录 `test-sheet.esch2`。
- Bridge 日志：同目录 `bridge.log`。临时目录可能在系统清理或重启后消失，本报告保留关键输入与观测结果。
- EDA 中保留 `MCP 功能测试 20260907` 工程供复查，PCB 最终为两个测试电阻和一段独立丝印；测试走线、过孔、铺铜、禁布区、差分对和等长组已清理。
- 最终 Bridge：`edaConnected=true`、一个窗口、`pendingRequests=0`。原理图和 PCB 已保存。

接口核对参考：[官方 API 文档源码](https://github.com/easyeda/easyeda-api-skill/tree/main/references/classes)。本报告结论主要来自本机实际调用和回读，而非仅依据文档中的接口声明。
