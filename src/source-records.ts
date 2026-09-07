/** EDA native records are header JSON || payload JSON |, not JSON Lines.
 * Scan delimiters outside strings so a text value containing || stays intact.
 * JSON Lines remains supported for older exports. */
export function parseSourceRecords(raw: string) {
  const records: Array<{ header: Record<string, any>; data: any }> = [];
  const errors: Array<{ line: number; message: string }> = [];
  const chunks: Array<{ text: string; line: number }> = [];
  let start = 0, startLine = 1, line = 1, quoted = false, escaped = false, depth = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (quoted) { if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') quoted = false; }
    else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    else if (ch === '\n' && depth === 0) {
      if (raw.slice(start,i).trim()) chunks.push({text:raw.slice(start,i).trim(),line:startLine});
      start = i+1; startLine = line+1;
    }
    if (ch === '\n') line++;
  }
  if (raw.slice(start).trim()) chunks.push({text:raw.slice(start).trim(),line:startLine});
  for (const chunk of chunks) {
    try {
      let quoted = false, escaped = false, split = -1;
      for (let i=0;i<chunk.text.length-1;i++) {
        const ch=chunk.text[i];
        if (quoted) { if (escaped) escaped=false; else if(ch==='\\') escaped=true; else if(ch==='"') quoted=false; }
        else if(ch==='"') quoted=true;
        else if(ch==='|' && chunk.text[i+1]==='|') {split=i;break;}
      }
      if (split < 0) {
        const header=JSON.parse(chunk.text);
        if (!header || typeof header !== 'object' || typeof header.type !== 'string') throw new Error('缺少记录 type');
        records.push({header,data:header});
      } else {
        const header=JSON.parse(chunk.text.slice(0,split));
        const payload=chunk.text.slice(split+2).trim().replace(/\|\s*$/, '');
        if (!header || typeof header.type !== 'string') throw new Error('缺少记录 type');
        records.push({header,data:payload ? JSON.parse(payload) : null});
      }
    } catch (e: any) {errors.push({line:chunk.line,message:e.message});}
  }
  return {records,errors,recordCount:chunks.length};
}
