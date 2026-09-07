/** Logical content of EDA's Protel2 export; ignore property ordering and whitespace. */
export function protel2Signature(text: string, options: { includeAllProperties?: boolean; allowEmpty?: boolean } = {}): string {
  // Empty property values are meaningful alternating lines in EDA exports.
  const lines = text.trim().replace(/\r/g, '').split('\n').map(s => s.trim());
  if (lines.shift() !== 'PROTEL NETLIST 2.0') throw new Error('Protel2 必须包含 PROTEL NETLIST 2.0 文件头，不能使用简化的 [网络名 引脚] 格式');
  const components: string[] = [], nets: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]) continue;
    const opening = lines[i], closing = opening === '[' ? ']' : opening === '(' ? ')' : null;
    if (!closing) throw new Error('无效的 Protel2 记录: ' + opening);
    const block: string[] = [];
    while (++i < lines.length && lines[i] !== closing) block.push(lines[i]);
    if (i >= lines.length) throw new Error('Protel2 记录未闭合');
    if (opening === '[') {
      const properties = new Map<string, string>();
      for (let j = 0; j < block.length && block[j] !== '*';) {
        if (!block[j]) { j++; continue; }
        if (block[j + 1] === undefined || block[j + 1] === '*') throw new Error('Protel2 元件属性缺少值');
        properties.set(block[j], block[j + 1]);
        j += 2;
      }
      if (!properties.get('DESIGNATOR')) throw new Error('Protel2 元件缺少 DESIGNATOR');
      components.push(JSON.stringify(options.includeAllProperties
        ? [...properties.entries()].sort(([a], [b]) => a.localeCompare(b))
        : ['DESIGNATOR', 'FOOTPRINT', 'PARTTYPE'].map(k => properties.get(k) ?? '')));
    } else {
      if (block.length < 2) throw new Error('Protel2 网络必须包含名称和引脚');
      const pins = block.slice(1).filter(Boolean).map(p => p.split(/\s+/)[0]);
      if (!pins.length) throw new Error('Protel2 网络缺少引脚');
      if (pins.some(p => !/^.+-.+$/.test(p))) throw new Error('Protel2 网络引脚必须为 位号-引脚号');
      nets.push(JSON.stringify([block[0], [...new Set(pins)].sort()]));
    }
  }
  if (!components.length && !options.allowEmpty) throw new Error('Protel2 缺少元件记录');
  return JSON.stringify({ components: components.sort(), nets: nets.sort() });
}
