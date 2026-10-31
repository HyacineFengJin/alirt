import { describe, expect, it } from "vitest";
import type { CharacterCard } from "../../shared/types";
import {
  moveModule,
  orderModulePriorities,
  updateDocumentField,
  updateModule,
  updateRole,
  updateWorldField,
} from "./structured";
function card() {
  return {
    schema: "rp.card/0.1",
    id: "draft",
    title: "原题",
    description: "原文",
    opening: "",
    playerRoleId: "one",
    world: {
      location: "原地点",
      time: "",
      variables: { retained: ["value"] },
      customWorld: true,
    },
    roles: [
      {
        id: "one",
        name: "一",
        persona: "同源原文",
        personaSourcePointer: "/lore/one",
        goals: [],
        peers: [],
        phase: "dormant",
        presence: "absent",
        state: { retained: 5 },
        knowledge: [],
        unknownRole: ["retain"],
      },
    ],
    modules: [
      {
        id: "bio",
        title: "设定",
        content: "同源原文",
        category: "supplement",
        enabled: true,
        targets: ["role"],
        phase: "decide",
        priority: 70,
        sourcePointer: "/lore/one",
        activation: { keys: ["原关键词"], unknownActivation: { keep: true } },
        unknownModule: "retain",
      },
      {
        id: "voice",
        title: "文风",
        content: "另一个完整提示",
        category: "style",
        enabled: true,
        targets: ["prose"],
        phase: "compose",
        priority: 20,
      },
    ],
    fields: [],
    panels: [],
    unknownRoot: { exact: "retain" },
  } as unknown as CharacterCard;
}
describe("structured authoring changes", () => {
  it("changes only selected fields and retains nested unknown metadata", () => {
    const before = card();
    const after = updateWorldField(
      updateDocumentField(before, "title", "新题"),
      "location",
      "新地点",
    );
    expect(after).toHaveProperty("unknownRoot.exact", "retain");
    expect(after).toHaveProperty("world.customWorld", true);
    expect(after).toHaveProperty("world.variables.retained", ["value"]);
    expect(before.title).toBe("原题");
    expect(before.world.location).toBe("原地点");
    expect(after.modules).toEqual(before.modules);
  });
  it("synchronizes role biographies and matching source modules in either edit direction without touching unrelated text", () => {
    const before = card();
    const roleEdit = updateRole(before, "one", {
      persona: "新的完整人物设定",
    }) as CharacterCard;
    expect(roleEdit.roles[0].persona).toBe("新的完整人物设定");
    expect(roleEdit.modules[0].content).toBe("新的完整人物设定");
    expect(roleEdit.modules[1].content).toBe(before.modules[1].content);
    const moduleEdit = updateModule(roleEdit, "bio", {
      content: "从提示模块再次修改",
      activation: { keys: ["新关键词"] },
    }) as CharacterCard;
    expect(moduleEdit.roles[0].persona).toBe("从提示模块再次修改");
    expect(moduleEdit).toHaveProperty("roles.0.unknownRole", ["retain"]);
    expect(moduleEdit).toHaveProperty(
      "modules.0.activation.unknownActivation.keep",
      true,
    );
    expect(before.roles[0].persona).toBe("同源原文");
  });
  it("separates list reordering from an explicit priority rewrite", () => {
    const before = card(),
      moved = moveModule(before, "voice", -1);
    expect(moved.modules.map((module) => module.id)).toEqual(["voice", "bio"]);
    expect(moved.modules.map((module) => module.priority)).toEqual([20, 70]);
    const ordered = orderModulePriorities(moved);
    expect(ordered.modules.map((module) => module.priority)).toEqual([10, 20]);
    expect(ordered).toHaveProperty("modules.1.unknownModule", "retain");
    expect(before.modules[0].id).toBe("bio");
  });
});
