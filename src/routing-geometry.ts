export interface Point { x: number; y: number }
export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export interface CopperObstacle { bbox: Box; net: string; layer: number; width?: number }

export interface RouteOptions {
  angleMode?: 'octilinear' | 'orthogonal' | 'free';
  cornerStyle?: 'chamfer' | 'preserve';
  chamferDistance?: number;
  minSegmentLength?: number;
  maxDeviation?: number;
  angleToleranceDeg?: number;
  protectedIndices?: number[];
}
export interface RouteIssue {
  kind: string;
  severity: 'error' | 'warning';
  index: number;
  message: string;
  value?: number;
}
export interface RoutePreparation {
  points: Point[];
  changed: boolean;
  issues: RouteIssue[];
  ready: boolean;
  lengthMil: number;
  options: Required<RouteOptions>;
}

// Keep helpers self-contained: port-plugin.mjs also serializes them into the
// EDA handler. Coordinates stay in mil; pad/via anchors are never grid-rounded.
export function resolveRouteOptions(options: RouteOptions = {}): Required<RouteOptions> {
  const angleMode = options.angleMode ?? 'octilinear';
  const cornerStyle = options.cornerStyle ?? (angleMode === 'octilinear' ? 'chamfer' : 'preserve');
  if (!['octilinear', 'orthogonal', 'free'].includes(angleMode)
      || !['chamfer', 'preserve'].includes(cornerStyle)) throw new Error('未知走线角度或转角模式');
  if (cornerStyle === 'chamfer' && angleMode !== 'octilinear') throw new Error('45° 倒角仅适用于 octilinear 模式');
  const result: Required<RouteOptions> = { angleMode, cornerStyle, chamferDistance: options.chamferDistance ?? 10,
    minSegmentLength: options.minSegmentLength ?? 1, maxDeviation: options.maxDeviation ?? 10,
    angleToleranceDeg: options.angleToleranceDeg ?? 0.01, protectedIndices: options.protectedIndices ?? [] };
  for (const key of ['chamferDistance', 'minSegmentLength', 'maxDeviation', 'angleToleranceDeg'] as const) {
    if (!Number.isFinite(result[key]) || result[key] < 0) throw new Error(key + ' 必须为有限非负数');
  }
  if (cornerStyle === 'chamfer' && result.chamferDistance === 0) throw new Error('倒角距离必须大于 0');
  if (result.angleToleranceDeg > 1) throw new Error('角度检查容差不得大于 1°');
  if (!Array.isArray(result.protectedIndices) || result.protectedIndices.some(i => !Number.isInteger(i) || i < 0))
    throw new Error('protectedIndices 必须为路径点的非负整数下标');
  return result;
}

export function sameRoutePoint(a: Point, b: Point): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= 1e-7;
}

export function routeAngleDeviation(a: Point, b: Point, mode: RouteOptions['angleMode'] = 'octilinear'): number {
  if (mode === 'free' || sameRoutePoint(a, b)) return 0;
  const step = mode === 'orthogonal' ? 90 : 45;
  const angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
  return Math.abs(((angle % step) + step + step / 2) % step - step / 2);
}

export function routeSegmentAllowed(a: Point, b: Point, mode: RouteOptions['angleMode']): boolean {
  const dx = Math.abs(b.x - a.x), dy = Math.abs(b.y - a.y);
  return mode === 'free' || dx <= 1e-7 || dy <= 1e-7
    || (mode === 'octilinear' && Math.abs(dx - dy) <= 1e-7);
}

export function routeTurn(a: Point, b: Point, c: Point): number {
  const ux = b.x-a.x, uy = b.y-a.y, vx = c.x-b.x, vy = c.y-b.y;
  const length = Math.hypot(ux,uy)*Math.hypot(vx,vy);
  return length <= 1e-14 ? 0 : Math.acos(Math.max(-1,Math.min(1,(ux*vx+uy*vy)/length))) * 180 / Math.PI;
}

export function routePointDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x-a.x, dy = b.y-a.y, length2 = dx*dx+dy*dy;
  const t = length2 ? Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/length2)) : 0;
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
}

export function routePathClear(points: Point[], boxes: Box[], bounds?: Box): boolean {
  return points.every(p => !bounds || (p.x >= bounds.minX && p.x <= bounds.maxX && p.y >= bounds.minY && p.y <= bounds.maxY))
    && points.slice(1).every((b,i) => !boxes.some(box => segmentHitsBox(points[i],b,box)));
}

export function routeCircleInterval(a: Point, b: Point, center: Point, radius: number): number[] | null {
  const dx=b.x-a.x,dy=b.y-a.y,px=a.x-center.x,py=a.y-center.y;
  const aa=dx*dx+dy*dy,bb=2*(px*dx+py*dy),cc=px*px+py*py-radius*radius;
  if (aa<=1e-14) return cc<=0 ? [0,1] : null;
  const discriminant=bb*bb-4*aa*cc;
  if (discriminant<0) return null;
  const lo=Math.max(0,(-bb-Math.sqrt(discriminant))/(2*aa));
  const hi=Math.min(1,(-bb+Math.sqrt(discriminant))/(2*aa));
  return lo<=hi ? [lo,hi] : null;
}

/** Exact interval coverage by a union of reference-segment capsules. Checking
 * just vertices would miss a shortcut that crosses the empty middle of a U. */
export function routeSegmentWithinDeviation(a: Point, b: Point, reference: Point[], deviation: number): boolean {
  const intervals: number[][]=[],radius=deviation+1e-7;
  for (let i=1;i<reference.length;i++) {
    const c=reference[i-1],e=reference[i],length=Math.hypot(e.x-c.x,e.y-c.y);
    for (const center of [c,e]) {
      const interval=routeCircleInterval(a,b,center,radius);
      if (interval) intervals.push(interval);
    }
    if (length<=1e-7) continue;
    const ux=(e.x-c.x)/length,uy=(e.y-c.y)/length;
    let lo=0,hi=1;
    for (const [start,delta,min,max] of [
      [(a.x-c.x)*ux+(a.y-c.y)*uy,(b.x-a.x)*ux+(b.y-a.y)*uy,0,length],
      [-(a.x-c.x)*uy+(a.y-c.y)*ux,-(b.x-a.x)*uy+(b.y-a.y)*ux,-radius,radius],
    ]) {
      if (Math.abs(delta)<1e-12) {if (start<min || start>max) {hi=-1;break;}continue;}
      const t1=(min-start)/delta,t2=(max-start)/delta;
      lo=Math.max(lo,Math.min(t1,t2));hi=Math.min(hi,Math.max(t1,t2));
      if (lo>hi) break;
    }
    if (lo<=hi) intervals.push([lo,hi]);
  }
  intervals.sort((x,y)=>x[0]-y[0]);
  let covered=0;
  for (const [lo,hi] of intervals) {
    if (lo>covered+1e-12) return false;
    covered=Math.max(covered,hi);
    if (covered>=1-1e-12) return true;
  }
  return false;
}

export function inspectRoutePath(points: Point[], options: RouteOptions = {}, anchors: Point[] = []): RouteIssue[] {
  const opts = resolveRouteOptions(options), issues: RouteIssue[] = [];
  if (points.length < 2 || points.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
    return [{kind:'invalid_path',severity:'error',index:0,message:'路径至少需要两个有限坐标点'}];
  for (let i=1;i<points.length;i++) {
    const length = Math.hypot(points[i].x-points[i-1].x,points[i].y-points[i-1].y);
    const deviation = routeAngleDeviation(points[i-1],points[i],opts.angleMode);
    if (length <= 1e-7) issues.push({kind:'zero_length',severity:'error',index:i-1,message:'零长度线段'});
    else if (length < opts.minSegmentLength) issues.push({kind:'short_segment',severity:'warning',index:i-1,
      value:length,message:'短线段未被安全消除；可能受连接锚点或障碍限制'});
    if (deviation > opts.angleToleranceDeg) issues.push({kind:'off_angle',severity:'error',index:i-1,
      value:deviation,message:'线段偏离所选角度约束'});
  }
  for (let i=1;i<points.length-1;i++) {
    const turn = routeTurn(points[i-1],points[i],points[i+1]);
    if (turn <= 45.01) continue;
    const protectedCorner = anchors.some(a => sameRoutePoint(a,points[i]));
    issues.push({kind:turn > 179.99 ? 'backtrack' : Math.abs(turn-90) < .01 ? 'right_angle' : 'sharp_turn',
      severity:opts.cornerStyle === 'chamfer' && !protectedCorner ? 'error' : 'warning',index:i,value:turn,
      message:protectedCorner ? '连接锚点处保留转角' : '路径仍有大于 45° 的转向'});
  }
  return issues;
}

export function routeLegCandidates(a: Point, b: Point, mode: RouteOptions['angleMode']): Point[][] {
  if (routeSegmentAllowed(a,b,mode)) return [[a,b]];
  const candidates = [[a,{x:b.x,y:a.y},b],[a,{x:a.x,y:b.y},b]];
  if (mode === 'octilinear') {
    const dx=b.x-a.x, dy=b.y-a.y, d=Math.min(Math.abs(dx),Math.abs(dy));
    candidates.unshift([a,{x:b.x-Math.sign(dx)*d,y:b.y-Math.sign(dy)*d},b],
      [a,{x:a.x+Math.sign(dx)*d,y:a.y+Math.sign(dy)*d},b]);
  }
  return candidates.map(cleanPath);
}

export function simplifyRoutePath(points: Point[], anchors: Point[], boxes: Box[], options: Required<RouteOptions>, bounds?: Box): Point[] {
  const result = [points[0]];
  for (let i=0;i<points.length-1;) {
    let chosen = i+1;
    // Never shortcut across a requested connection anchor or outside the local
    // deviation budget. Recheck the whole replacement segment against obstacles.
    for (let j=i+2;j<Math.min(points.length,i+65);j++) {
      if (anchors.some(a => sameRoutePoint(a,points[j-1]))) break;
      if (!routeSegmentAllowed(points[i],points[j],options.angleMode)) continue;
      const direct = Math.hypot(points[j].x-points[i].x,points[j].y-points[i].y);
      if (direct <= 1e-7 || direct > pathLength(points.slice(i,j+1))+1e-7) continue;
      if (points.slice(i+1,j).some(p => routePointDistance(p,points[i],points[j]) > options.maxDeviation+1e-7)) continue;
      if (routePathClear([points[i],points[j]],boxes,bounds)) chosen=j;
    }
    result.push(points[chosen]);i=chosen;
  }
  return cleanPath(result);
}

export function chamferRoutePath(points: Point[], anchors: Point[], boxes: Box[], options: Required<RouteOptions>, bounds?: Box): Point[] {
  if (options.cornerStyle !== 'chamfer') return points;
  const result=[points[0]];
  for (let i=1;i<points.length-1;i++) {
    const a=points[i-1], b=points[i], c=points[i+1];
    if (Math.abs(routeTurn(a,b,c)-90) > .001 || anchors.some(p => sameRoutePoint(p,b))) {result.push(b);continue;}
    const left=Math.hypot(b.x-a.x,b.y-a.y), right=Math.hypot(c.x-b.x,c.y-b.y);
    const ux=(b.x-a.x)/left, uy=(b.y-a.y)/left, vx=(c.x-b.x)/right, vy=(c.y-b.y)/right;
    // Each end consumes at most 40% of its segment, so adjacent chamfers cannot overlap.
    let cut=Math.min(options.chamferDistance,options.maxDeviation,left*.4,right*.4);
    let replaced=false;
    while (cut > 1e-7 && cut*Math.SQRT2 >= options.minSegmentLength) {
      const before={x:b.x-ux*cut,y:b.y-uy*cut}, after={x:b.x+vx*cut,y:b.y+vy*cut};
      if (routeSegmentAllowed(before,after,options.angleMode) && routePathClear([result[result.length-1],before,after,c],boxes,bounds)) {
        result.push(before,after);replaced=true;break;
      }
      cut/=2;
    }
    if (!replaced) result.push(b); // inspectRoutePath reports an unhandled corner as an error.
  }
  result.push(points[points.length-1]);return cleanPath(result);
}

export function prepareRoutePath(input: Point[], options: RouteOptions = {}, boxes: Box[] = [], bounds?: Box): RoutePreparation {
  const opts=resolveRouteOptions(options);
  if (!Array.isArray(input) || input.length < 2 || input.length > 4096
      || input.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) throw new Error('路径须包含 2–4096 个有限坐标点');
  if (opts.protectedIndices.some(i => i >= input.length)) throw new Error('protectedIndices 超出路径点范围');
  const original=input.map(p=>({x:p.x,y:p.y}));
  const anchors=[original[0],original[original.length-1],...opts.protectedIndices.map(i=>original[i])];
  const points=cleanPath(original);
  const issues: RouteIssue[]=[];
  let normalized: Point[]=[points[0]];
  for (let i=1;i<points.length;i++) {
    const a=points[i-1],b=points[i];
    const candidates=routeLegCandidates(a,b,opts.angleMode).filter(p=>
      p.every(q=>routePointDistance(q,a,b)<=opts.maxDeviation+1e-7) && routePathClear(p,boxes,bounds));
    candidates.sort((a,b)=>pathLength(a)-pathLength(b) || a.length-b.length);
    if (!candidates.length) {
      issues.push({kind:'blocked_leg',severity:'error',index:i-1,message:'角度约束、偏移范围及障碍条件内没有可用过渡；未强连'});
      normalized.push(b);
    } else normalized.push(...candidates[0].slice(1));
  }
  if (!issues.length) {
    normalized=simplifyRoutePath(normalized,anchors,boxes,opts,bounds);
    normalized=chamferRoutePath(normalized,anchors,boxes,opts,bounds);
  }
  issues.push(...inspectRoutePath(normalized,opts,anchors));
  if (normalized.slice(1).some((b,i)=>!routeSegmentWithinDeviation(normalized[i],b,original,opts.maxDeviation)))
    issues.push({kind:'deviation_limit',severity:'error',index:0,message:'整理后的线段超出原始路径的偏移范围'});
  if (!routePathClear(normalized,boxes,bounds)) issues.push({kind:'obstacle_or_edge',severity:'error',index:0,message:'整理后路径触及障碍或超出板框边界'});
  return {points:normalized,changed:original.length!==normalized.length || original.some((p,i)=>!normalized[i] || !sameRoutePoint(p,normalized[i])),
    issues,ready:!issues.some(i=>i.severity==='error'),lengthMil:pathLength(normalized),options:opts};
}

export function cleanPath(points: Point[]): Point[] {
  return points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
}

export function pathLength(points: Point[]): number {
  return points.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - points[i].x, p.y - points[i].y), 0);
}

// Segment/slab clipping, also handles point segments and diagonal existing tracks.
export function segmentHitsBox(a: Point, b: Point, box: Box): boolean {
  let lo = 0, hi = 1;
  for (const [start, delta, min, max] of [[a.x,b.x-a.x,box.minX,box.maxX],[a.y,b.y-a.y,box.minY,box.maxY]]) {
    if (Math.abs(delta) < 1e-12) { if (start < min || start > max) return false; continue; }
    const t1 = (min - start) / delta, t2 = (max - start) / delta;
    lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2));
    if (lo > hi) return false;
  }
  return true;
}

export function expandedBox(b: Box, margin: number): Box {
  return { minX: b.minX-margin, minY: b.minY-margin, maxX: b.maxX+margin, maxY: b.maxY+margin };
}

export function segmentBox(a: Point, b: Point, width: number): Box {
  return expandedBox({minX:Math.min(a.x,b.x),minY:Math.min(a.y,b.y),maxX:Math.max(a.x,b.x),maxY:Math.max(a.y,b.y)},width/2);
}

/** Bounded candidate router with shared angle/corner preparation. */
export function planRoute(a: Point, b: Point, boxes: Box[], options: RouteOptions = {}, bounds?: Box): Point[] | null {
  a = { x:a.x, y:a.y }; b = { x:b.x, y:b.y };
  const candidates: Point[][] = [[a,b],[a,{x:b.x,y:a.y},b],[a,{x:a.x,y:b.y},b]];
  if (boxes.length) {
    const xs = [Math.min(a.x,b.x,...boxes.map(o=>o.minX))-1, Math.max(a.x,b.x,...boxes.map(o=>o.maxX))+1];
    const ys = [Math.min(a.y,b.y,...boxes.map(o=>o.minY))-1, Math.max(a.y,b.y,...boxes.map(o=>o.maxY))+1];
    for (const o of boxes.slice(0,64)) { xs.push(o.minX-1,o.maxX+1); ys.push(o.minY-1,o.maxY+1); }
    for (const x of new Set(xs)) candidates.push([a,{x,y:a.y},{x,y:b.y},b]);
    for (const y of new Set(ys)) candidates.push([a,{x:a.x,y},{x:b.x,y},b]);
  }
  const valid = candidates.map(p=>prepareRoutePath(p,options,boxes,bounds)).filter(p=>p.ready);
  const turnPenalty=resolveRouteOptions(options).minSegmentLength;
  valid.sort((x,y)=>(x.lengthMil+Math.max(0,x.points.length-2)*turnPenalty)
    -(y.lengthMil+Math.max(0,y.points.length-2)*turnPenalty));
  return valid[0]?.points ?? null;
}
