import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveRouteEndpoints,routeTargetDistance,inspectRouteEndpoints} from '../dist/routing-endpoints.js';
import {prepareRoutePath,routeSegmentAllowed} from '../dist/routing-geometry.js';
import {actionToCode} from '../dist/codegen.js';
import {registerRoutingTools,endpointBindingSchema} from '../dist/tools/routing.js';
const pad=(id,x,y,shape=['RECT',20,20],extras={})=>({kind:'pad',primitiveId:id,net:'N',layer:1,x,y,rotation:0,shape,...extras});
const via=(id,x,y)=>({kind:'via',primitiveId:id,net:'N',layer:12,x,y,diameter:20});
const track=(id,a,b,width=6)=>({kind:'track',primitiveId:id,net:'N',layer:1,start:a,end:b,width});
const point=(x,y)=>({x,y});
const bind=(points,targets,options={})=>resolveRouteEndpoints(points,'N',1,4,targets,options);
const near=(a,b,tol=1e-7)=>assert(Math.hypot(a.x-b.x,a.y-b.y)<=tol,`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
const row=v=>Object.fromEntries(Object.entries(v).map(([k,x])=>['getState_'+k,()=>x]));
const execute=(eda,action,p={})=>new (Object.getPrototypeOf(async function(){}).constructor)('eda',actionToCode(action,p))(eda);
function fixture(targets=[],modifyCreated=t=>t) {
 const rows=targets.map(t=>row({PrimitiveId:t.primitiveId,PrimitiveType:t.kind==='pad'?'Pad':t.kind==='via'?'Via':'Line',Net:t.net,Layer:t.layer,
   X:t.x,Y:t.y,Pad:t.shape,Rotation:t.rotation??0,PadNumber:'1',Diameter:t.diameter,
   StartX:t.start?.x,StartY:t.start?.y,EndX:t.end?.x,EndY:t.end?.y,LineWidth:t.width}));
 const lines=rows.filter(r=>r.getState_PrimitiveType()==='Line'),pads=rows.filter(r=>r.getState_PrimitiveType()==='Pad'),vias=rows.filter(r=>r.getState_PrimitiveType()==='Via');
 let writes=0,rebuilds=0;
 const eda={pcb_PrimitiveComponent:{getAll:async()=>[]},pcb_PrimitivePad:{getAll:async()=>pads},pcb_PrimitiveVia:{getAll:async()=>vias},
 pcb_PrimitiveLine:{getAll:async(net,layer)=>lines.filter(t=>(!net||t.getState_Net()===net)&&(layer===undefined||t.getState_Layer()===layer)),
 create:async(net,layer,x,y,xx,yy,width)=>{const t=row(modifyCreated({PrimitiveId:'created'+(++writes),PrimitiveType:'Line',Net:net,Layer:layer,StartX:x,StartY:y,EndX:xx,EndY:yy,LineWidth:width}));lines.push(t);return t;}},
 pcb_PrimitivePolyline:{getAll:async()=>[row({PrimitiveType:'Polyline',Layer:11})]},
 pcb_PrimitivePour:{getAll:async()=>[{rebuildCopperRegion:async()=>{rebuilds++;}}]},
 pcb_Primitive:{getPrimitivesBBox:async([t])=>{
  if(t.getState_PrimitiveType()==='Polyline')return {minX:-500,minY:-500,maxX:500,maxY:500};
  if(t.getState_PrimitiveType()==='Line') {const r=t.getState_LineWidth()/2;return {minX:Math.min(t.getState_StartX(),t.getState_EndX())-r,minY:Math.min(t.getState_StartY(),t.getState_EndY())-r,maxX:Math.max(t.getState_StartX(),t.getState_EndX())+r,maxY:Math.max(t.getState_StartY(),t.getState_EndY())+r};}
  const x=t.getState_X(),y=t.getState_Y(),w=t.getState_Pad()?.[1]??t.getState_Diameter(),h=t.getState_Pad()?.[2]??w;
  return {minX:x-w/2,minY:y-h/2,maxX:x+w/2,maxY:y+h/2};
 }}};
 return {eda,counts:()=>({writes,rebuilds}),lines};
}

test('pad edges and pad corners bind native centres; centre coordinates are never grid rounded',()=>{
 const targets=[pad('a',.013,0),pad('b',100.017,20.019)];
 const r=bind([point(9.9,9.9),point(90.1,10.1)],targets);
 assert.deepEqual(r.issues,[]);near(r.points[0],point(.013,0));near(r.points[1],point(100.017,20.019));
 assert.deepEqual(r.endpoints.map(e=>e.target.primitiveId),['a','b']);
});
test('true rotated rectangle, oval and ellipse geometry do not snap bounding-box corners',()=>{
 const rotated=pad('rot',0,0,['RECT',20,4],{rotation:45});
 assert(routeTargetDistance(point(7,-7),rotated)>7);
 assert.equal(routeTargetDistance(point(5,5),rotated),0);
 const oval=pad('oval',0,0,['OVAL',20,4]),ellipse=pad('ellipse',0,0,['ELLIPSE',20,4]);
 assert(routeTargetDistance(point(9,2),oval)>0);assert(routeTargetDistance(point(9,2),ellipse)>0);
 near(bind([point(9,9),point(100,100)],[pad('circle',0,0,['ELLIPSE',20,20])]).points[0],point(9,9));
 assert(Math.abs(routeTargetDistance(point(12,0),ellipse)-2)<1e-7);
});
test('only touching same-net same-layer copper is inferred, not nearest pads',()=>{
 const p=point(10,0),r=bind([p,point(100,0)],[pad('wrong-net',10,0,undefined,{net:'OTHER'}),pad('wrong-layer',10,0,undefined,{layer:2}),pad('nearby',25,0)]);
 assert.deepEqual(r.points[0],p);assert.equal(r.endpoints[0].target.kind,'free');
});
test('via rim snaps to centre and a trace rim snaps to centreline',()=>{
 const r=bind([point(9,0),point(80,2)],[via('v',0,0),track('t',point(70,0),point(100,0))]);
 near(r.points[0],point(0,0));near(r.points[1],point(80,0));
 assert.deepEqual(r.endpoints.map(e=>e.target.kind),['via','track']);
});
test('explicit IDs reject net/layer/missing/unsupported targets and extension overreach',()=>{
 for(const [options,targets,kind] of [
  [{start:{kind:'pad',primitiveId:'x'}},[],'endpoint_target_missing'],
  [{start:{kind:'pad',primitiveId:'x'}},[pad('x',0,0,undefined,{net:'OTHER'})],'endpoint_target_mismatch'],
  [{start:{kind:'pad',primitiveId:'x'}},[pad('x',0,0,undefined,{layer:2})],'endpoint_target_mismatch'],
  [{start:{kind:'pad',primitiveId:'x'}},[pad('x',0,0,['CUSTOM',20,20])],'endpoint_shape_unsupported'],
  [{start:{kind:'track',primitiveId:'x'}},[{kind:'track',primitiveId:'x',net:'N',layer:1}],'endpoint_shape_unsupported'],
  [{start:{kind:'pad',primitiveId:'x'},maxEndpointExtension:5},[pad('x',0,0)],'endpoint_extension_limit'],
 ])assert(bind([point(9,0),point(100,0)],targets,options).issues.some(i=>i.kind===kind));
});
test('ambiguous touching pads require ID selection; exact track junctions remain valid',()=>{
 const targets=[pad('a',0,0),pad('b',18,0)];
 assert(bind([point(9,0),point(100,0)],targets).issues.some(i=>i.kind==='endpoint_ambiguous'));
 assert.deepEqual(bind([point(9,0),point(100,0)],targets,{start:{kind:'pad',primitiveId:'b'}}).points[0],point(18,0));
 const lines=[track('a',point(0,0),point(20,0)),track('b',point(10,1),point(10,20))];
 assert.deepEqual(bind([point(10,0),point(30,0)],lines).issues,[]);
});
test('free and preserve are explicit escapes; explicit binding still wins over preserve',()=>{
 const targets=[pad('a',0,0),pad('b',100,0)],points=[point(9,0),point(91,0)];
 assert.deepEqual(bind(points,targets,{endpointMode:'preserve'}).points,points);
 assert.deepEqual(bind(points,targets,{start:{kind:'free'},end:{kind:'free'}}).points,points);
 near(bind(points,targets,{endpointMode:'preserve',start:{kind:'pad',primitiveId:'a'}}).points[0],point(0,0));
});
test('original SWDIO edge endpoints become two native pad centres with valid angles',()=>{
 const mm=.0254,A=point(12.2301/mm,20.39874/mm),B=point(12.25042/mm,17.00022/mm);
 const r=bind([point(12.2/mm,19.9/mm),point(12.2/mm,17.4/mm)],[pad('J2.2',A.x,A.y,['ELLIPSE',1/mm,1/mm]),pad('U1.24',B.x,B.y,['RECT',.25/mm,.8/mm])]);
 const prepared=prepareRoutePath(r.points);assert.deepEqual(r.issues,[]);assert(prepared.ready);near(prepared.points[0],A);near(prepared.points.at(-1),B);
 assert(prepared.points.slice(1).every((p,i)=>routeSegmentAllowed(prepared.points[i],p,'octilinear')));
});
test('generated EDA dry-run returns centre bindings and performs zero writes/rebuilds',async()=>{
 const f=fixture([pad('a',0,0),pad('b',100,0)]);
 const r=await execute(f.eda,'route_track',{net:'N',layer:1,width:4,points:[point(9,0),point(91,0)],dryRun:true});
 assert(r.ready);assert(r.changed);near(r.points[0],point(0,0));near(r.points.at(-1),point(100,0));assert.deepEqual(f.counts(),{writes:0,rebuilds:0});
});
test('generated EDA write uses corrected coordinates and verifies their readback',async()=>{
 const f=fixture([pad('a',0,0),pad('b',100,0)]);
 const r=await execute(f.eda,'route_track',{net:'N',layer:1,width:4,points:[point(9,0),point(91,0)]});
 assert.equal(f.lines[0].getState_StartX(),0);assert.equal(f.lines[0].getState_EndX(),100);assert(r.endpointsVerified);assert(r.geometryVerified);
});
test('obstacle introduced by an endpoint correction rejects before any write',async()=>{
 const f=fixture([pad('a',0,0),pad('b',100,0),pad('obstacle',50,0,['RECT',2,2],{net:'OTHER'})]);
 const r=await execute(f.eda,'route_track',{net:'N',layer:1,width:2,clearance:0,points:[point(9,9),point(91,9)],dryRun:true});
 assert(!r.ready);await assert.rejects(execute(f.eda,'route_track',{net:'N',layer:1,width:2,clearance:0,points:[point(9,9),point(91,9)]}));assert.equal(f.counts().writes,0);
});
test('native readback that truncates corrected endpoints is not reported verified',async()=>{
 const f=fixture([pad('a',0,0),pad('b',100,0)],t=>({...t,StartX:t.StartX+3}));
 const r=await execute(f.eda,'route_track',{net:'N',layer:1,width:4,points:[point(9,0),point(91,0)]});
 assert(!r.endpointsVerified);assert(r.postWriteIssues.some(i=>i.kind==='endpoint_readback_unverified'));
});
test('read-only audit distinguishes pad/via edge attachments, centre crossings and line caps',()=>{
 const targets=[pad('p',0,0),via('v',100,0),track('edge',point(9,0),point(91,0)),track('main',point(150,0),point(180,0)),track('branch',point(165,2),point(165,20))];
 const r=inspectRouteEndpoints(targets);assert(!r.passed);assert(r.issues.some(i=>i.kind==='pad_off_center'));assert(r.issues.some(i=>i.kind==='via_off_center'));assert(r.issues.some(i=>i.kind==='track_edge_attachment'));
 const good=inspectRouteEndpoints([pad('p',0,0),track('through',point(-20,0),point(20,0))]);assert(good.passed);
});
test('EDA endpoint audit filters networks/layers and cannot mutate the board',async()=>{
 const f=fixture([pad('p',0,0),track('edge',point(9,0),point(80,0)),pad('other',150,0,undefined,{net:'OTHER'})]);
 const r=await execute(f.eda,'check_route_endpoints',{nets:['N'],layer:1});assert(r.issues.some(i=>i.kind==='pad_off_center'));assert(r.issues.every(i=>i.net==='N'));assert.deepEqual(f.counts(),{writes:0,rebuilds:0});
 assert((await execute(f.eda,'check_route_endpoints',{nets:['OTHER']})).passed);
});
test('MCP schemas expose endpoint bindings and forward audit arguments',async()=>{
 const handlers=new Map(),calls=[];
 registerRoutingTools({tool:(n,d,s,h)=>handlers.set(n,h)},{command:async(n,p)=>{calls.push([n,p]);return {};}});
 const p={net:'N',layer:1,width:4,points:[point(0,0),point(100,0)],start:{kind:'pad',primitiveId:'a'},end:{kind:'free'},maxEndpointExtension:50,dryRun:true};
 await handlers.get('pcb_route_track')(p);assert.deepEqual(calls[0],['route_track',p]);
 await handlers.get('pcb_check_route_endpoints')({nets:['N'],toleranceMil:.1});assert.equal(calls[1][0],'check_route_endpoints');
 assert(!endpointBindingSchema.safeParse({kind:'pad'}).success);assert(!endpointBindingSchema.safeParse({kind:'free',primitiveId:'a'}).success);
});
test('invalid endpoint options are rejected consistently before drawing',async()=>{
 for (const options of [{endpointMode:'nearest'},{maxEndpointExtension:Infinity},{maxEndpointExtension:-1},{start:{kind:'bad'}},{start:{kind:'free',primitiveId:'a'}}]) {
  assert.throws(()=>bind([point(0,0),point(100,0)],[],options));
 }
});

test('unknown pad shapes and invalid tracks cannot produce a clean endpoint audit',()=>{
 const r=inspectRouteEndpoints([pad('custom',0,0,['CUSTOM',10,10]),track('bad',point(0,0),point(10,0),NaN)]);
 assert(!r.passed);assert.deepEqual(r.unsupportedTargets,['custom','bad']);
});

test('offline CLI shares endpoint correction and keeps intermediate via connections',async()=>{
 const {spawnSync}=await import('node:child_process');
 const payload={targets:[pad('a',0,0),pad('b',100,100),via('mid',50,30)],paths:[{net:'N',layer:1,width:4,
  points:[point(9,0),point(50,0),point(50,30),point(50,100),point(91,100)]}],options:{maxDeviation:50,cornerStyle:'preserve'}};
 const result=spawnSync(process.execPath,['scripts/prepare-route-path.mjs'],{input:JSON.stringify(payload),encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);const out=JSON.parse(result.stdout);assert(out.ready,JSON.stringify(out));
 near(out.paths[0].points[0],point(0,0));near(out.paths[0].points.at(-1),point(100,100));
 assert(out.paths[0].points.some(p=>p.x===50&&p.y===30));
});

test('exact exposed-pad via anchors remain at the via centre, not the large pad centre',()=>{
 const r=bind([point(8,0),point(100,0)],[pad('ep',0,0,['RECT',40,40]),via('thermal',8,0)]);
 near(r.points[0],point(8,0));assert.equal(r.endpoints[0].target.primitiveId,'thermal');
});

test('nonzero unsupported pad shape modifiers cannot be inferred as plain rectangles',()=>{
 const r=bind([point(9,9),point(100,0)],[pad('modified',0,0,['RECT',20,20,5])]);
 assert(r.issues.some(i=>i.kind==='endpoint_shape_unsupported'));
});

test('endpoints collapsing onto one pad reject as zero-length instead of writing a stub',async()=>{
 const f=fixture([pad('a',0,0)]),params={net:'N',layer:1,width:4,points:[point(9,0),point(-9,0)]};
 const r=await execute(f.eda,'route_track',{...params,dryRun:true});assert(!r.ready);
 await assert.rejects(execute(f.eda,'route_track',params));assert.equal(f.counts().writes,0);
});
