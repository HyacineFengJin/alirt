import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerBuiltins } from "./plugins/builtin";
import "./styles.css";
const unregister = registerBuiltins();
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    root.unmount();
    unregister();
  });
