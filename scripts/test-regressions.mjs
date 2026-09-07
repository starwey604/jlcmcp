import test from 'node:test';
import assert from 'node:assert/strict';
import { actionToCode } from '../dist/codegen.js';
import { calcImpedance, calcWidthForImpedance, calcTraceWidth, calcCurrentCapacity } from '../dist/calculators.js';
import { planRoute, segmentHitsBox, pathLength } from '../dist/routing-geometry.js';
import { parseSourceRecords } from '../dist/source-records.js';
import { protel2Signature } from '../dist/netlist.js';
import { registerRoutingTools } from '../dist/tools/routing.js';
import { registerAdvancedTools } from '../dist/tools/advanced.js';
import * as pro from '../dist/tools/pro.js';

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const execute = (eda, action, params = {}) => new AsyncFunction('eda', actionToCode(action, params))(eda);
const row = values => Object.fromEntries(Object.entries(values).map(([k, v]) => ['getState_' + k, () => v]));
const bbox = (x, y, r = 5) => ({ minX:x-r, minY:y-r, maxX:x+r, maxY:y+r });
function fixture() {
  // Desktop objects: local pad IDs in components, global IDs in pad objects,
  // no getState_ParentComponentPrimitiveId or component Width/Height getter.
  const components = ['R1','R2'].map((des,i) => row({ PrimitiveId:'c'+i, Designator:des, Name:'={Value}',
    Component:{ name:'RES10K' }, OtherProperty:{Value:'10k'}, Footprint:{name:'R0402'},
    X:i*200, Y:0, Layer:1, PrimitiveType:'Component', PrimitiveLock:false,
    Pads:[{primitiveId:'e12',padNumber:'2',net:'P'},{primitiveId:'e13',padNumber:'1',net:'N'}] }));
  const pads = components.flatMap((c,i)=> [row({ PrimitiveId:'c'+i+'e12', PadNumber:'2', Net:'P', X:i*200+20,Y:0,Layer:1,Pad:['RECT',10,10] }),
    row({ PrimitiveId:'c'+i+'e13',PadNumber:'1',Net:'N',X:i*200-20,Y:0,Layer:1,Pad:['RECT',10,10] })]);
  let selected=[];
  const lines=[row({PrimitiveId:'t1',Net:'P',Layer:1,StartX:20,StartY:0,EndX:70,EndY:0,LineWidth:12})];
  const drcRaw=[{name:'Errors',list:[{name:'Connection Errors',list:[
    {errorType:'Connection Error',net:'P',explanation:{str:'{a} disconnected',param:{a:'R1-2'},errData:{obj1:'c0e12',obj2:'c1e12'}}},
    {errorType:'Connection Error',net:'N',objs:['c0e13','c1e13']},
  ]},{name:'Clearance',list:[{errorType:'Clearance',objs:['t1','c0e13']}]}]}];
  const eda={
    pcb_PrimitiveComponent:{getAll:async()=>components, modify:async()=>components[0],delete:async ids=>{eda.deleted=ids;return true;}},
    pcb_PrimitivePad:{getAll:async()=>pads},
    pcb_Primitive:{getPrimitivesBBox:async([p])=>bbox(p.getState_X(),p.getState_Y(),p.getState_PrimitiveType?.()==='Component'?30:5)},
    pcb_PrimitiveLine:{getAll:async(net,layer)=>lines.filter(t=>(!net||t.getState_Net()===net)&&(layer===undefined||t.getState_Layer()===layer)),delete:async ids=>{eda.deletedTracks=ids;return true;}},
    pcb_PrimitiveVia:{getAll:async()=>[]},
    pcb_Layer:{getAllLayers:async()=>[{type:'SIGNAL',layerStatus:1},{type:'SIGNAL',layerStatus:2},{type:'SIGNAL',layerStatus:0}]},
    pcb_Net:{getAllNetsName:async()=>['P','N'],getNetLength:async()=>0},
    pcb_SelectControl:{clearSelected:async()=>{selected=[];return true;},doSelectPrimitives:async ids=>{selected=ids;return true;},getAllSelectedPrimitives:async()=>components.filter(c=>selected.includes(c.getState_PrimitiveId()))},
    pcb_Drc:{check:async()=>drcRaw},
  };
  const bridge={command:(action,params)=>execute(eda,action,params),executeRaw:code=>new AsyncFunction('eda',code)(eda)};
  return {eda,bridge,components,pads,lines,drcRaw};
}

test('MCP via drill and differential pair names reach the official APIs',async()=>{
  const handlers=new Map(), calls=[];
  const server={tool:(name,description,schema,handler)=>handlers.set(name,handler)};
  const bridge={command:async(action,params)=>{calls.push({action,params});return {};}};
  registerRoutingTools(server,bridge);registerAdvancedTools(server,bridge);
  await handlers.get('pcb_create_via')({net:'P',x:1,y:2,drill:16,diameter:30});
  let viaArgs;
  await execute({pcb_PrimitiveVia:{create:async(...args)=>{viaArgs=args;return row({PrimitiveId:'v1'});}}},calls[0].action,calls[0].params);
  assert.deepEqual(viaArgs.slice(0,5),['P',1,2,16,30]);
  await handlers.get('pcb_create_diff_pair')({name:'USB',posNet:'P',negNet:'N'});
  let pairArgs;
  await execute({pcb_Drc:{createDifferentialPair:async(...args)=>{pairArgs=args;return true;}}},calls[1].action,calls[1].params);
  assert.deepEqual(pairArgs,['USB','P','N']);
});

test('desktop local pad IDs resolve to their own component and actual pin number',async()=>{
  const {bridge}=fixture();const p=await bridge.command('get_pads',{designator:'R2'});
  assert.equal(p.matchedPads,2);assert.deepEqual(p.pads.map(p=>[p.parentPrimitiveId,p.pinNumber]),[['c1','2'],['c1','1']]);
  assert.equal((await bridge.command('get_pads',{designator:'missing'})).pads.length,0);
  const nl=await pro.netlistReport(bridge);assert.equal(nl.complete,true);assert.equal(nl.components[0].pins.length,2);
});

test('real line width, component metadata, bbox and enabled copper layer count',async()=>{
  const {bridge}=fixture();assert.equal((await bridge.command('get_tracks')).tracks[0].width,12);
  const s=await bridge.command('get_state');assert.equal(s.components[0].name,'RES10K');assert.equal(s.components[0].width,60);
  assert.equal(s.layerCount,2);assert.equal(s.boardBounds,null);
});

test('selection uses primitive IDs and deletion dispatches on official primitive type',async()=>{
  const {bridge,eda}=fixture();await bridge.command('select_component',{designator:'R2'});
  const r=await bridge.command('delete_selected');assert.equal(r.deletedCount,1);assert.deepEqual(eda.deleted,['c1']);
  await assert.rejects(bridge.command('select_component',{designator:'absent'}),/不存在/);
});

test('relocation disconnects only tracks whose endpoints touch owned pads',async()=>{
  const {bridge,eda}=fixture();const r=await bridge.command('relocate_component',{designator:'R1',x:50,y:50});
  assert.deepEqual(r.deletedTracks,['t1']);assert.deepEqual(eda.deletedTracks,['t1']);
});

test('nested DRC groups become leaf issues with net, message and primitive IDs',async()=>{
  const {bridge}=fixture();const r=await bridge.command('run_drc');assert.equal(r.totalCount,3);assert.equal(r.passed,false);
  assert.equal(r.issues[0].message,'R1-2 disconnected');assert.deepEqual(r.issues[0].primitiveIds,['c0e12','c1e12']);
  assert.equal(r.issues.filter(i=>i.connectionError).length,2);
});

test('one isolated track cannot make a disconnected network routed; nets filter applies',async()=>{
  const {bridge}=fixture();const r=await pro.checkConnectivity(bridge,{nets:['P']});assert.equal(r.totalNets,1);
  assert.equal(r.nets[0].trackCount,1);assert.equal(r.nets[0].status,'unrouted');
  const handlers=new Map();pro.registerProTools({tool:(n,d,s,h)=>handlers.set(n,h)},bridge);
  const mcp=await handlers.get('pcb_net_connectivity_check')({nets:['N']});assert.equal(JSON.parse(mcp.content[0].text).nets[0].net,'N');
});

test('DRC boolean failure is unknown, never fabricated as passed connectivity',async()=>{
  const {bridge,eda}=fixture();eda.pcb_Drc.check=async()=>false;
  assert.equal((await bridge.command('run_drc')).totalCount,null);
  assert.equal((await pro.checkConnectivity(bridge)).unknown,2);
});

test('overlapping real component bboxes are violations even with zero requested clearance',async()=>{
  const {bridge,eda}=fixture();eda.pcb_Primitive.getPrimitivesBBox=async()=>bbox(0,0,30);
  const c=await pro.componentClearanceCheck(bridge,{minClearance:0});assert.equal(c.violationCount,1);assert.equal(c.violations[0].overlap,true);
});

test('series segments do not sum their current capacity',async()=>{
  const {bridge,lines}=fixture();const first=(await pro.currentDensityReport(bridge)).report[0].estimatedCurrentA;
  lines.push(lines[0]);assert.equal((await pro.currentDensityReport(bridge)).report[0].estimatedCurrentA,first);
  assert.ok(first>0.5);assert.equal((await pro.currentDensityReport(bridge)).report[1].estimatedCurrentA,null);
});

test('blocked route returns null; valid detour keeps endpoints and avoids copper box',()=>{
  const a={x:0,y:0},b={x:100,y:0},box={minX:40,minY:-10,maxX:60,maxY:10};
  const p=planRoute(a,b,[box]);assert.deepEqual(p[0],a);assert.deepEqual(p.at(-1),b);
  assert.ok(p.slice(1).every((end,i)=>!segmentHitsBox(p[i],end,box)));assert.ok(pathLength(p)>100);
  assert.equal(planRoute(a,b,[bbox(0,0,5)]),null);
});

test('autorouter skips blocked nets without writing and honors final connection errors',async()=>{
  const {bridge,eda,lines,pads}=fixture();let writes=0;eda.pcb_PrimitiveLine.create=async()=>{writes++;return row({PrimitiveId:'new'});};
  pads.push(row({PrimitiveId:'block',Net:'OTHER',X:20,Y:0,Layer:1,Pad:['RECT',10,10]}));
  const r=await pro.autoRouteNets(bridge,{nets:['P'],clearance:5,width:6});assert.equal(writes,0);assert.equal(r.routedNets,0);assert.equal(r.skippedNets,1);
  pads.pop();lines.length=0;
  const draft=await pro.autoRouteNets(bridge,{nets:['P'],clearance:5,width:6});assert.ok(writes>0);assert.equal(draft.routedNets,0);assert.equal(draft.generatedNets,1);
});

test('differential draft preserves all four actual pad endpoints and measures generated paths',async()=>{
  const {bridge,eda,lines}=fixture();lines.length=0;
  eda.pcb_Drc.getAllDifferentialPairs=async()=>[{name:'D',positiveNet:'P',negativeNet:'N'}];
  eda.pcb_PrimitiveLine.create=async()=>row({PrimitiveId:'new'});
  const r=await pro.routeDifferentialPairs(bridge,{pairName:'D',gap:5,width:6});
  const p=r.pairs[0];assert.equal(p.couplingVerified,false);assert.equal(p.connected,false);
  for(const n of p.paths){assert.equal(n.paths[0][0].y,0);assert.equal(n.paths[0].at(-1).y,0);assert.equal(n.lengthMil,n.paths.reduce((s,p)=>s+pathLength(p),0));}
});

test('two-layer route places 22 mil vias with 12 mil holes at both SMD endpoints',async()=>{
  const {bridge,eda,lines}=fixture();lines.length=0;const vias=[];
  eda.pcb_PrimitiveVia.create=async(net,x,y,hole,diameter)=>{vias.push([x,y,hole,diameter]);return row({PrimitiveId:'via'});};
  eda.pcb_PrimitiveLine.create=async()=>row({PrimitiveId:'new'});
  const r=await pro.autoRouteNets(bridge,{nets:['P'],useVias:true,width:6,clearance:5});
  assert.deepEqual(vias,[[20,0,12,22],[220,0,12,22]]);assert.equal(r.totalVias,2);
});

test('MCP fanout and autorouting honor configurable via dimensions',async()=>{
  const {bridge,eda}=fixture();const calls=[],handlers=new Map();
  eda.pcb_PrimitiveVia.create=async(...args)=>{calls.push(args);return row({PrimitiveId:'via'});};
  eda.pcb_PrimitiveLine.create=async()=>row({PrimitiveId:'new'});
  pro.registerProTools({tool:(n,d,s,h)=>handlers.set(n,h)},bridge);
  await handlers.get('pcb_fanout_component')({designator:'R1',viaDrill:16,viaDiameter:30});
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c[3]===16&&c[4]===30));
  calls.length=0;
  await handlers.get('pcb_auto_route_nets')({nets:['P'],useVias:true,width:6,clearance:5,viaDrill:14,viaDiameter:28});
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c[3]===14&&c[4]===28));
});

test('via obstacle checks use the requested outer radius and reject invalid hole sizes before writing',async()=>{
  const {bridge,eda}=fixture();let writes=0;
  eda.pcb_PrimitiveVia.create=async()=>{writes++;return row({PrimitiveId:'via'});};
  eda.pcb_PrimitiveLine.create=async()=>{writes++;return row({PrimitiveId:'line'});};
  const r=await pro.autoRouteNets(bridge,{nets:['P'],useVias:true,width:6,clearance:5,viaDiameter:80});
  assert.equal(r.skippedNets,1);assert.equal(writes,0);
  await assert.rejects(pro.autoRouteNets(bridge,{useVias:true,viaDrill:22,viaDiameter:22}),/viaDrill/);
  await assert.rejects(pro.fanoutComponent(bridge,{designator:'R1',viaDrill:-1}),/viaDrill/);
  assert.equal(writes,0);
});

test('DRC timeout after routing retains generated paths and reports unverified connectivity',async()=>{
  const {bridge,eda,lines}=fixture();lines.length=0;
  eda.pcb_PrimitiveLine.create=async()=>row({PrimitiveId:'new'});
  eda.pcb_Drc.check=async()=>{throw new Error('DRC timeout');};
  const r=await pro.autoRouteNets(bridge,{nets:['P'],width:6,clearance:5});
  assert.equal(r.routedNets,0);assert.equal(r.generatedNets,1);assert.equal(r.drcError,'DRC timeout');
  assert.ok(r.nets[0].paths.length);
});

test('native records preserve || inside escaped text, multiline JSON, and report malformed records',()=>{
  const payload={text:'a || b | "quote"\nnext'};
  const raw=JSON.stringify({type:'STRING'})+'||'+JSON.stringify(payload,null,2)+'|\n{"type":"META"}||{}|\nnot-json\n';
  const p=parseSourceRecords(raw);assert.equal(p.recordCount,3);assert.equal(p.records.length,2);
  assert.deepEqual(p.records[0].data,payload);assert.equal(p.errors.length,1);
});

for(const type of ['microstrip','stripline','diff_microstrip','diff_stripline'])test(type+' impedance is positive, monotonic, and inverse returns the stated width',()=>{
  const params={type,width:8,height:6,spacing:8};const z=calcImpedance(params);assert.ok(z.impedance>0);
  assert.ok(calcImpedance({...params,width:9}).impedance<z.impedance);
  const inv=calcWidthForImpedance({...params,targetImpedance:z.impedance});assert.equal(calcImpedance({...params,width:inv.width}).impedance,inv.impedance);
  if(type.startsWith('diff_'))assert.ok(calcImpedance({...params,spacing:16}).impedance>z.impedance);
});

test('invalid electrical inputs and unreachable impedances reject explicitly',()=>{
  for(const width of [0,-1,Infinity,NaN,10000])assert.throws(()=>calcImpedance({type:'stripline',width,height:6}));
  assert.throws(()=>calcWidthForImpedance({type:'microstrip',targetImpedance:10000,height:6}),/不可达/);
  assert.throws(()=>calcTraceWidth({current:1,thickness:0,layer:'external'}));
  assert.throws(()=>calcTraceWidth({current:-1,layer:'internal'}));
  assert.throws(()=>calcImpedance({type:'stripline',width:1,height:1,thickness:1.4}),/铜厚/);
  const w=calcTraceWidth({current:1,layer:'external'});assert.ok(Math.abs(calcCurrentCapacity({width:w.minWidth,layer:'external'})-1)<0.001);
});

test('schematic state uses each component pin API and netlist export defaults to Protel2',async()=>{
  const pin=row({PrimitiveId:'p',Number:'7',X:1,Y:2});const c=row({PrimitiveId:'c',Designator:'R1',Component:{name:'RES'}});c.getAllPins=async()=>[pin];
  const eda={sch_PrimitiveComponent:{getAll:async()=>[c]},sch_PrimitiveWire:{getAll:async()=>[]},sch_Netlist:{getNetlist:async type=>{assert.equal(type,'Protel2');return 'netlist';}}};
  assert.equal((await execute(eda,'get_schematic_state')).pins.length,1);assert.equal((await execute(eda,'get_netlist')).type,'Protel2');
});

test('Protel2 import rejects simplified format and detects a setter that silently does nothing',async()=>{
  const original='PROTEL NETLIST 2.0\n[\nDESIGNATOR\nR1\nDESCRIPTION\n\nPARTTYPE\nRES\nValue\n\n\n*\n]\n(\nGND\nR1-2 res-2 Input\n)';
  const eda={dmt_Schematic:{getCurrentSchematicPageInfo:async()=>({uuid:'sch'})},sch_Netlist:{getNetlist:async()=>original,setNetlist:async()=>{}}};
  const bridge={executeRaw:code=>new AsyncFunction('eda',code)(eda)};
  assert.throws(()=>protel2Signature('[GND\nR1-2\n]'),/文件头/);
  await assert.rejects(pro.schGenerateFromNetlist(bridge,{netlist:original.replace('GND','VCC')}),/读取结果与输入不符/);
  const result=await pro.schGenerateFromNetlist(bridge,{netlist:original});assert.equal(result.verified,true);assert.equal(result.changed,false);
});
