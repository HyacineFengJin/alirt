import type { ComponentType } from "react";
import type { EditKnowledgeRequest } from "../api";
import type {
  Catalog,
  EditState,
  PanelDefinition,
  RoleDefinition,
  SessionSnapshot,
  SetLifecycle,
} from "../../shared/types";
export interface PanelContext {
  session: SessionSnapshot;
  catalog: Catalog;
  selectedRole: RoleDefinition | undefined;
  selectRole: (id: string) => void;
  editState: (body: EditState) => Promise<void>;
  editKnowledge: (body: EditKnowledgeRequest) => Promise<void>;
  setLifecycle: (body: SetLifecycle) => Promise<void>;
  refresh: () => Promise<void>;
  readOnly: boolean;
  chooseAction?: (text: string) => void;
}
export interface PanelPlugin {
  id: string;
  kind: PanelDefinition["kind"];
  render: ComponentType<PanelContext>;
  dispose?: () => void;
}
/** Internal, trusted React components only. Imported scripts never enter this registry. */
export class PluginRegistry {
  private plugins = new Map<string, PanelPlugin>();
  private listeners = new Set<() => void>();
  private version = 0;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.version;
  register(plugin: PanelPlugin): () => void {
    if (this.plugins.has(plugin.id))
      throw new Error(`插件 ID 已注册：${plugin.id}`);
    this.plugins.set(plugin.id, plugin);
    this.notify();
    return () => {
      if (this.plugins.get(plugin.id) !== plugin) return;
      this.plugins.delete(plugin.id);
      try {
        plugin.dispose?.();
      } finally {
        this.notify();
      }
    };
  }
  find(kind: PanelDefinition["kind"], id?: string) {
    if (id !== undefined) {
      const plugin = this.plugins.get(id);
      return plugin?.kind === kind ? plugin : undefined;
    }
    return [...this.plugins.values()].find((plugin) => plugin.kind === kind);
  }
  list() {
    return [...this.plugins.values()];
  }
  private notify() {
    this.version++;
    for (const listener of this.listeners) listener();
  }
}
