import type { ToolSpec } from '../engine/types.ts';
import type { RunKind, ToolDef } from './types.ts';

export class ToolRegistry {
  #tools = new Map<string, ToolDef>();

  register(tool: ToolDef): this {
    if (this.#tools.has(tool.name)) throw new Error(`ツール ${tool.name} が重複しています`);
    this.#tools.set(tool.name, tool);
    return this;
  }

  get(name: string): ToolDef | undefined { return this.#tools.get(name); }
  names(): string[] { return [...this.#tools.keys()]; }
  // 登録されている道具すべて（どの種類の実行で使えるかによらず）
  list(): ToolDef[] { return [...this.#tools.values()]; }

  forRun(kind: RunKind, options: { limit?: number | undefined; exclude?: (tool: ToolDef) => boolean } = {}): ToolDef[] {
    const tools = [...this.#tools.values()].filter(t => t.allowedIn.includes(kind) && !options.exclude?.(t));
    return options.limit === undefined ? tools : tools.slice(0, options.limit);
  }

  static specs(tools: readonly ToolDef[]): ToolSpec[] {
    return tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.input as unknown as Record<string, unknown> }));
  }
}
