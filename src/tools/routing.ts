import { z } from 'zod';
import { BridgeClient } from '../bridge-client.js';
import { routeShapeSchema } from './routing-schema.js';
import type { RouteEndpointOptions } from '../routing-endpoints.js';
import type { Point, RouteOptions } from '../routing-geometry.js';

type RouteTrackParams = RouteOptions & RouteEndpointOptions & { net: string; points: Point[]; layer: number; width: number; clearance?: number; dryRun?: boolean };

export const endpointBindingSchema = z.discriminatedUnion('kind', [
  z.object({kind:z.literal('free')}).strict(),
  z.object({kind:z.literal('pad'),primitiveId:z.string().min(1)}).strict(),
  z.object({kind:z.literal('via'),primitiveId:z.string().min(1)}).strict(),
  z.object({kind:z.literal('track'),primitiveId:z.string().min(1)}).strict(),
]);

export function registerRoutingTools(server: any, bridge: BridgeClient) {
  server.tool('pcb_route_track', '整理并绘制走线：默认水平/垂直/45°、直角倒角，自动接入焊盘/过孔中心或导线中心线，写入前检查障碍；dryRun 可只预览', {
    net: z.string().describe('网络名称'),
    points: z.array(z.object({ x: z.number(), y: z.number() })).min(2).max(4096).describe('走线路径点 (mil)，默认将接触同网铜的首尾绑定到中心；free/preserve 可保留原坐标'),
    layer: z.number().describe('层号 (1=顶层, 2=底层)'),
    width: z.number().describe('线宽 (mil)'),
    ...routeShapeSchema,
    endpointMode: z.enum(['auto','preserve']).optional().describe('默认 auto：接触同网焊盘/过孔时接中心，接触导线时接中心线；preserve 保留未显式绑定的端点'),
    start: endpointBindingSchema.optional().describe('起点目标：pad/via/track + primitiveId；free 显式保留坐标'),
    end: endpointBindingSchema.optional().describe('终点目标：pad/via/track + primitiveId；free 显式保留坐标'),
    maxEndpointExtension: z.number().nonnegative().optional().describe('端点到绑定锚点的最大距离 mil，默认 100；与中段 maxDeviation 分开约束'),
    clearance: z.number().nonnegative().optional().describe('统一障碍及板框外框间距 mil（默认 6），原生 DRC 仍需检查工程规则'),
    protectedIndices: z.array(z.number().int().nonnegative()).optional().describe('必须保留的中间连接点下标；已有同网铜上的点也会自动保护'),
    dryRun: z.boolean().optional().describe('true 只读取并返回整理路径和问题，不创建走线或重建铺铜'),
  }, async (params: RouteTrackParams) => {
    const data = await bridge.command('route_track', { ...params });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_check_route_geometry', '只读检查已有走线的角度、短线段和转角，区分连接锚点及分支；不修改 PCB', {
    nets: z.array(z.string()).optional().describe('仅检查这些网络；默认全部'),
    layer: z.number().optional().describe('仅检查指定铜层'),
    angleMode: routeShapeSchema.angleMode,
    cornerStyle: routeShapeSchema.cornerStyle,
    minSegmentLength: routeShapeSchema.minSegmentLength,
    angleToleranceDeg: routeShapeSchema.angleToleranceDeg,
  }, async (params: RouteOptions & {nets?: string[]; layer?: number}) => {
    const data = await bridge.command('check_route_geometry', { ...params });
    return {content:[{type:'text' as const,text:JSON.stringify(data,null,2)}]};
  });

  server.tool('pcb_check_route_endpoints', '只读检查焊盘/过孔偏心连接和线到线边缘搭接，不自动修改 PCB；铺铜连通性仍须 DRC', {
    nets:z.array(z.string()).optional().describe('仅检查这些网络；默认全部'),
    layer:z.number().int().positive().optional().describe('仅检查指定铜层'),
    toleranceMil:z.number().min(0).max(1).optional().describe('中心线距离容差 mil，默认 0.1；偏心为人工复核提示'),
  }, async (params:{nets?:string[];layer?:number;toleranceMil?:number})=>{
    const data=await bridge.command('check_route_endpoints',{...params});
    return {content:[{type:'text' as const,text:JSON.stringify(data,null,2)}]};
  });

  server.tool('pcb_create_via', '创建过孔', {
    net: z.string().describe('网络名称'),
    x: z.number().describe('X 坐标 (mil)'),
    y: z.number().describe('Y 坐标 (mil)'),
    drill: z.number().describe('钻孔直径 (mil)'),
    diameter: z.number().describe('过孔外径 (mil)'),
  }, async ({ net, x, y, drill, diameter }: { net: string; x: number; y: number; drill: number; diameter: number }) => {
    const data = await bridge.command('create_via', { net, x, y, holeDiameter: drill, diameter });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_delete_tracks', '删除走线', {
    primitiveIds: z.array(z.string()).describe('走线图元 ID 列表'),
  }, async ({ primitiveIds }: { primitiveIds: string[] }) => {
    const data = await bridge.command('delete_tracks', { primitiveIds });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });

  server.tool('pcb_delete_via', '删除过孔', {
    primitiveIds: z.array(z.string()).describe('过孔图元 ID 列表'),
  }, async ({ primitiveIds }: { primitiveIds: string[] }) => {
    const data = await bridge.command('delete_via', { primitiveIds });
    return { content: [{ type: 'text' as const, text: JSON.stringify(data ?? { success: true }, null, 2) }] };
  });
}
