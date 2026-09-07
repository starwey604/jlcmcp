// 阻抗 & IPC-2221 线宽计算器 — 纯数学函数，不依赖 bridge

export type ImpedanceType = 'microstrip' | 'stripline' | 'diff_microstrip' | 'diff_stripline';

export interface ImpedanceParams {
  type: ImpedanceType;
  width: number;      // mil
  thickness?: number;  // mil, default 1.4 (1oz)
  height: number;      // mil, 介质厚度
  er?: number;         // 介电常数, default 4.3 (FR4)
  spacing?: number;    // mil, 差分间距（差分模式必填）
}

export interface ImpedanceResult {
  impedance: number;
  type: ImpedanceType;
  params: ImpedanceParams;
}

export interface WidthForImpedanceParams {
  type: ImpedanceType;
  targetImpedance: number; // Ω
  thickness?: number;
  height: number;
  er?: number;
  spacing?: number;        // 差分模式：固定间距求线宽
}

export interface WidthForImpedanceResult {
  width: number;
  impedance: number;
  error: number;           // 实际阻抗与目标的偏差 Ω
}

export interface TraceWidthParams {
  current: number;     // A
  thickness?: number;  // mil, default 1.4
  tempRise?: number;   // °C, default 10
  layer: 'external' | 'internal';
}

export interface TraceWidthResult {
  minWidth: number;    // mil
  crossSection: number; // mil²
  current: number;
  tempRise: number;
  layer: string;
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(name + ' 必须为有限正数');
  return value;
}

/** Logarithmic approximations, TI SLLU319 §3.3, equations 1–4.
 * https://www.ti.com/lit/ug/sllu319/sllu319.pdf
 * Stripline geometry uses plane separation B, as defined by ADI, Fig. 7-118:
 * https://www.analog.com/media/en/training-seminars/design-handbooks/P2%20Ch7_final.pdf
 * height is trace-to-plane distance for microstrip, full plane separation for stripline.
 * These estimates are not a field solver; reject geometries outside the positive-log domain.
 */
function impedanceModel(params: Omit<ImpedanceParams, 'width'>) {
  const thickness = positive(params.thickness ?? 1.4, 'thickness');
  const height = positive(params.height, 'height');
  const er = positive(params.er ?? 4.3, 'er');
  if (er < 1) throw new Error('er 必须 >= 1');
  if (!['microstrip', 'stripline', 'diff_microstrip', 'diff_stripline'].includes(params.type))
    throw new Error('未知阻抗类型: ' + params.type);
  const strip = params.type.endsWith('stripline');
  if (strip && thickness >= height) throw new Error('带状线铜厚必须小于两参考平面的间距 height');
  const diff = params.type.startsWith('diff_');
  const spacing = diff ? positive(params.spacing ?? NaN, '差分 spacing') : params.spacing;
  const coupling = diff ? 2 * (1 - (strip ? 0.37 : 0.48) * Math.exp(-(strip ? 2.9 : 0.96) * spacing! / height)) : 1;
  const factor = 60 / Math.sqrt(strip ? er : 0.475 * er + 0.67) * coupling;
  const numerator = 4 * height / (0.67 * (strip ? Math.PI : 1));
  return { thickness, height, er, spacing, factor, numerator };
}

export function calcImpedance(params: ImpedanceParams): ImpedanceResult {
  const width = positive(params.width, 'width');
  const m = impedanceModel(params);
  const impedance = m.factor * Math.log(m.numerator / (0.8 * width + m.thickness));
  if (!Number.isFinite(impedance) || impedance <= 0)
    throw new Error('此几何参数超出对数近似公式适用范围，请调整叠层/线宽或使用场求解器');
  return { impedance: Math.round(impedance * 100) / 100, type: params.type,
    params: { ...params, thickness: m.thickness, er: m.er } };
}

/** Analytic inverse of the same model. Recalculate after rounding the returned width. */
export function calcWidthForImpedance(params: WidthForImpedanceParams): WidthForImpedanceResult {
  const target = positive(params.targetImpedance, 'targetImpedance');
  const m = impedanceModel(params);
  const rawWidth = (m.numerator / Math.exp(target / m.factor) - m.thickness) / 0.8;
  if (!Number.isFinite(rawWidth) || rawWidth < 0.01 || rawWidth > 200)
    throw new Error('目标阻抗在当前叠层及支持的线宽范围 0.01–200 mil 内不可达');
  const width = Math.round(rawWidth * 100) / 100;
  const impedance = calcImpedance({ ...params, width }).impedance;
  return { width, impedance, error: Math.round((impedance - target) * 100) / 100 };
}

function copperParams(params: { thickness?: number; tempRise?: number; layer: string }) {
  const thickness = positive(params.thickness ?? 1.4, 'thickness');
  const tempRise = positive(params.tempRise ?? 10, 'tempRise');
  if (!['external', 'internal'].includes(params.layer)) throw new Error('无效的铜层类型');
  return { thickness, tempRise, k: params.layer === 'external' ? 0.048 : 0.024 };
}

/** IPC-2221: I = k ΔT^0.44 A^0.725, with copper area in mil². */
export function calcCurrentCapacity(params: { width: number; thickness?: number; tempRise?: number; layer: 'external' | 'internal' }): number {
  const m = copperParams(params);
  const area = positive(params.width, 'width') * m.thickness;
  return m.k * Math.pow(m.tempRise, 0.44) * Math.pow(area, 0.725);
}

export function calcTraceWidth(params: TraceWidthParams): TraceWidthResult {
  const current = positive(params.current, 'current');
  const m = copperParams(params);
  const area = Math.pow(current / (m.k * Math.pow(m.tempRise, 0.44)), 1 / 0.725);
  return { minWidth: Math.round(area / m.thickness * 100) / 100,
    crossSection: Math.round(area * 100) / 100, current, tempRise: m.tempRise, layer: params.layer };
}
