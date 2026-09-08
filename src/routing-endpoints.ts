import { routePointDistance, sameRoutePoint, type Point, type Box, type RouteIssue } from './routing-geometry.js';

export interface RouteTarget {
  kind: 'pad' | 'via' | 'track';
  primitiveId: string;
  net: string;
  layer: number;
  x?: number;
  y?: number;
  rotation?: number;
  shape?: unknown[];
  diameter?: number;
  start?: Point;
  end?: Point;
  width?: number;
  bbox?: Box;
}
export interface EndpointBinding { kind: 'pad' | 'via' | 'track' | 'free'; primitiveId?: string }
export interface RouteEndpointOptions {
  endpointMode?: 'auto' | 'preserve';
  start?: EndpointBinding;
  end?: EndpointBinding;
  maxEndpointExtension?: number;
}
export interface ResolvedEndpoint {
  original: Point;
  point: Point;
  target: EndpointBinding;
  displacementMil: number;
}

// These helpers are also serialized into the EDA runtime by port-plugin.mjs.
export function projectRoutePoint(p: Point, a: Point, b: Point): Point {
  const dx=b.x-a.x,dy=b.y-a.y,d=dx*dx+dy*dy;
  const t=d ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/d)) : 0;
  return {x:a.x+t*dx,y:a.y+t*dy};
}

/** Distance to the actual copper, NOT its bounding box. Supported pad shapes
 * are convex; rotation is applied about the native pad origin. */
export function routeTargetDistance(p: Point, target: RouteTarget): number {
  if (target.kind==='track') {
    if (!target.start || !target.end || !Number.isFinite(target.width) || target.width! <= 0) return Infinity;
    return Math.max(0,routePointDistance(p,target.start,target.end)-target.width!/2);
  }
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) return Infinity;
  const dx=p.x-target.x!,dy=p.y-target.y!;
  if (target.kind==='via') return Number.isFinite(target.diameter) && target.diameter! > 0
    ? Math.max(0,Math.hypot(dx,dy)-target.diameter!/2) : Infinity;
  const shape=target.shape ?? [],w=Number(shape[1]),h=Number(shape[2]);
  if (![w,h,target.rotation??0].every(Number.isFinite) || w<=0 || h<=0) return Infinity;
  const angle=(target.rotation??0)*Math.PI/180;
  const x=Math.abs(dx*Math.cos(angle)+dy*Math.sin(angle)),y=Math.abs(-dx*Math.sin(angle)+dy*Math.cos(angle));
  if (shape[0]==='RECT' && shape.slice(3).some(v=>v!==0)) return Infinity; // Unknown corner/shape modifiers: do not guess.
  if (shape[0]==='RECT') return Math.hypot(Math.max(0,x-w/2),Math.max(0,y-h/2));
  if (shape[0]==='OVAL') return w>=h ? Math.max(0,Math.hypot(Math.max(0,x-(w-h)/2),y)-h/2)
    : Math.max(0,Math.hypot(x,Math.max(0,y-(h-w)/2))-w/2);
  if (shape[0]!=='ELLIPSE') return Infinity;
  const a=w/2,b=h/2;
  if ((x/a)**2+(y/b)**2<=1) return 0;
  if (Math.abs(a-b)<1e-10) return Math.max(0,Math.hypot(x,y)-a);
  // Closest point on an ellipse via a monotone Lagrange-multiplier equation.
  let lo=0,hi=Math.max(a*x,b*y,a*a,b*b);
  const f=(t:number)=>(a*x/(t+a*a))**2+(b*y/(t+b*b))**2;
  while (f(hi)>1) hi*=2;
  for (let i=0;i<60;i++) {const mid=(lo+hi)/2;if(f(mid)>1)lo=mid;else hi=mid;}
  return Math.hypot(x-a*a*x/(hi+a*a),y-b*b*y/(hi+b*b));
}

export function routeTargetAnchor(p: Point, target: RouteTarget): Point {
  return target.kind==='track' ? projectRoutePoint(p,target.start!,target.end!) : {x:target.x!,y:target.y!};
}

export function validateEndpointOptions(options: RouteEndpointOptions): void {
  if (options.endpointMode!==undefined && !['auto','preserve'].includes(options.endpointMode)) throw Error('未知端点模式');
  if (!Number.isFinite(options.maxEndpointExtension??100) || (options.maxEndpointExtension??100)<0)
    throw Error('maxEndpointExtension 必须为有限非负 mil 数值');
  for (const binding of [options.start,options.end]) {
    if (binding===undefined) continue;
    if (!binding || !['pad','via','track','free'].includes(binding.kind)) throw Error('端点 kind 必须为 pad/via/track/free');
    if (binding.kind==='free' ? binding.primitiveId!==undefined : typeof binding.primitiveId!=='string' || !binding.primitiveId)
      throw Error('焊盘/过孔/走线端点必须指定 primitiveId；free 端点不接受 primitiveId');
  }
}

export function resolveRouteEndpoints(points: Point[], net: string, layer: number, width: number,
  targets: RouteTarget[], options: RouteEndpointOptions = {}): {points: Point[]; endpoints: ResolvedEndpoint[]; issues: RouteIssue[]} {
  validateEndpointOptions(options);
  if (!Array.isArray(points) || points.length<2 || points.some(p=>!p || !Number.isFinite(p.x) || !Number.isFinite(p.y))
      || !net || !Number.isInteger(layer) || layer<=0 || !Number.isFinite(width) || width<=0) throw Error('端点解析参数无效');
  const output=points.map(p=>({...p})),endpoints:ResolvedEndpoint[]=[],issues:RouteIssue[]=[];
  for (const [index,binding] of [[0,options.start],[points.length-1,options.end]] as [number,EndpointBinding|undefined][]) {
    const original=points[index];let selected:RouteTarget|undefined;
    const failure=(kind:string,message:string)=>issues.push({kind,severity:'error',index,message});
    if (binding && binding.kind!=='free') {
      selected=targets.find(t=>t.kind===binding.kind && t.primitiveId===binding.primitiveId);
      if (!selected) failure('endpoint_target_missing','指定端点图元不存在：'+binding.primitiveId);
      else if (selected.net!==net || (selected.layer!==12 && selected.layer!==layer)) {
        failure('endpoint_target_mismatch','端点图元网络或铜层不匹配：'+binding.primitiveId);selected=undefined;
      }
    } else if (!binding && options.endpointMode!=='preserve') {
      const eligible=targets.filter(t=>t.net===net && (t.layer===12 || t.layer===layer));
      // Unsupported pad geometry cannot safely be guessed from a bbox corner.
      if (eligible.some(t=>t.kind==='pad' && !Number.isFinite(routeTargetDistance(original,t)) && (!t.bbox
          || (original.x>=t.bbox.minX-width/2 && original.x<=t.bbox.maxX+width/2
          && original.y>=t.bbox.minY-width/2 && original.y<=t.bbox.maxY+width/2))))
        failure('endpoint_shape_unsupported','端点附近有不支持的焊盘形状；请提供经核实的 free 端点或使用受支持的焊盘');
      // Only touching copper is inferred. Do not attract a free end to a nearby
      // but unrelated pad, even when it has the same net name.
      let touching=eligible.filter(t=>routeTargetDistance(original,t)<=width/2+1e-7);
      // Preserve an already exact via-in-pad anchor instead of dragging it to
      // the exposed pad's different centre. Ordinary edge contacts still prefer pads.
      const exactCenters=touching.filter(t=>t.kind!=='track' && sameRoutePoint(original,routeTargetAnchor(original,t)));
      if (exactCenters.length) touching=exactCenters;
      for (const kind of ['pad','via','track']) {
        let candidates=touching.filter(t=>t.kind===kind);
        if (kind==='track') {
          const exact=candidates.filter(t=>sameRoutePoint(original,routeTargetAnchor(original,t)));
          if (exact.length) candidates=exact;
        }
        if (!candidates.length) continue;
        const positions=candidates.map(t=>routeTargetAnchor(original,t));
        if (positions.some(p=>!sameRoutePoint(p,positions[0])))
          failure('endpoint_ambiguous','端点接触多个不同连接位置，请用 start/end 指定图元 ID');
        else selected=candidates[0];
        break;
      }
    }
    let point={...original};
    if (selected) {
      const candidate=Number.isFinite(routeTargetDistance(original,selected)) ? routeTargetAnchor(original,selected) : {x:NaN,y:NaN};
      if (![candidate.x,candidate.y].every(Number.isFinite) || !Number.isFinite(routeTargetDistance(candidate,selected))) {
        failure('endpoint_shape_unsupported','不能安全解析端点图元几何：'+selected.primitiveId);selected=undefined;
      } else if (Math.hypot(candidate.x-original.x,candidate.y-original.y)>(options.maxEndpointExtension??100)+1e-7) {
        failure('endpoint_extension_limit','端点到锚点的距离超过 maxEndpointExtension');selected=undefined;
      } else point=candidate;
    }
    output[index]=point;
    endpoints.push({original:{...original},point,target:selected ? {kind:selected.kind,primitiveId:selected.primitiveId} : {kind:'free'},
      displacementMil:Math.hypot(point.x-original.x,point.y-original.y)});
  }
  return {points:output,endpoints,issues};
}

/** Convex copper shapes make distance along a segment convex. This is used only
 * for the read-only attachment audit, not as a substitute for PCB DRC. */
export function routeSegmentTargetDistance(a: Point, b: Point, target: RouteTarget): number {
  if (target.kind==='via') return Math.max(0,routePointDistance({x:target.x!,y:target.y!},a,b)-target.diameter!/2);
  let lo=0,hi=1;
  const at=(t:number)=>routeTargetDistance({x:a.x+t*(b.x-a.x),y:a.y+t*(b.y-a.y)},target);
  for (let i=0;i<48;i++) {const u=(2*lo+hi)/3,v=(lo+2*hi)/3;if(at(u)<=at(v))hi=v;else lo=u;}
  return Math.min(at(0),at(1),at((lo+hi)/2));
}

export function inspectRouteEndpoints(targets: RouteTarget[], toleranceMil = .1): any {
  if (!Number.isFinite(toleranceMil) || toleranceMil<0 || toleranceMil>1) throw Error('端点检查容差必须在 0–1 mil 之间');
  const issues:any[]=[],unclassifiedEndpoints:any[]=[];
  const unsupportedTargets=targets.filter(t=>!Number.isFinite(routeTargetDistance(t.kind==='track' ? t.start??{x:NaN,y:NaN} : {x:t.x!,y:t.y!},t))).map(t=>t.primitiveId);
  const tracks=targets.filter(t=>t.kind==='track' && !unsupportedTargets.includes(t.primitiveId));
  let checkedAttachments=0;
  for (const target of targets.filter(t=>t.kind!=='track' && !unsupportedTargets.includes(t.primitiveId))) {
    const touching=tracks.filter(t=>t.net===target.net && (target.layer===12 || t.layer===target.layer)
      && routeSegmentTargetDistance(t.start!,t.end!,target)<=t.width!/2+1e-7);
    if (!touching.length) continue;
    checkedAttachments++;
    const center=routeTargetAnchor({x:target.x!,y:target.y!},target);
    const distance=Math.min(...touching.map(t=>routePointDistance(center,t.start!,t.end!)));
    if (distance>toleranceMil) issues.push({kind:target.kind+'_off_center',severity:'warning',net:target.net,layer:target.layer,
      targetPrimitiveId:target.primitiveId,primitiveIds:touching.map(t=>t.primitiveId),point:center,distanceMil:distance,
      message:'导线铜面接触目标，但导线中心线未到达目标中心；宽铜、特殊焊盘及有意偏心入口需要人工复核'});
  }
  for (const t of tracks) for (const point of [t.start!,t.end!]) {
    const others=targets.filter(o=>o.primitiveId!==t.primitiveId && o.net===t.net && (o.layer===12 || o.layer===t.layer));
    if (others.some(o=>o.kind!=='track' && routeTargetDistance(point,o)<=t.width!/2+1e-7)) continue;
    const lines=others.filter(o=>o.kind==='track');
    if (lines.some(o=>routePointDistance(point,o.start!,o.end!)<=toleranceMil)) continue;
    const touching=lines.filter(o=>routeTargetDistance(point,o)<=t.width!/2+1e-7);
    if (touching.length) {
      checkedAttachments++;
      issues.push({kind:'track_edge_attachment',severity:'warning',net:t.net,layer:t.layer,primitiveIds:[t.primitiveId,...touching.map(o=>o.primitiveId)],
        point,distanceMil:Math.min(...touching.map(o=>routePointDistance(point,o.start!,o.end!))),
        message:'导线端点只搭接已有导线铜面，未接入其中心线'});
    } else unclassifiedEndpoints.push({primitiveId:t.primitiveId,net:t.net,layer:t.layer,point});
  }
  return {passed:issues.length===0 && unsupportedTargets.length===0,issues,warnings:issues.length,checkedAttachments,
    unsupportedTargets,unclassifiedEndpoints,toleranceMil,readOnly:true,
    note:'检查真实支持形状和导线中心线；偏心连接是复核提示，不直接判为开路。铺铜/弧线/填充及自由端点未作连通性判断，仍须原生 DRC；不自动改线。'};
}
