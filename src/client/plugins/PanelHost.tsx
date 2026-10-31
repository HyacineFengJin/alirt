import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import type { PanelDefinition } from "../../shared/types";
import type { PanelContext, PanelPlugin } from "./registry";
class PanelBoundary extends Component<
  { children: ReactNode },
  { error: boolean }
> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Failure is local; no story or key is logged. */
  }
  render() {
    return this.state.error ? (
      <p role="alert" className="error">
        此面板暂时不可用。可以关闭或重新加载，其他面板与正文仍可使用。
      </p>
    ) : (
      this.props.children
    );
  }
}
export function PanelHost({
  panel,
  plugin,
  context,
  move,
  close,
}: {
  panel: PanelDefinition;
  plugin?: PanelPlugin;
  context: PanelContext;
  move: () => void;
  close: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const Content = plugin?.render;
  return (
    <section className="panel" aria-label={panel.title}>
      <header className="panel-head">
        <h2>{panel.title}</h2>
        <button
          className="icon-button"
          onClick={move}
          title={`将${panel.title}移至另一侧`}
          aria-label={`将${panel.title}移至另一侧`}
        >
          <ArrowLeftRight size={13} />
        </button>
        <button
          className="icon-button"
          onClick={close}
          title={`关闭${panel.title}`}
          aria-label={`关闭${panel.title}`}
        >
          <X size={14} />
        </button>
      </header>
      <div className="panel-body">
        <PanelBoundary key={`${plugin?.id}:${attempt}`}>
          {Content ? (
            <Content {...context} />
          ) : (
            <p className="muted">面板插件未启用。</p>
          )}
        </PanelBoundary>
      </div>
      <details className="panel-recovery">
        <summary>面板选项</summary>
        <button onClick={() => setAttempt((n) => n + 1)}>重新加载此面板</button>
      </details>
    </section>
  );
}
