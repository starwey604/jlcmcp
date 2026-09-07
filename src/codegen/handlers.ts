/** Official EDA handlers. scripts/port-plugin.mjs serializes these functions and
 * their helper dependencies into generated.ts. Keep them independent of Node.
 */
declare const eda: any;
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

async function routeTrack(params: any): Promise<any> {
  const width = params.width ?? 10;
  if (!Array.isArray(params.points) || params.points.length < 2 || !Number.isFinite(width) || width <= 0
      || !params.points.every((p: any) => Number.isFinite(p.x) && Number.isFinite(p.y))) throw new Error('走线路径或线宽无效');
  const ids: string[] = [];
  try {
    for (let i = 1; i < params.points.length; i++) {
      const a = params.points[i - 1], b = params.points[i];
      if (a.x === b.x && a.y === b.y) continue;
      const row = await eda.pcb_PrimitiveLine.create(params.net, params.layer, a.x, a.y, b.x, b.y, width, false);
      if (!row) throw new Error('EDA 未返回走线图元');
      ids.push(stateValue(row, 'PrimitiveId'));
    }
  } catch (error: any) { throw new Error('走线未完成；已创建图元 ' + ids.join(',') + '：' + error.message); }
  return { createdSegments: ids.length, primitiveIds: ids };
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
