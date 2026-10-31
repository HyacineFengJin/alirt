import { describe, expect, it, vi } from "vitest";
import { PluginRegistry } from "./registry";
const Empty = () => null;
describe("trusted panel plugin lifecycle", () => {
  it("unregisters exactly one plugin, notifies subscribers, and releases its resources once", () => {
    const registry = new PluginRegistry();
    const dispose = vi.fn();
    const listener = vi.fn();
    const unsubscribe = registry.subscribe(listener);
    const remove = registry.register({
      id: "card.scene",
      kind: "scene",
      render: Empty,
      dispose,
    });
    registry.register({ id: "host.roles", kind: "roles", render: Empty });
    expect(registry.find("scene")?.id).toBe("card.scene");
    expect(listener).toHaveBeenCalledTimes(2);
    remove();
    remove();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(registry.find("scene")).toBeUndefined();
    expect(registry.find("roles")?.id).toBe("host.roles");
    unsubscribe();
    registry.register({
      id: "replacement.scene",
      kind: "scene",
      render: Empty,
    });
    expect(listener).toHaveBeenCalledTimes(3);
  });
  it("rejects duplicate stable IDs and lets registration recover after cleanup throws", () => {
    const registry = new PluginRegistry();
    const remove = registry.register({
      id: "test",
      kind: "scene",
      render: Empty,
      dispose: () => {
        throw new Error("cleanup failed");
      },
    });
    expect(() =>
      registry.register({ id: "test", kind: "roles", render: Empty }),
    ).toThrow();
    expect(() => remove()).toThrow("cleanup failed");
    expect(registry.find("scene")).toBeUndefined();
    expect(registry.getSnapshot()).toBe(2);
    expect(() =>
      registry.register({ id: "test", kind: "roles", render: Empty }),
    ).not.toThrow();
  });
});

it("selects a trusted renderer by explicit ID without silently substituting another plugin", () => {
  const registry = new PluginRegistry();
  registry.register({ id: "host.state", kind: "state", render: Empty });
  registry.register({ id: "custom.status", kind: "state", render: Empty });
  registry.register({ id: "host.roles", kind: "roles", render: Empty });
  expect(registry.find("state")?.id).toBe("host.state");
  expect(registry.find("state", "custom.status")?.id).toBe("custom.status");
  expect(registry.find("state", "host.roles")).toBeUndefined();
  expect(registry.find("state", "uninstalled.renderer")).toBeUndefined();
});
