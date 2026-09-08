/** Official EDA handlers. scripts/port-plugin.mjs serializes these functions and
 * their helper dependencies into generated.ts. Keep them independent of Node.
 */
declare const eda: any;
import { prepareRoutePath, inspectRoutePath, resolveRouteOptions, expandedBox,
  routePointDistance, type Point, type Box } from '../routing-geometry.js';
import { resolveRouteEndpoints, validateEndpointOptions, inspectRouteEndpoints, type RouteTarget } from '../routing-endpoints.js';
export {};

function stateValue(row: any, key: string, fallback: any = undefined): any {
  const getter = row?.['getState_' + key];
  return typeof getter === 'function' ? getter.call(row) ?? fallback : fallback;
}

function componentIdentity(row: any): any {
  const component = stateValue(row, 'Component', {});
  const other = stateValue(row, 'OtherProperty', {});
  const rawName = stateValue(row, 'Name', '');
  const value = other.Value ?? '';
  return {
    component,
    name: component.name || other.Device || (String(rawName).startsWith('=') ? value : rawName),
    value,
    footprint: stateValue(row, 'Footprint', {}),
    supplierId: stateValue(row, 'SupplierId', ''),
    manufacturerId: stateValue(row, 'ManufacturerId', ''),
  };
}

async function primitiveBBox(row: any): Promise<any> {
  const b = await eda.pcb_Primitive.getPrimitivesBBox([row]);
  return b && ['minX', 'minY', 'maxX', 'maxY'].every(k => Number.isFinite(b[k])) ? b : null;
}

async function getPCBState(): Promise<any> {
  const components = [];
  for (const row of await eda.pcb_PrimitiveComponent.getAll()) {
    const bbox = await primitiveBBox(row);
    components.push({
      primitiveId: stateValue(row, 'PrimitiveId'), designator: stateValue(row, 'Designator', ''),
      ...componentIdentity(row), x: stateValue(row, 'X'), y: stateValue(row, 'Y'),
      rotation: stateValue(row, 'Rotation'), layer: stateValue(row, 'Layer'),
      locked: stateValue(row, 'PrimitiveLock', false), bbox,
      width: bbox ? bbox.maxX - bbox.minX : null, height: bbox ? bbox.maxY - bbox.minY : null,
      padNets: [...new Set((stateValue(row, 'Pads', []) as any[]).map(p => p.net).filter(Boolean))],
    });
  }
  const nets = [];
  for (const name of await eda.pcb_Net.getAllNetsName()) {
    nets.push({ name, length: await eda.pcb_Net.getNetLength(name) });
  }
  const outlines = await eda.pcb_PrimitiveLine.getAll(undefined, 11);
  const boardBounds = outlines.length ? await eda.pcb_Primitive.getPrimitivesBBox(outlines) : null;
  const layers = await eda.pcb_Layer.getAllLayers();
  return { components, nets, boardBounds, boardBoundsSource: outlines.length ? 'board_outline_lines' : 'unavailable',
    layerCount: layers.filter((l: any) => ['SIGNAL', 'PLANE'].includes(l.type) && l.layerStatus !== 0).length, layers };
}

async function getPads(params: any = {}): Promise<any> {
  const components = await eda.pcb_PrimitiveComponent.getAll();
  const byId = new Map(components.map((c: any) => [stateValue(c, 'PrimitiveId'), c]));
  const padParents = new Map<string, any>();
  for (const c of components) {
    for (const p of stateValue(c, 'Pads', [])) {
      // Desktop 3.2.186 returns footprint-local IDs (e12), while getAll pads
      // use componentId + localId and expose no parent getter.
      const id = stateValue(c, 'PrimitiveId');
      padParents.set(String(p.primitiveId).startsWith(id) ? p.primitiveId : id + p.primitiveId, c);
    }
  }
  const netList = Array.isArray(params.nets) ? params.nets : typeof params.nets === 'string' ? params.nets.split(',').map((s: string) => s.trim()) : [];
  const filter = new Set(netList);
  const rows = await eda.pcb_PrimitivePad.getAll();
  const pads = [];
  for (const row of rows) {
    const primitiveId = stateValue(row, 'PrimitiveId');
    const parentId = stateValue(row, 'ParentComponentPrimitiveId', '');
    const parent = byId.get(parentId) ?? padParents.get(primitiveId);
    const designator = stateValue(parent, 'Designator', '');
    const net = stateValue(row, 'Net', '');
    if (params.designator !== undefined && designator !== params.designator) continue;
    if (filter.size && !filter.has(net)) continue;
    const bbox = await primitiveBBox(row);
    const shape = stateValue(row, 'Pad', null);
    pads.push({ primitiveId, parentPrimitiveId: parentId || stateValue(parent, 'PrimitiveId', ''), designator,
      pinNumber: String(stateValue(row, 'PadNumber', '')), net, x: stateValue(row, 'X'), y: stateValue(row, 'Y'),
      layer: stateValue(row, 'Layer'), rotation: stateValue(row, 'Rotation', 0),
      locked: stateValue(row, 'PrimitiveLock', false), shape, bbox,
      width: bbox ? bbox.maxX - bbox.minX : null, height: bbox ? bbox.maxY - bbox.minY : null,
      diameter: shape?.[0] === 'ELLIPSE' && shape[1] === shape[2] ? shape[1] : undefined,
      hole: stateValue(row, 'Hole', null),
    });
  }
  const counts = new Map<string, number>();
  for (const p of pads) if (p.net) counts.set(p.net, (counts.get(p.net) ?? 0) + 1);
  const limit = params.limit === undefined ? pads.length : Math.max(0, Math.floor(params.limit));
  return { totalPads: rows.length, matchedPads: pads.length, returnedPads: Math.min(limit, pads.length),
    pads: pads.slice(0, limit), nets: [...counts].map(([name, padCount]) => ({ name, padCount })) };
}

async function getTracks(params: any = {}): Promise<any> {
  const tracks = (await eda.pcb_PrimitiveLine.getAll(params.net, params.layer)).map((r: any) => ({
    primitiveId: stateValue(r, 'PrimitiveId'), net: stateValue(r, 'Net', ''), layer: stateValue(r, 'Layer'),
    startX: stateValue(r, 'StartX'), startY: stateValue(r, 'StartY'),
    endX: stateValue(r, 'EndX'), endY: stateValue(r, 'EndY'), width: stateValue(r, 'LineWidth'),
  }));
  return { tracks, count: tracks.length };
}

async function getNetPrimitives(params: any): Promise<any> {
  const { tracks } = await getTracks({ net: params.net });
  const { pads } = await getPads({ nets: [params.net] });
  const vias = (await eda.pcb_PrimitiveVia.getAll()).filter((r: any) => stateValue(r, 'Net') === params.net).map((r: any) => ({
    primitiveId: stateValue(r, 'PrimitiveId'), x: stateValue(r, 'X'), y: stateValue(r, 'Y'),
    holeDiameter: stateValue(r, 'HoleDiameter'), diameter: stateValue(r, 'Diameter'),
  }));
  return { tracks, pads, vias };
}

async function getBoardInfo(): Promise<any> {
  const b = await eda.dmt_Board.getCurrentBoardInfo();
  if (!b) throw new Error('当前文档不属于板子');
  return { name: b.name, schematicUuid: b.schematic?.uuid ?? '', pcbUuid: b.pcb?.uuid ?? '' };
}

async function selectComponent(params: any): Promise<any> {
  const rows = (await eda.pcb_PrimitiveComponent.getAll()).filter((c: any) => stateValue(c, 'Designator') === params.designator);
  if (rows.length !== 1) throw new Error('位号不存在或不唯一: ' + params.designator);
  const id = stateValue(rows[0], 'PrimitiveId');
  await eda.pcb_SelectControl.clearSelected();
  if (!await eda.pcb_SelectControl.doSelectPrimitives([id])) throw new Error('选择失败');
  return { selected: params.designator, primitiveId: id };
}

async function deleteSelected(): Promise<any> {
  const rows = await eda.pcb_SelectControl.getAllSelectedPrimitives();
  const groups = new Map<string, string[]>();
  // Preflight every primitive before deleting anything. Component pads are owned
  // by components and cannot be sent to the standalone-pad delete API.
  for (const row of rows) {
    const type = stateValue(row, 'PrimitiveType');
    if (!['Component','Line','Arc','Via','Pad','String','Attribute','Pour','Region','Fill','Polyline','Image','Object','Dimension'].includes(type)
        || typeof eda['pcb_Primitive' + type]?.delete !== 'function') throw new Error('不支持删除选中图元类型: ' + type);
    if (stateValue(row, 'PrimitiveLock', false)) throw new Error('选中图元已锁定');
    const ids = groups.get(type) ?? [];
    ids.push(stateValue(row, 'PrimitiveId')); groups.set(type, ids);
  }
  const deletedIds = [];
  for (const [type, ids] of groups) {
    if (!await eda['pcb_Primitive' + type].delete(ids)) throw new Error('删除失败: ' + type + '；已删除: ' + deletedIds.join(','));
    deletedIds.push(...ids);
  }
  return { deleted: true, deletedCount: deletedIds.length, primitiveIds: deletedIds };
}

async function createVia(params: any): Promise<any> {
  const holeDiameter = params.holeDiameter ?? params.drill ?? 10;
  const diameter = params.diameter ?? 22;
  if (![params.x, params.y, holeDiameter, diameter].every(Number.isFinite) || holeDiameter <= 0 || diameter <= holeDiameter || !params.net) {
    throw new Error('过孔参数无效：坐标须为有限数，0 < 孔径 < 外径，网络不能为空');
  }
  const via = await eda.pcb_PrimitiveVia.create(params.net, params.x, params.y, holeDiameter, diameter, params.viaType, undefined, undefined, false);
  if (!via) throw new Error('过孔创建失败');
  return { primitiveId: stateValue(via, 'PrimitiveId'), net: params.net, x: params.x, y: params.y, holeDiameter, diameter };
}

async function routeEnvironment(net: string, layer: number, width: number, clearance: number): Promise<any> {
  const obstacles: Box[] = [], anchors: Box[] = [], unavailable: string[] = [], targets: RouteTarget[] = [];
  const { pads } = await getPads();
  for (const p of pads) {
    if (p.layer !== layer && p.layer !== 12) continue;
    if (!p.bbox) {unavailable.push(p.primitiveId);continue;}
    targets.push({kind:'pad',primitiveId:p.primitiveId,net:p.net,layer:p.layer,x:p.x,y:p.y,rotation:p.rotation,shape:p.shape,bbox:p.bbox});
    if (p.net === net) anchors.push(p.bbox);
    else obstacles.push(expandedBox(p.bbox,clearance+width/2));
  }
  // Pours are regenerated after writing. Their boundary boxes must not block
  // every route on a poured board. Fixed copper/keepout regions remain obstacles.
  for (const type of ['Line','Via','Arc','Fill','Region']) {
    const api=eda['pcb_Primitive'+type];
    if (!api?.getAll) continue;
    for (const row of await api.getAll()) {
      const rowLayer=type === 'Via' ? 12 : stateValue(row,'Layer');
      if (rowLayer !== layer && rowLayer !== 12) continue;
      const bbox=await primitiveBBox(row);
      if (!bbox) {unavailable.push(stateValue(row,'PrimitiveId',type));continue;}
      if (type==='Via') targets.push({kind:'via',primitiveId:stateValue(row,'PrimitiveId'),net:stateValue(row,'Net',''),layer:12,
        x:stateValue(row,'X'),y:stateValue(row,'Y'),diameter:stateValue(row,'Diameter'),bbox});
      if (type==='Line') targets.push({kind:'track',primitiveId:stateValue(row,'PrimitiveId'),net:stateValue(row,'Net',''),layer:rowLayer,
        start:{x:stateValue(row,'StartX'),y:stateValue(row,'StartY')},end:{x:stateValue(row,'EndX'),y:stateValue(row,'EndY')},width:stateValue(row,'LineWidth'),bbox});
      if (stateValue(row,'Net','') === net) anchors.push(bbox);
      else obstacles.push(expandedBox(bbox,clearance+width/2));
    }
  }
  if (unavailable.length) throw new Error('无法读取障碍外框，停止走线：'+unavailable.join(','));
  const outlines=await eda.pcb_PrimitiveLine.getAll(undefined,11);
  if (eda.pcb_PrimitivePolyline?.getAll) {
    for (const row of await eda.pcb_PrimitivePolyline.getAll()) if (stateValue(row,'Layer') === 11) outlines.push(row);
  }
  const rawBounds=outlines.length ? await eda.pcb_Primitive.getPrimitivesBBox(outlines) : null;
  const bounds=rawBounds ? expandedBox(rawBounds,-clearance-width/2) : undefined;
  return {obstacles,anchors,targets,bounds,boardBoundsAvailable:!!bounds};
}

async function prepareTrack(params: any): Promise<any> {
  const width=params.width ?? 10, clearance=params.clearance ?? 6;
  if (!params.net || typeof params.net !== 'string' || !Number.isInteger(params.layer) || params.layer <= 0
      || !Number.isFinite(width) || width <= 0 || !Number.isFinite(clearance) || clearance < 0)
    throw new Error('网络、层号、线宽或间距无效');
  // Validate before any environment read, and keep original index semantics.
  prepareRoutePath(params.points,params);
  validateEndpointOptions(params);
  const env=await routeEnvironment(params.net,params.layer,width,clearance);
  const resolved=resolveRouteEndpoints(params.points,params.net,params.layer,width,env.targets,params);
  const protectedIndices=new Set<number>(params.protectedIndices ?? []);
  resolved.points.forEach((p: Point,i: number)=>{
    if (env.anchors.some((b: Box)=>p.x>=b.minX && p.x<=b.maxX && p.y>=b.minY && p.y<=b.maxY)) protectedIndices.add(i);
  });
  const prepared=prepareRoutePath(resolved.points,{...params,protectedIndices:[...protectedIndices]},env.obstacles,env.bounds);
  prepared.issues.unshift(...resolved.issues);
  prepared.ready=!prepared.issues.some(i=>i.severity==='error');
  prepared.changed=prepared.changed || resolved.endpoints.some(e=>e.displacementMil>1e-7);
  if (!env.boardBoundsAvailable) prepared.issues.push({kind:'board_bounds_unavailable',severity:'warning',index:0,
    message:'没有可读取的板框外框；板边距离需由原生 DRC 核对'});
  return {...prepared,endpoints:resolved.endpoints,endpointMode:params.endpointMode??'auto',net:params.net,layer:params.layer,width,clearance,
    boardBoundsAvailable:env.boardBoundsAvailable,obstacleModel:'conservative_fixed_copper_bboxes',
    note:'先解析焊盘/过孔中心或走线中心线，再按角度及障碍约束整理；端点移动受 maxEndpointExtension 限制，maxDeviation 相对端点修正后的路径。铺铜将在写入后重建；此检查不替代原生 DRC。'};
}

async function routeTrack(params: any): Promise<any> {
  const prepared=await prepareTrack(params);
  if (params.dryRun) return {...prepared,dryRun:true,createdSegments:0,primitiveIds:[]};
  if (!prepared.ready) throw new Error('路径预检未通过，未创建走线：'+JSON.stringify(prepared.issues));
  const width=prepared.width, points: Point[]=prepared.points;
  const ids: string[] = [];
  try {
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a.x === b.x && a.y === b.y) continue;
      const row = await eda.pcb_PrimitiveLine.create(params.net, params.layer, a.x, a.y, b.x, b.y, width, false);
      if (!row) throw new Error('EDA 未返回走线图元');
      ids.push(stateValue(row, 'PrimitiveId'));
    }
  } catch (error: any) { throw new Error('走线未完成；已创建图元 ' + ids.join(',') + '：' + error.message); }
  const postWriteIssues: any[]=[];
  try {
    const pours=eda.pcb_PrimitivePour?.getAll ? await eda.pcb_PrimitivePour.getAll() : [];
    for (const pour of pours) {
      try {await pour.rebuildCopperRegion();}
      catch (e: any) {postWriteIssues.push({kind:'pour_rebuild_failed',message:e.message});}
    }
  } catch (e: any) {postWriteIssues.push({kind:'pour_rebuild_failed',message:e.message});}
  let geometryVerified=false, actualSegments: any[]=[], missingPrimitiveIds: string[]=ids;
  try {
    const {tracks}=await getTracks({net:params.net,layer:params.layer});
    actualSegments=tracks.filter((t: any)=>ids.includes(t.primitiveId));
    missingPrimitiveIds=ids.filter(id=>!actualSegments.some(t=>t.primitiveId===id));
    for (const t of actualSegments) {
      const issues=inspectRoutePath([{x:t.startX,y:t.startY},{x:t.endX,y:t.endY}],prepared.options);
      postWriteIssues.push(...issues.map(i=>({...i,primitiveId:t.primitiveId})));
    }
    // Native joining/splitting can replace IDs. Missing objects must not be
    // reported as successfully checked; use the whole-board audit after routing.
    geometryVerified=!missingPrimitiveIds.length && !postWriteIssues.some(i=>i.severity==='error' || i.kind==='pour_rebuild_failed');
  } catch (e: any) {postWriteIssues.push({kind:'readback_failed',message:e.message});}
  const endpointsVerified=geometryVerified && prepared.endpoints.every((e:any)=>actualSegments.some((t:any)=>
    routePointDistance(e.point,{x:t.startX,y:t.startY},{x:t.endX,y:t.endY})<=.001));
  if (!endpointsVerified) postWriteIssues.push({kind:'endpoint_readback_unverified',severity:'warning',message:'未能在全部保留 ID 的实际导线上确认端点锚点；请运行端点检查及 DRC'});
  return {...prepared,endpointsVerified,dryRun:false,createdSegments:ids.length,primitiveIds:ids,actualSegments,
    geometryVerified,missingPrimitiveIds,postWriteIssues,requiresDrc:true,
    verificationScope:'retained_created_segment_angles; use check_route_geometry for junctions and replaced IDs'};
}

async function checkRouteGeometry(params: any = {}): Promise<any> {
  if (params.nets !== undefined && (!Array.isArray(params.nets) || params.nets.some((n:any)=>typeof n !== 'string')))
    throw new Error('nets 必须是网络名称数组');
  if (params.layer !== undefined && (!Number.isInteger(params.layer) || params.layer <= 0)) throw new Error('层号无效');
  const options=resolveRouteOptions(params);
  const {tracks}=await getTracks({layer:params.layer});
  const filter=new Set<string>(params.nets ?? []);
  const selected=tracks.filter((t: any)=>t.net && (!filter.size || filter.has(t.net)));
  const issues: any[]=[],nodes: {net:string;layer:number;point:Point;edges:any[]}[]=[];
  for (const t of selected) {
    const a={x:t.startX,y:t.startY},b={x:t.endX,y:t.endY};
    issues.push(...inspectRoutePath([a,b],options).map(i=>({...i,primitiveIds:[t.primitiveId],net:t.net,layer:t.layer})));
    for (const [point,other] of [[a,b],[b,a]]) {
      let node=nodes.find(n=>n.net===t.net && n.layer===t.layer && Math.hypot(n.point.x-point.x,n.point.y-point.y)<=.001);
      if (!node) {node={net:t.net,layer:t.layer,point,edges:[]};nodes.push(node);}
      node.edges.push({id:t.primitiveId,other});
    }
  }
  const {pads}=await getPads();
  const anchors=pads.filter((p:any)=>p.bbox).map((p:any)=>({net:p.net,layer:p.layer,bbox:p.bbox}));
  for (const v of await eda.pcb_PrimitiveVia.getAll()) {
    const bbox=await primitiveBBox(v);
    if (bbox) anchors.push({net:stateValue(v,'Net'),layer:12,bbox});
  }
  let junctionsExcluded=0,anchorCorners=0;
  for (const node of nodes) {
    if (node.edges.length!==2) {if (node.edges.length>2) junctionsExcluded++;continue;}
    const atAnchor=anchors.some((a:any)=>a.net===node.net && (a.layer===12 || a.layer===node.layer)
      && node.point.x>=a.bbox.minX && node.point.x<=a.bbox.maxX && node.point.y>=a.bbox.minY && node.point.y<=a.bbox.maxY);
    const cornerIssues=inspectRoutePath([node.edges[0].other,node.point,node.edges[1].other],options,
      atAnchor ? [node.point] : []).filter(i=>['right_angle','sharp_turn','backtrack'].includes(i.kind));
    if (atAnchor && cornerIssues.length) anchorCorners++;
    issues.push(...cornerIssues.map(i=>({...i,primitiveIds:node.edges.map(e=>e.id),net:node.net,layer:node.layer,point:node.point})));
  }
  return {trackCount:selected.length,issues,passed:!issues.some(i=>i.severity==='error'),
    errors:issues.filter(i=>i.severity==='error').length,warnings:issues.filter(i=>i.severity==='warning').length,
    junctionsExcluded,anchorCorners,options,readOnly:true,
    note:'只检查线段角度、短线段及同层端点处的二度转角；焊盘/过孔锚点转角单独提示，多分支连接不当作普通拐角。'};
}

async function checkRouteEndpoints(params: any = {}): Promise<any> {
  if (params.nets!==undefined && (!Array.isArray(params.nets) || params.nets.some((n:any)=>typeof n!=='string'))) throw Error('nets 必须是网络名称数组');
  if (params.layer!==undefined && (!Number.isInteger(params.layer) || params.layer<=0)) throw Error('层号无效');
  const selected=(net:string,layer:number)=>!!net && (!params.nets?.length || params.nets.includes(net))
    && (params.layer===undefined || layer===12 || layer===params.layer);
  const targets:RouteTarget[]=[];
  for (const p of (await getPads()).pads) if(selected(p.net,p.layer)) targets.push({kind:'pad',primitiveId:p.primitiveId,
    net:p.net,layer:p.layer,x:p.x,y:p.y,shape:p.shape,rotation:p.rotation,bbox:p.bbox});
  for (const t of (await getTracks()).tracks) if(selected(t.net,t.layer)) targets.push({kind:'track',primitiveId:t.primitiveId,
    net:t.net,layer:t.layer,start:{x:t.startX,y:t.startY},end:{x:t.endX,y:t.endY},width:t.width});
  for (const v of await eda.pcb_PrimitiveVia.getAll()) if(selected(stateValue(v,'Net',''),12)) targets.push({kind:'via',primitiveId:stateValue(v,'PrimitiveId'),
    net:stateValue(v,'Net'),layer:12,x:stateValue(v,'X'),y:stateValue(v,'Y'),diameter:stateValue(v,'Diameter')});
  return inspectRouteEndpoints(targets,params.toleranceMil??.1);
}

async function relocateComponent(params: any): Promise<any> {
  if (![params.x, params.y].every(Number.isFinite)) throw new Error('移动坐标无效');
  const rows = (await eda.pcb_PrimitiveComponent.getAll()).filter((c: any) => stateValue(c, 'Designator') === params.designator);
  if (rows.length !== 1 || stateValue(rows[0], 'PrimitiveLock')) throw new Error('元件不存在、不唯一或已锁定');
  const { pads } = await getPads({ designator: params.designator });
  const nets: string[] = [...new Set(pads.map((p: any) => p.net).filter(Boolean))] as string[];
  const deletedTracks: string[] = [];
  for (const net of nets) {
    const { tracks } = await getTracks({ net });
    for (const t of tracks) {
      const touches = pads.some((p: any) => p.net === net && (p.layer === 12 || p.layer === t.layer)
        && [[t.startX, t.startY], [t.endX, t.endY]].some(([x,y]) => p.bbox
          ? x >= p.bbox.minX && x <= p.bbox.maxX && y >= p.bbox.minY && y <= p.bbox.maxY
          : Math.hypot(x - p.x, y - p.y) < 0.001));
      if (touches) deletedTracks.push(t.primitiveId);
    }
  }
  if (deletedTracks.length && !await eda.pcb_PrimitiveLine.delete(deletedTracks)) throw new Error('断开走线失败，元件未移动');
  const rotation = params.rotation ?? stateValue(rows[0], 'Rotation', 0);
  if (!await eda.pcb_PrimitiveComponent.modify(stateValue(rows[0], 'PrimitiveId'), { x: params.x, y: params.y, rotation })) throw new Error('元件移动失败');
  return { moved: params.designator, x: params.x, y: params.y, rotation, deletedTracks, deletedTrackCount: deletedTracks.length, netsToReroute: nets };
}

function flattenDrc(items: any[], path: string[] = [], inheritedSeverity = 'error'): any[] {
  const result: any[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const names = [...path, String(item.name ?? '')].filter(Boolean);
    const severity = /warn|警告/i.test(String(item.severity ?? item.name ?? '')) ? 'warning' : inheritedSeverity;
    if (Array.isArray(item.list)) { result.push(...flattenDrc(item.list, names, severity)); continue; }
    const detail = item.explanation?.errData ?? {};
    const rule = String(item.rule ?? item.errorType ?? path[0] ?? item.name ?? 'Unknown');
    let message = String(item.message ?? item.description ?? item.explanation?.str ?? item.name ?? rule);
    for (const [k, v] of Object.entries(item.explanation?.param ?? {})) message = message.split('{' + k + '}').join(String(v));
    const primitiveIds = [...new Set([...(item.primitiveIds ?? item.objs ?? []), detail.obj1, detail.obj2].filter((id: any) => typeof id === 'string' && id))];
    result.push({ severity, rule, message, primitiveIds, net: item.net ?? detail.net ?? null,
      connectionError: /connection|unrout|unconnect|no connection|连接错误|未连接|未布线/i.test(rule + ' ' + (detail.errorType ?? '')),
      path: names, raw: item });
  }
  return result;
}

async function runDRC(): Promise<any> {
  const raw = await eda.pcb_Drc.check(true, false, true);
  if (typeof raw === 'boolean') return { passed: raw, totalCount: raw ? 0 : null, detailsAvailable: false,
    summary: { errors: raw ? 0 : null, warnings: 0, infos: 0, unknown: raw ? 0 : 1 }, issues: [] };
  if (!Array.isArray(raw)) throw new Error('未知 DRC 返回格式，无法判断通过与否');
  const issues = flattenDrc(raw).map((r, i) => ({ index: i + 1, ...r }));
  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warning').length;
  return { passed: errors === 0, totalCount: issues.length, detailsAvailable: true,
    summary: { errors, warnings, infos: 0, unknown: 0 }, issues };
}

async function getNetlist(params: any = {}): Promise<any> {
  const type = params.type ?? 'Protel2';
  const netlist = await eda.sch_Netlist.getNetlist(type);
  if (typeof netlist !== 'string' || !netlist.trim()) throw new Error('未取得原理图网表，请确认当前打开的是原理图页且存在有效元件');
  return { netlist, type };
}

async function getSchematicState(): Promise<any> {
  const components = [], pins = [];
  for (const c of await eda.sch_PrimitiveComponent.getAll(undefined, true)) {
    const designator = stateValue(c, 'Designator', '');
    if (!designator) continue; // Title blocks/net flags are not BOM components.
    const id = stateValue(c, 'PrimitiveId');
    components.push({ primitiveId: id, designator, ...componentIdentity(c), x: stateValue(c,'X'), y: stateValue(c,'Y') });
    for (const p of await c.getAllPins() ?? []) {
      pins.push({ primitiveId: stateValue(p,'PrimitiveId'), parentPrimitiveId: id, designator,
        pinNumber: String(stateValue(p,'PinNumber',stateValue(p,'Number',''))), pinName: stateValue(p,'PinName',stateValue(p,'Name','')),
        net: stateValue(p,'Net',null), x: stateValue(p,'X'), y: stateValue(p,'Y') });
    }
  }
  const wires = (await eda.sch_PrimitiveWire.getAll()).map((w: any) => ({ primitiveId: stateValue(w,'PrimitiveId'), net: stateValue(w,'Net','') }));
  return { components, pins, wires };
}
