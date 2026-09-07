/**
 * tools/pro.ts — 高级功能（v1.1）
 *
 * 全部基于官方 Bridge（eda.* API）实现，运行于 MCP Server 进程内，
 * 数据通过 bridge.command / bridge.executeRaw 获取与写回。
 */
import { z } from 'zod';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { BridgeClient } from '../bridge-client.js';
import { calcCurrentCapacity } from '../calculators.js';
import { planRoute, pathLength, expandedBox, segmentBox, type Point, type Box, type CopperObstacle } from '../routing-geometry.js';
import { parseSourceRecords } from '../source-records.js';
import { protel2Signature } from '../netlist.js';

// ─── 类型 ────────────────────────────────────────────────────────────
interface Comp { designator: string; name: string; x: number; y: number; width: number; height: number; bbox?: Box; component?: any; footprint?: any; supplierId?: string; padNets: string[]; locked?: boolean; rotation?: number; }
interface Pad { primitiveId: string; net: string; x: number; y: number; designator: string; pinNumber?: string; bbox?: Box; layer?: number; diameter?: number; holeDiameter?: number; }
interface Track { primitiveId: string; net: string; layer: number | string; startX: number; startY: number; endX: number; endY: number; width: number; }
interface ViaOptions { viaDrill?: number; viaDiameter?: number }

function resolveViaSize(params: ViaOptions) {
  const holeDiameter = params.viaDrill ?? 12;
  const diameter = params.viaDiameter ?? 22;
  if (![holeDiameter, diameter].every(Number.isFinite) || holeDiameter <= 0 || holeDiameter >= diameter)
    throw new Error('过孔尺寸必须满足 0 < viaDrill < viaDiameter，单位 mil');
  return { holeDiameter, diameter };
}

// IPC-2221 外层电流容量（A），与 calculators.ts 同一公式


// ─── 1. BOM 导出 ─────────────────────────────────────────────────────
export async function exportBom(bridge: BridgeClient, opts?: { lcscCodes?: Record<string, string> }): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const byName = new Map<string, { name: string; footprint: string; supplierId: string; count: number; designators: string[]; padNets: Set<string> }>();
  for (const c of comps) {
    const name = String(c.name || '(unknown)'), footprint = c.footprint?.name ?? '', supplierId = c.supplierId ?? '';
    const key = JSON.stringify([name, footprint, supplierId, c.name ? '' : c.designator]);
    const row = byName.get(key) || { name, footprint, supplierId, count: 0, designators: [] as string[], padNets: new Set<string>() };
    row.count += 1;
    row.designators.push(c.designator);
    for (const n of c.padNets || []) row.padNets.add(n);
    byName.set(key, row);
  }
  const lcscCodes = opts?.lcscCodes ?? {};
  const items = Array.from(byName.entries())
    .map(([, v]) => ({
      name: v.name,
      footprint: v.footprint,
      quantity: v.count,
      designators: v.designators.sort(),
      nets: Array.from(v.padNets).sort(),
      lcscCode: lcscCodes[v.name] || lcscCodes[v.designators[0]] || v.supplierId || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const csv = [
    'name,quantity,designators,nets,lcsc',
    ...items.map((i) => [i.name, i.quantity, i.designators.join(' '), i.nets.join(' '), i.lcscCode || '']
      .map(v => /[",\r\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v)).join(',')),
  ].join('\n');
  return {
    componentCount: comps.length,
    itemCount: items.length,
    items,
    csv,
    note: '按型号、封装和供应商料号聚合；料号优先使用 lcscCodes 覆盖，否则读取元件 SupplierId。',
  };
}

// ─── 2. 网络连通性检查 ───────────────────────────────────────────────
export async function checkConnectivity(bridge: BridgeClient, opts: { nets?: string[]; drc?: any } = {}): Promise<any> {
  const state: any = await bridge.command('get_state');
  const drc: any = opts.drc ?? await bridge.command('run_drc');
  const names = (state.nets ?? []).map((n: any) => n.name).filter((n: string) => !opts.nets?.length || opts.nets.includes(n));
  const connectionIssues = (drc.issues ?? []).filter((i: any) => i.connectionError);
  const unmapped = connectionIssues.some((i: any) => !i.net);
  const nets = [];
  for (const net of names) {
    const { pads }: any = await bridge.command('get_pads', { nets: [net] });
    const { tracks }: any = await bridge.command('get_tracks', { net });
    const failures = connectionIssues.filter((i: any) => i.net === net);
    let status: string;
    if (pads.length === 0) status = 'no_pads';
    else if (pads.length === 1) status = 'single_pad';
    else if (failures.length) status = 'unrouted';
    else if (unmapped || (!drc.detailsAvailable && !drc.passed)) status = 'unknown';
    else status = 'routed';
    nets.push({ net, padCount: pads.length, trackCount: tracks.length, status, connectionErrors: failures.length });
  }
  return { totalNets: nets.length, routed: nets.filter(n=>n.status==='routed').length,
    unrouted: nets.filter(n=>n.status==='unrouted').length, unknown: nets.filter(n=>n.status==='unknown').length,
    singlePadNets: nets.filter(n=>n.status==='single_pad').length, nets,
    source: 'eda_strict_drc', note: '连通性来自 EDA 严格 DRC 的连接检查，遵循当前工程规则配置；走线数量不代表连通。',
    recommendations: nets.filter(n=>['unrouted','unknown'].includes(n.status)).map(n=>n.net+': '+n.status) };
}

// ─── 3. 载流能力报告 ────────────────────────────────────────────────
export async function currentDensityReport(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const report = [];
  const thicknessMil = 1.4, tempRiseC = 10;
  for (const { name: net } of state.nets ?? []) {
    const { tracks }: any = await bridge.command('get_tracks', { net });
    const { pads }: any = await bridge.command('get_pads', { nets: [net] });
    const valid = tracks.every((t: any) => Number.isFinite(t.width) && t.width > 0);
    const estimates = valid ? tracks.map((t: any) => calcCurrentCapacity({width:t.width,thickness:thicknessMil,tempRise:tempRiseC,layer:[1,2].includes(Number(t.layer))?'external':'internal'})) : [];
    const capacity = estimates.length ? Math.min(...estimates) : null;
    report.push({ net, padCount:pads.length, trackCount:tracks.length,
      minWidthMil:valid && tracks.length ? Math.min(...tracks.map((t: any)=>t.width)) : null,
      estimatedCurrentA:capacity===null?null:Number(capacity.toFixed(3)),
      warning:!valid?'线宽数据缺失，无法估算':capacity!==null && capacity<0.2?'最弱走线段估算载流小于 200mA':null });
  }
  return {totalNets:report.length,report,assumptions:{thicknessMil,tempRiseC},
    notes:'IPC-2221 走线段估算：取各段容量最小值，不累加串联走线宽度；未校核过孔、铺铜、分流和实际散热。'};
}

// ─── 4. 元件焊盘扇出 ────────────────────────────────────────────────
export async function fanoutComponent(bridge: BridgeClient, params: { designator: string } & ViaOptions): Promise<any> {
  const designator = String(params.designator || '').trim();
  if (!designator) throw new Error('designator is required');
  const viaSize = resolveViaSize(params);
  const padResult: any = await bridge.command('get_pads');
  const pads: Pad[] = Array.isArray(padResult?.pads) ? padResult.pads : [];
  const mine = pads.filter((p) => String(p.designator || '') === designator);
  const vias: any[] = [];
  const skipped: string[] = [];
  for (const p of mine) {
    if (!p.net) { skipped.push(p.primitiveId); continue; }
    const via = await bridge.command('create_via', { net: p.net, x: p.x, y: p.y, ...viaSize });
    vias.push({ pad: p.primitiveId, net: p.net, x: p.x, y: p.y, viaId: (via as any)?.primitiveId });
  }
  return {
    designator,
    padCount: mine.length,
    fanoutCreated: vias.length,
    skippedNoNet: skipped.length,
    viaSize,
    vias,
  };
}

// ─── 5. 基础自动布线（L 型，两层） ──────────────────────────────────
// ─── 6. DRC 自修复 ───────────────────────────────────────────────────
export async function drcAutoFix(bridge: BridgeClient): Promise<any> {
  const before: any = await bridge.command('run_drc');
  const fixes: string[] = [];
  const issues = Array.isArray(before?.issues) ? before.issues : [];
  const ruleText = issues.map((i: any) => String(i?.rule || '')).join(' ');

  // 丝印重叠 → 自动排列丝印
  if (/silkscreen|丝印|silk/i.test(ruleText) || issues.some((i: any) => /silk/i.test(String(i.rule)))) {
    const silk = await bridge.command('auto_silkscreen');
    fixes.push('auto_silkscreen: 移动 ' + ((silk as any)?.moved ?? 0) + ' 个丝印');
  }

  const after: any = await bridge.command('run_drc');
  const beforeCount = Number(before?.totalCount ?? 0);
  const afterCount = Number(after?.totalCount ?? 0);
  return {
    before: { passed: before?.passed, totalCount: beforeCount, errors: before?.summary?.errors },
    after: { passed: after?.passed, totalCount: afterCount, errors: after?.summary?.errors },
    fixedCount: beforeCount - afterCount,
    fixesApplied: fixes,
    remainingIssues: Array.isArray(after?.issues) ? after.issues.slice(0, 20) : [],
    note: '目前可自动修复项：丝印冲突。其余 DRC 问题请人工处理或用 pcb_execute_code 自定义修复。',
  };
}


// ─── 7. 元件间距检查 ─────────────────────────────────────────────────
export async function componentClearanceCheck(bridge: BridgeClient, params: { minClearance?: number }): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = state.components ?? [];
  const minClearance=params.minClearance??20;
  if(!Number.isFinite(minClearance)||minClearance<0)throw new Error('最小间距必须为非负数');
  const violations=[], unavailable=[];
  let checkedPairs=0;
  for(let i=0;i<comps.length;i++)for(let j=i+1;j<comps.length;j++){
    const a=comps[i],b=comps[j],ab=a.bbox,bb=b.bbox;
    if(!ab||!bb){unavailable.push({a:a.designator,b:b.designator});continue;}
    const dx=Math.max(ab.minX-bb.maxX,bb.minX-ab.maxX);
    const dy=Math.max(ab.minY-bb.maxY,bb.minY-ab.maxY);
    const overlap=dx<0&&dy<0;
    const gap=overlap?Math.max(dx,dy):Math.hypot(Math.max(dx,0),Math.max(dy,0));
    checkedPairs++;
    if(overlap||gap<minClearance)violations.push({a:a.designator,b:b.designator,gapMil:Math.round(gap*100)/100,overlap,minClearance});
  }
  return {componentCount:comps.length,checkedPairs,minClearance,violations,violationCount:violations.length,
    unavailable,complete:unavailable.length===0,method:'official_axis_aligned_bbox',note:'使用真实轴对齐外框，旋转和复杂外形可能产生保守误报；精确检查仍以 EDA DRC 为准。'};
}

// ─── 8. 差分对布线 ───────────────────────────────────────────────────
export async function routeDifferentialPairs(bridge: BridgeClient, params: { pairName?: string; layer?: number; width?: number; gap?: number }): Promise<any> {
  const list:any=await bridge.command('list_differential_pairs');
  const targets=params.pairName?list.pairs.filter((p:any)=>p.name===params.pairName):list.pairs;
  if(params.pairName&&!targets.length)throw new Error('差分对不存在: '+params.pairName);
  const layer=params.layer??1,width=params.width??6,gap=params.gap??8;
  const pairs=[];
  for(const p of targets){
    const result=await autoRouteNets(bridge,{nets:[p.positiveNet,p.negativeNet],topLayer:layer,width,clearance:gap});
    const pos=result.nets.find((n:any)=>n.net===p.positiveNet),neg=result.nets.find((n:any)=>n.net===p.negativeNet);
    pairs.push({pair:p.name,positiveNet:p.positiveNet,negativeNet:p.negativeNet,
      positiveSegments:pos?.segments??0,negativeSegments:neg?.segments??0,
      positiveLengthMil:pos?.lengthMil??null,negativeLengthMil:neg?.lengthMil??null,
      lengthDeltaMil:pos?.lengthMil!==undefined&&neg?.lengthMil!==undefined?Math.abs(pos.lengthMil-neg.lengthMil):null,
      connected:!!pos?.connected&&!!neg?.connected,drcPassed:result.drcPassed,drcError:result.drcError,paths:result.nets,
      couplingVerified:false,note:'保留真实焊盘端点的双网连接草稿；gap 用作最小规划间距，不保证恒定耦合间距或等长。'});
  }
  return {routedPairs:pairs.filter(p=>p.connected).length,layer,width,gap,pairs};
}

// ─── 9. 设计健康报告 ─────────────────────────────────────────────────
export async function designHealthReport(bridge: BridgeClient): Promise<any> {
  // EDA DRC is a document-level operation; run it once rather than concurrently twice.
  const drc: any = await bridge.command('run_drc');
  const [bom, conn, dens, clear] = await Promise.all([
    exportBom(bridge),
    checkConnectivity(bridge, { drc }),
    currentDensityReport(bridge),
    componentClearanceCheck(bridge, {}),
  ]) as any[];
  const issues: string[] = [];
  if (!drc?.passed) issues.push('DRC 存在 ' + (drc?.totalCount ?? 0) + ' 个问题');
  if (conn.unknown > 0) issues.push('有网络连通性无法确认');
  if (!clear.complete) issues.push('部分元件缺少边界数据，无法完成间距检查');
  if ((conn as any).unrouted > 0) issues.push('存在 ' + (conn as any).unrouted + ' 个未布线网络');
  if ((conn as any).singlePadNets > 0) issues.push('存在 ' + (conn as any).singlePadNets + ' 个单焊盘网络');
  if ((clear as any).violationCount > 0) issues.push('存在 ' + (clear as any).violationCount + ' 处元件间距违规');
  if ((dens as any).report.some((r: any) => r.warning)) issues.push('存在载流能力偏低网络');
  return {
    generatedAt: new Date().toISOString(),
    score: issues.length === 0 ? 'READY' : issues.length <= 2 ? 'NEEDS_WORK' : 'POOR',
    summary: {
      components: bom.componentCount,
      bomItems: bom.itemCount,
      nets: conn.totalNets,
      routedNets: conn.routed,
      unrouted: conn.unrouted,
      drcPassed: Boolean(drc?.passed),
      drcIssues: drc?.totalCount ?? null,
      unknownNets: conn.unknown,
      clearanceComplete: clear.complete,
      clearanceViolations: clear.violationCount,
      currentWarnings: dens.report.filter((r: any) => r.warning).length,
    },
    issues,
    bom: bom.items,
    connectivity: conn.nets,
    currentDensity: dens.report,
    drc: drc?.issues?.slice?.(0, 20) ?? [],
    clearance: clear.violations.slice(0, 20),
  };
}

// ─── 10. 扇出 + 布线 + DRC 流水线 ────────────────────────────────────
export async function autoFanoutAndRoute(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const fanoutResults: any[] = [];
  for (const c of comps) {
    const f = await fanoutComponent(bridge, { designator: c.designator });
    fanoutResults.push(f);
  }
  const route = await autoRouteNets(bridge, {});
  const drc: any = await bridge.command('run_drc');
  const fix = await drcAutoFix(bridge);
  return {
    fanout: { components: fanoutResults.length, viasCreated: fanoutResults.reduce((s, f) => s + f.fanoutCreated, 0) },
    routing: route,
    drcBefore: { passed: drc?.passed, totalCount: drc?.totalCount },
    autoFixes: fix.fixesApplied,
    drcAfter: fix.after,
    note: '流水线：全部元件扇出 → 全部网络自动布线 → DRC → 丝印自动修复。请人工复核后用 pcb_design_health_report 复检。',
  };
}


// ─── 11. 自动布局（质心优化）─────────────────────────────────────────
export async function autoPlaceComponents(bridge: BridgeClient, params: { maxMoves?: number }): Promise<any> {
  const state: any = await bridge.command('get_state');
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const padResult: any = await bridge.command('get_pads');
  const pads: Pad[] = Array.isArray(padResult?.pads) ? padResult.pads : [];
  const maxMoves = params.maxMoves ?? 100;

  // 每个元件 → 其焊盘质心（保持元件中心与焊盘中心一致是简化假设）
  const byDesignator = new Map<string, { x: number; y: number; count: number }>();
  for (const p of pads) {
    if (!p.designator) continue;
    const acc = byDesignator.get(p.designator) || { x: 0, y: 0, count: 0 };
    acc.x += p.x;
    acc.y += p.y;
    acc.count += 1;
    byDesignator.set(p.designator, acc);
  }

  const details: any[] = [];
  let moved = 0;
  for (const c of comps) {
    if (moved >= maxMoves) break;
    const acc = byDesignator.get(c.designator);
    if (!acc || acc.count === 0) continue;
    const cx = Math.round(acc.x / acc.count);
    const cy = Math.round(acc.y / acc.count);
    const dx = Math.abs(cx - c.x);
    const dy = Math.abs(cy - c.y);
    if (dx < 1 && dy < 1) continue; // 已就位
    if (c.locked) continue;
    await bridge.command('move_component', { designator: c.designator, x: cx, y: cy, rotation: c.rotation ?? 0 });
    moved += 1;
    details.push({
      designator: c.designator,
      from: { x: c.x, y: c.y },
      to: { x: cx, y: cy },
      deltaMil: Math.round(Math.hypot(dx, dy) * 10) / 10,
    });
  }
  return {
    moved,
    evaluatedComponents: byDesignator.size,
    optimizationVerified: false,
    totalComponents: comps.length,
    details,
    note: '当前操作仅将元件原点对齐自身焊盘质心，未实现按网络或拥挤度优化布局；对称封装 moved=0 是正常结果。',
  };
}

// ─── 12. 障碍规避自动布线 ───────────────────────────────────────────








export async function autoRouteNets(bridge: BridgeClient, params: { nets?: string[]; topLayer?: number; viaLayer?: number; width?: number; clearance?: number; useVias?: boolean } & ViaOptions): Promise<any> {
  const viaSize = resolveViaSize(params);
  const state:any=await bridge.command('get_state');
  const targets=[...new Set(params.nets?.length?params.nets:(state.nets??[]).map((n:any)=>n.name))] as string[];
  const topLayer=params.topLayer??1, viaLayer=params.viaLayer??2, width=params.width??10, clearance=params.clearance??15;
  if(!Number.isFinite(width)||width<=0||!Number.isFinite(clearance)||clearance<0)throw new Error('线宽须为正数，间距须为非负数');
  if(params.useVias && (topLayer===viaLayer || ![1,2].includes(topLayer) || ![1,2].includes(viaLayer)))throw new Error('双层模式要求不同的顶层/底层');
  const layer=params.useVias?viaLayer:topLayer;
  const {pads:allPads}:any=await bridge.command('get_pads');
  const {tracks}:any=await bridge.command('get_tracks');
  if (tracks.some((t:Track) => ![t.startX,t.startY,t.endX,t.endY,t.width].every(Number.isFinite) || t.width <= 0))
    throw new Error('已有走线缺少有效坐标或线宽，不能可靠检查障碍');
  const obstacles:CopperObstacle[]=allPads.filter((p:Pad)=>p.bbox).map((p:Pad)=>({bbox:p.bbox!,net:p.net,layer:Number(p.layer)}));
  for(const t of tracks)obstacles.push({bbox:segmentBox({x:t.startX,y:t.startY},{x:t.endX,y:t.endY},t.width),net:t.net,layer:Number(t.layer)});
  const other:any=await bridge.executeRaw('const out=[]; for(const type of ["Via","Arc","Pour","Fill","Region"]){const api=eda["pcb_Primitive"+type];if(!api?.getAll)continue;for(const row of await api.getAll()){const bbox=await eda.pcb_Primitive.getPrimitivesBBox([row]);if(bbox)out.push({bbox,net:row.getState_Net?.()??"",layer:type==="Via"?12:(row.getState_Layer?.()??12)});}}return out;');
  obstacles.push(...other);
  if(allPads.some((p:Pad)=>!p.bbox || ![p.x,p.y,p.layer].every(Number.isFinite)))throw new Error('存在无法读取外框、坐标或层号的焊盘，不能规划避障路线');
  const summary:any[]=[];
  let totalTrackSegments=0,totalVias=0;
  for(const net of targets){
    const pads:Pad[]=allPads.filter((p:Pad)=>p.net===net).sort((a:Pad,b:Pad)=>a.x-b.x||a.y-b.y);
    if(pads.length<2){summary.push({net,pads:pads.length,segments:0,skipped:'不足两个焊盘'});continue;}
    if(!params.useVias && pads.some(p=>p.layer!==layer&&p.layer!==12)){summary.push({net,pads:pads.length,segments:0,skipped:'焊盘跨层，须使用双层模式'});continue;}
    const boxes=obstacles.filter(o=>o.net!==net && (o.layer===layer||o.layer===12)).map(o=>expandedBox(o.bbox,clearance+width/2));
    const paths:Point[][]=[];
    let failed=false;
    for(let i=1;i<pads.length;i++){
      const path=planRoute(pads[i-1],pads[i],boxes);
      if(!path){failed=true;break;}
      if(state.boardBounds && path.some(p=>p.x<state.boardBounds.minX||p.x>state.boardBounds.maxX||p.y<state.boardBounds.minY||p.y>state.boardBounds.maxY)){failed=true;break;}
      paths.push(path);
    }
    const viaPads=params.useVias?pads.filter(p=>p.layer!==layer&&p.layer!==12):[];
    const viaMargin=clearance+viaSize.diameter/2;
    for(const p of viaPads){
      if(obstacles.some(o=>o.net!==net && p.x>=o.bbox.minX-viaMargin && p.x<=o.bbox.maxX+viaMargin && p.y>=o.bbox.minY-viaMargin && p.y<=o.bbox.maxY+viaMargin))failed=true;
    }
    if(failed){summary.push({net,pads:pads.length,segments:0,skipped:'候选路径或过孔被障碍阻挡；未生成该网络走线'});continue;}
    let segments=0,vias=0;
    for(const p of viaPads){
      await bridge.command('create_via',{net,x:p.x,y:p.y,...viaSize});vias++;
      obstacles.push({bbox:segmentBox(p,p,viaSize.diameter),net,layer:12});
    }
    for(const path of paths){
      const result:any=await bridge.command('route_track',{net,points:path,layer,width});segments+=result.createdSegments;
      for(let i=1;i<path.length;i++)obstacles.push({bbox:segmentBox(path[i-1],path[i],width),net,layer});
    }
    totalTrackSegments+=segments;totalVias+=vias;
    summary.push({net,pads:pads.length,segments,vias,paths,lengthMil:paths.reduce((s,p)=>s+pathLength(p),0)});
  }
  let drc:any;
  try { drc=await bridge.command('run_drc'); }
  catch (e:any) { drc={passed:false,detailsAvailable:false,issues:[],error:e.message}; }
  const connectionIssues=(drc.issues??[]).filter((i:any)=>i.connectionError);
  for(const r of summary)r.connected=!r.skipped&&(drc.detailsAvailable||drc.passed)&&!connectionIssues.some((i:any)=>!i.net||i.net===r.net);
  return {routedNets:summary.filter(r=>r.connected).length,generatedNets:summary.filter(r=>r.segments>0).length,
    skippedNets:summary.filter(r=>r.skipped).length,totalTrackSegments,totalVias,totalDetours:summary.filter(r=>r.paths?.some((p:Point[])=>p.length>2)).length,
    mode:params.useVias?'two_layer_escape':'single_layer_obstacle_aware',viaSize:params.useVias?viaSize:null,drcPassed:drc.passed,drcError:drc.error??null,nets:summary,
    note:'候选路线避开异网焊盘、已有及本轮新走线等外框；无可行路线则跳过。双层模式用目标布线层并在需要换层的焊盘处放通孔。routedNets 来自连接检查，drcPassed 为整板检查结果。'};
}

// ─── 13. PCB 网表报告 ───────────────────────────────────────────────
export async function netlistReport(bridge: BridgeClient): Promise<any> {
  const state: any=await bridge.command('get_state');
  const {pads}: any=await bridge.command('get_pads');
  const byDesignator=new Map<string,any>();
  for(const c of state.components??[])byDesignator.set(c.designator,{designator:c.designator,name:c.name,component:c.component,footprint:c.footprint,pins:[]});
  const unmapped=[];
  for(const p of pads){
    const c=byDesignator.get(p.designator);
    if(!c||!p.pinNumber){unmapped.push(p.primitiveId);continue;}
    c.pins.push({pin:p.pinNumber,net:p.net||'',primitiveId:p.primitiveId});
  }
  const components=[...byDesignator.values()];
  const netMap=new Map<string,Set<string>>();
  for(const c of components)for(const pin of c.pins)if(pin.net){
    const set=netMap.get(pin.net)??new Set<string>();set.add(c.designator);netMap.set(pin.net,set);
  }
  return {componentCount:components.length,components,nets:[...netMap].map(([net,des])=>({net,designators:[...des].sort()})),
    unmappedPads:unmapped,complete:unmapped.length===0,note:'使用 EDA 的焊盘所属元件及实际焊盘编号，不按返回顺序编造引脚号。'};
}

// ─── 14. 设计快照 / 差异对比 ────────────────────────────────────────
let lastSnapshot: any = null;

function normalizeSnapshot(state: any): any {
  const comps: Comp[] = Array.isArray(state?.components) ? state.components : [];
  const byDes = new Map<string, any>();
  for (const c of comps) byDes.set(c.designator, { designator: c.designator, name: c.name, x: c.x, y: c.y, rotation: c.rotation });
  return { components: byDes };
}

export async function designSnapshot(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  lastSnapshot = normalizeSnapshot(state);
  return { snapshotTaken: true, componentCount: lastSnapshot.components.size, designators: Array.from(lastSnapshot.components.keys()).sort() };
}

export async function designDiff(bridge: BridgeClient): Promise<any> {
  const state: any = await bridge.command('get_state');
  const cur = normalizeSnapshot(state);
  if (!lastSnapshot) {
    lastSnapshot = cur;
    return { note: '首次调用已建立快照基线（无对比）', componentCount: cur.components.size };
  }
  const added: string[] = [];
  const removed: string[] = [];
  const moved: any[] = [];
  for (const [des, c] of cur.components) {
    if (!lastSnapshot.components.has(des)) added.push(des);
    else {
      const prev = lastSnapshot.components.get(des);
      const dx = Math.abs(c.x - prev.x);
      const dy = Math.abs(c.y - prev.y);
      if (dx >= 1 || dy >= 1) moved.push({ designator: des, from: { x: prev.x, y: prev.y }, to: { x: c.x, y: c.y }, deltaMil: Math.round(Math.hypot(dx, dy) * 10) / 10 });
    }
  }
  for (const des of lastSnapshot.components.keys()) {
    if (!cur.components.has(des)) removed.push(des);
  }
  lastSnapshot = cur;
  return { added, removed, moved, addedCount: added.length, removedCount: removed.length, movedCount: moved.length };
}


// ─── 15. 网表 → 原理图（官方 sch_Netlist.setNetlist）────────────────
export const NETLIST_TYPES = ['EasyEDA', 'JLCEDA', 'Protel2', 'PADS', 'Allegro', 'DISA', 'DSNET'] as const;

export async function schGenerateFromNetlist(bridge: BridgeClient, params: { netlist: string; type?: string }): Promise<any> {
  const netlist = String(params.netlist ?? '');
  if (!netlist.trim()) throw new Error('netlist 不能为空');
  const type = params.type ?? 'Protel2';
  if (!(NETLIST_TYPES as readonly string[]).includes(type)) throw new Error('不支持的网表类型: ' + type);
  const signature = (text: string) => type === 'Protel2' ? protel2Signature(text) : text.replace(/\r/g, '').trim();
  const expected = signature(netlist);
  const before: any = await bridge.executeRaw(
    'const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();' +
    'if (!page) throw new Error("请先打开目标原理图页");' +
    'return { pageUuid: page.uuid, netlist: await eda.sch_Netlist.getNetlist(' + JSON.stringify(type) + ') };');
  // The beta setter returns void even on a no-op. Read back and verify logical content.
  const after: any = await bridge.executeRaw(
    'const page = await eda.dmt_Schematic.getCurrentSchematicPageInfo();' +
    'if (page?.uuid !== ' + JSON.stringify(before.pageUuid) + ') throw new Error("操作期间原理图页已切换");' +
    'await eda.sch_Netlist.setNetlist(' + JSON.stringify(type) + ',' + JSON.stringify(netlist) + ');' +
    'return await eda.sch_Netlist.getNetlist(' + JSON.stringify(type) + ');');
  if (typeof after !== 'string' || signature(after) !== expected)
    throw new Error('EDA 网表更新后读取结果与输入不符；未确认导入成功。该 beta API 无法保证从 PCB 自动生成符号和导线，请检查目标原理图。');
  return { ok: true, verified: true, changed: signature(before.netlist) !== expected, type,
    pageUuid: before.pageUuid, netlistLength: netlist.length,
    note: '已验证网表内容；此操作不承诺自动放置符号、生成导线或完成原理图布局。' };
}

/** Serialize component and pin records, using the actual pad numbers. */
export function netlistToProtel2(report: any): string {
  if (report?.complete === false) throw new Error('焊盘归属或引脚编号缺失，不能生成完整网表');
  const safe = (value: any) => {
    const text = String(value ?? '').trim();
    if (!text || /[\r\n]/.test(text)) throw new Error('网表字段为空或包含换行');
    return text;
  };
  const blocks = ['PROTEL NETLIST 2.0'];
  const pins = new Map<string, string[]>();
  for (const c of report.components ?? []) {
    blocks.push(['[', 'DESIGNATOR', safe(c.designator), 'FOOTPRINT', safe(c.footprint?.name || 'UNKNOWN'),
      'PARTTYPE', safe(c.name || 'UNKNOWN'), '*', ']'].join('\n'));
    for (const p of c.pins ?? []) if (p.net) {
      const net = safe(p.net), list = pins.get(net) ?? [];
      list.push(safe(c.designator) + '-' + safe(p.pin)); pins.set(net, list);
    }
  }
  for (const [net, list] of pins) blocks.push(['(', net, ...list, ')'].join('\n'));
  const result = blocks.join('\n'); protel2Signature(result); return result;
}

export async function schGenerateFromPcb(bridge: BridgeClient, params: { type?: string }): Promise<any> {
  const type = params.type ?? 'Protel2';
  if (!(NETLIST_TYPES as readonly string[]).includes(type)) throw new Error('不支持的网表类型: ' + type);
  const source: any = await bridge.executeRaw(
    'const board = await eda.dmt_Board.getCurrentBoardInfo();' +
    'const pcb = await eda.dmt_Pcb.getCurrentPcbInfo();' +
    'if (!pcb || board?.pcb?.uuid !== pcb.uuid || !board?.schematic?.uuid) throw new Error("请打开有关联原理图的 PCB");' +
    'const pages = (await eda.dmt_Schematic.getAllSchematicPagesInfo()).filter(p => p.parentSchematicUuid === board.schematic.uuid);' +
    'if (!pages.length) throw new Error("关联原理图没有可打开的页面");' +
    'return { pcbUuid: pcb.uuid, pageUuid: pages[0].uuid, netlist: await eda.pcb_Net.getNetlist(' + JSON.stringify(type) + ') };');
  if (type === 'Protel2') protel2Signature(source.netlist);
  await bridge.executeRaw('const tab = await eda.dmt_EditorControl.openDocument(' + JSON.stringify(source.pageUuid) + '); if (!tab) throw new Error("打开目标原理图失败"); return tab;');
  try {
    return { ...await schGenerateFromNetlist(bridge, { netlist: source.netlist, type }), source: 'pcb_official_netlist', pcbUuid: source.pcbUuid };
  } finally {
    await bridge.executeRaw('return await eda.dmt_EditorControl.openDocument(' + JSON.stringify(source.pcbUuid) + ');');
  }
}

// ─── 16. eprj3 工程检查器 ────────────────────────────────────────────
const EPRJ3_EXTS = ['.eprj3', '.esch2', '.epcb2', '.epan2', '.ecfg', '.evar'];

export async function eprj3ProjectInfo(projectPath: string): Promise<any> {
  const p=String(projectPath??'').trim();
  if(!p||!existsSync(p))throw new Error('路径不存在: '+p);
  if(statSync(p).isFile()){
    const ext=path.extname(p).toLowerCase();
    if(!EPRJ3_EXTS.includes(ext))throw new Error('不支持的工程文件扩展名: '+ext);
    const bytes=readFileSync(p);
    if(bytes.subarray(0,2).toString()==='PK'||bytes.subarray(0,6).toString()==='SQLite')
      throw new Error('该文件是二进制工程容器，请先用 EDA 导出/解包为文本源文件后检查');
    const raw=bytes.toString('utf8').replace(/^\uFEFF/,'');
    if(ext==='.eprj3'){
      try {const json=JSON.parse(raw);return {kind:'project-index',file:path.basename(p),sizeBytes:bytes.length,keys:Object.keys(json),json};}catch{}
    }
    const parsed=parseSourceRecords(raw),counts:Record<string,number>={};
    for(const r of parsed.records)counts[r.header.type]=(counts[r.header.type]??0)+1;
    const meta=parsed.records.find(r=>r.header.type==='META')?.data??parsed.records.find(r=>r.header.type==='DOCHEAD')?.data??null;
    if(!parsed.records.length&&parsed.errors.length)throw new Error('源文件无法解析：'+parsed.errors[0].message);
    return {kind:'source-records',file:path.basename(p),recordCount:parsed.recordCount,parsedRecords:parsed.records.length,
      recordTypes:counts,meta,parseErrors:parsed.errors,complete:parsed.errors.length===0};
  }
  const files:string[]=[];
  const walk=(d:string)=>{for(const f of readdirSync(d)){const full=path.join(d,f);const s=statSync(full);if(s.isDirectory())walk(full);else files.push(path.relative(p,full));}};
  walk(p);
  const index=files.find(f=>f.toLowerCase().endsWith('.eprj3'))??null;
  const indexInfo=index?await eprj3ProjectInfo(path.join(p,index)):null;
  const schematicSheets=files.filter(f=>f.toLowerCase().endsWith('.esch2'));
  return {kind:'project-folder',projectName:index?path.basename(index,'.eprj3'):path.basename(p),eprj3File:index,
    indexKeys:indexInfo?.keys??[],indexInfo,schematicFolders:[...new Set(schematicSheets.map(f=>path.dirname(f)))],
    schematicSheets,pcbFiles:files.filter(f=>f.toLowerCase().endsWith('.epcb2')),panelFiles:files.filter(f=>f.toLowerCase().endsWith('.epan2'))};
}

// ─── MCP 注册 ────────────────────────────────────────────────────────
export function registerProTools(server: any, bridge: BridgeClient) {
  server.tool('pcb_bom_export', '导出 PCB BOM（按型号、封装和料号聚合），返回 JSON + CSV', {
    lcscCodes: z.record(z.string()).optional().describe('元件名 → LCSC 料号映射（如 {"R-10k":"C25744"}，LCSC API 受保护无法自动查询）'),
  }, async ({ lcscCodes }: { lcscCodes?: Record<string, string> }) => {
    const data = await exportBom(bridge, { lcscCodes });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_net_connectivity_check', '检查所有网络的连通性（焊盘数/走线段数，标记未布线网络）', {
    nets: z.array(z.string()).optional().describe('指定检查的网络（默认全部）'),
  }, async ({ nets }: { nets?: string[] }) => {
    const data = await checkConnectivity(bridge, { nets });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_current_density_report', '各网络载流能力估算（IPC-2221，最弱走线段，默认 1oz/10°C 温升），标记偏低网络', {}, async () => {
    const data = await currentDensityReport(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_fanout_component', '在指定元件的带网络焊盘中心创建通孔；当前为盘中过孔模式，需工艺支持', {
    designator: z.string().describe('元件位号，如 U1'),
    viaDrill: z.number().positive().optional().describe('过孔孔径 mil（默认 12，按工程规则调整）'),
    viaDiameter: z.number().positive().optional().describe('过孔外径 mil（默认 22，按工程规则调整）'),
  }, async ({ designator, viaDrill, viaDiameter }: { designator: string } & ViaOptions) => {
    const data = await fanoutComponent(bridge, { designator, viaDrill, viaDiameter });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_auto_route_nets', '自动布线：保守的正交连接草稿，检查铜障碍和端点，失败不强连；useVias 在焊盘处换层，返回 DRC 结果', {
    nets: z.array(z.string()).optional().describe('要布线的网络列表（默认全部）'),
    topLayer: z.number().optional().describe('布线层（默认 1 顶层）'),
    viaLayer: z.number().optional().describe('换层后的布线层（useVias 时，默认 2 底层）'),
    width: z.number().optional().describe('线宽 mil（默认 10）'),
    clearance: z.number().optional().describe('障碍间距 mil（默认 15）'),
    useVias: z.boolean().optional().describe('true=焊盘中心放置过孔并在 viaLayer 布线（需支持盘中过孔）；false=单层'),
    viaDrill: z.number().positive().optional().describe('换层过孔孔径 mil（默认 12，按工程规则调整）'),
    viaDiameter: z.number().positive().optional().describe('换层过孔外径 mil（默认 22，按工程规则调整）'),
  }, async ({ nets, topLayer, viaLayer, width, clearance, useVias, viaDrill, viaDiameter }: { nets?: string[]; topLayer?: number; viaLayer?: number; width?: number; clearance?: number; useVias?: boolean } & ViaOptions) => {
    const data = await autoRouteNets(bridge, { nets, topLayer, viaLayer, width, clearance, useVias, viaDrill, viaDiameter });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_drc_autofix', '运行 DRC 并自动修复可自动处理的问题（当前：丝印冲突），返回修复前后对比', {}, async () => {
    const data = await drcAutoFix(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
  server.tool('pcb_component_clearance_check', '检查所有元件对的最小间距，标记低于阈值的违规对', {
    minClearance: z.number().optional().describe('最小间距 mil（默认 20）'),
  }, async ({ minClearance }: { minClearance?: number }) => {
    const data = await componentClearanceCheck(bridge, { minClearance });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_route_differential_pairs', '差分对双网连接草稿：保留焊盘端点并报告真实长度；不保证恒定耦合间距或等长', {
    pairName: z.string().optional().describe('指定差分对名称（默认全部）'),
    layer: z.number().optional().describe('走线层（默认 1 顶层）'),
    width: z.number().optional().describe('线宽 mil（默认 6）'),
    gap: z.number().optional().describe('正负线间距 mil（默认 8）'),
  }, async ({ pairName, layer, width, gap }: { pairName?: string; layer?: number; width?: number; gap?: number }) => {
    const data = await routeDifferentialPairs(bridge, { pairName, layer, width, gap });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_design_health_report', '一键输出设计健康报告：BOM + 连通性 + 载流 + DRC + 间距，给出 READY/NEEDS_WORK/POOR 评分', {}, async () => {
    const data = await designHealthReport(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_auto_fanout_and_route', '流水线：全部元件扇出 → 全部网络自动布线 → DRC → 丝印自修复', {}, async () => {
    const data = await autoFanoutAndRoute(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
  server.tool('pcb_auto_place_components', '封装质心对齐：把元件原点移动到自身焊盘质心；不提供按网络优化布局，锁定元件跳过', {
    maxMoves: z.number().optional().describe('最大移动数（默认 100）'),
  }, async ({ maxMoves }: { maxMoves?: number }) => {
    const data = await autoPlaceComponents(bridge, { maxMoves });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_netlist_report', '从 PCB 焊盘数据生成网表报告（元件→引脚→网络、网络→元件）', {}, async () => {
    const data = await netlistReport(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_design_snapshot', '保存当前设计快照（作为后续 pcb_design_diff 的基线）', {}, async () => {
    const data = await designSnapshot(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_design_diff', '对比当前设计与上次快照，报告新增/移除/移动的元件', {}, async () => {
    const data = await designDiff(bridge);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
  server.tool('sch_generate_from_netlist', '更新当前原理图网表并读取验证结果；不能保证自动生成符号、导线或布局', {
    netlist: z.string().describe('完整网表文件内容；Protel2 需文件头、元件属性和圆括号网络记录'),
    type: z.string().optional().describe('网表格式（默认 Protel2）'),
  }, async ({ netlist, type }: { netlist: string; type?: string }) => {
    const data = await schGenerateFromNetlist(bridge, { netlist, type });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('sch_generate_from_pcb', '导出当前 PCB 官方网表，更新关联原理图并读取验证；失败明确报错，不保证自动画图', {
    type: z.string().optional().describe('网表格式（默认 Protel2）'),
  }, async ({ type }: { type?: string }) => {
    const data = await schGenerateFromPcb(bridge, { type });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });

  server.tool('pcb_eprj3_project_info', '检查嘉立创EDA专业版 .eprj3 工程（目录或文件）：工程索引、原理图/PCB/面板文件清单，或源文件记录统计（支持原生 header||payload| 记录）', {
    projectPath: z.string().describe('.eprj3 工程根目录路径，或 .eprj3/.epcb2/.esch2 等文件路径'),
  }, async ({ projectPath }: { projectPath: string }) => {
    const data = await eprj3ProjectInfo(projectPath);
    return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
  });
}
