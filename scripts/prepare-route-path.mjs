#!/usr/bin/env node
// Offline counterpart of route_track. JSON stdin/stdout, all coordinates in mil.
// Does not connect to EDA or write a board. Callers must supply obstacles and/or
// independently check exact copper geometry before applying the result.
import fs from 'node:fs';
import {resolveRouteEndpoints,routeTargetDistance} from '../dist/routing-endpoints.js';
import {prepareRoutePath} from '../dist/routing-geometry.js';
const input=JSON.parse(fs.readFileSync(0,'utf8'));
const targets=[...(input.targets??[])],results=[];
for (const [index,p] of input.paths.entries()) {
  const options={...input.options,...p.options};
  const bound=resolveRouteEndpoints(p.points,p.net,p.layer,p.width,targets,options);
  const protectedIndices=new Set(options.protectedIndices??[]);
  bound.points.forEach((point,i)=>{if(targets.some(t=>t.net===p.net&&(t.layer===12||t.layer===p.layer)&&routeTargetDistance(point,t)<=1e-7))protectedIndices.add(i);});
  const result=prepareRoutePath(bound.points,{...options,protectedIndices:[...protectedIndices]},p.obstacles??input.obstacles??[],p.bounds??input.bounds);
  result.issues.unshift(...bound.issues);result.ready=!result.issues.some(i=>i.severity==='error');
  result.changed ||= bound.endpoints.some(e=>e.displacementMil>1e-7);
  results.push({...p,...result,endpoints:bound.endpoints});
  if(!result.ready)break;
  for(let i=1;i<result.points.length;i++)targets.push({kind:'track',primitiveId:`offline:${index}:${i}`,net:p.net,layer:p.layer,
    start:result.points[i-1],end:result.points[i],width:p.width});
}
process.stdout.write(JSON.stringify({ready:results.length===input.paths.length&&results.every(r=>r.ready),paths:results})+'\n');
