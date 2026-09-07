/**
 * codegen.ts
 *
 * 动作 → 官方 Bridge 执行代码。每个动作生成一段在嘉立创EDA专业版内执行的
 * (async () => {...})() 代码字符串（由官方 Run API Gateway 扩展以
 * new AsyncFunction('eda', code) 执行，eda 为扩展 API 全局对象）。
 *
 * - 经典动作由 legacy-jlc-bridge 和 handlers.ts 兼容修复生成
 * - ping 为内联实现
 * - 高级工具可直接通过 executeRaw 传入自定义代码
 */
import { GENERATED_ACTIONS, SUPPORTED_ACTIONS } from './codegen/generated.js';

export { SUPPORTED_ACTIONS };

export function actionToCode(action: string, params: Record<string, unknown> = {}): string {
  switch (action) {
    case 'ping':
      return `return (async () => { return { message: 'pong', timestamp: Date.now() }; })();`;

    default:
      break;
  }

  const tpl = GENERATED_ACTIONS[action];
  if (!tpl) {
    throw new Error(`unknown action: ${action} (supported: ${SUPPORTED_ACTIONS.join(', ')})`);
  }
  const paramsJson = JSON.stringify(params ?? {});
  return `return (async () => {
${tpl.pre}

const params = ${paramsJson};
return await (${tpl.rootJs})(params);
})()`;
}
