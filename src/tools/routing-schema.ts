import { z } from 'zod';

export const routeShapeSchema = {
  angleMode: z.enum(['octilinear','orthogonal','free']).optional()
    .describe('默认 octilinear：水平/垂直/45°；orthogonal：仅水平/垂直；free：显式允许任意角度'),
  cornerStyle: z.enum(['chamfer','preserve']).optional()
    .describe('octilinear 默认 chamfer，以 45° 过渡整理直角；其他角度模式默认 preserve'),
  chamferDistance: z.number().positive().optional().describe('倒角沿原线段回退距离 mil（默认 10，受空间限制时缩小）'),
  minSegmentLength: z.number().nonnegative().optional().describe('短线段提示阈值 mil（默认 1；锚点附近无法消除时保留并提示）'),
  maxDeviation: z.number().nonnegative().optional().describe('局部整理允许的偏移 mil（默认 10），不会移动连接端点'),
  angleToleranceDeg: z.number().min(0).max(1).optional().describe('读回角度检查容差，单位度（默认 0.01）'),
};
