export interface Point { x: number; y: number }
export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export interface CopperObstacle { bbox: Box; net: string; layer: number; width?: number }

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

/** Bounded orthogonal candidate router. A rejected path is never replaced with
 * an unchecked direct line. Boxes conservatively cover pad/track copper. */
export function planRoute(a: Point, b: Point, boxes: Box[]): Point[] | null {
  a = { x:a.x, y:a.y }; b = { x:b.x, y:b.y };
  const candidates: Point[][] = [[a,b],[a,{x:b.x,y:a.y},b],[a,{x:a.x,y:b.y},b]];
  if (boxes.length) {
    const xs = [Math.min(a.x,b.x,...boxes.map(o=>o.minX))-1, Math.max(a.x,b.x,...boxes.map(o=>o.maxX))+1];
    const ys = [Math.min(a.y,b.y,...boxes.map(o=>o.minY))-1, Math.max(a.y,b.y,...boxes.map(o=>o.maxY))+1];
    for (const o of boxes.slice(0,64)) { xs.push(o.minX-1,o.maxX+1); ys.push(o.minY-1,o.maxY+1); }
    for (const x of new Set(xs)) candidates.push([a,{x,y:a.y},{x,y:b.y},b]);
    for (const y of new Set(ys)) candidates.push([a,{x:a.x,y},{x:b.x,y},b]);
  }
  const valid = candidates.map(cleanPath).filter(p => p.slice(1).every((b,i) =>
    (p[i].x === b.x || p[i].y === b.y) && !boxes.some(box=>segmentHitsBox(p[i],b,box))));
  valid.sort((x,y)=>pathLength(x)-pathLength(y));
  return valid[0] ?? null;
}
