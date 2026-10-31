import type { NativeDocument } from "../../shared/creator";
import type {
  CharacterCard,
  PromptModule,
  RoleDefinition,
} from "../../shared/types";
export function updateDocumentField(
  document: NativeDocument,
  key: "title" | "description" | "opening",
  value: string,
): NativeDocument {
  const next = structuredClone(document);
  if (key === "opening") {
    if (next.schema === "rp.card/0.1") next.opening = value;
  } else next[key] = value;
  return next;
}
export function updateWorldField(
  document: NativeDocument,
  key: "location" | "time",
  value: string,
): NativeDocument {
  const next = structuredClone(document);
  if (next.schema === "rp.card/0.1") next.world[key] = value;
  return next;
}
export function updateRole(
  document: NativeDocument,
  id: string,
  patch: Partial<
    Pick<RoleDefinition, "name" | "persona" | "phase" | "presence">
  >,
): NativeDocument {
  const next = structuredClone(document);
  if (next.schema !== "rp.card/0.1") return next;
  const role = next.roles.find((item) => item.id === id);
  if (!role) return next;
  Object.assign(role, patch);
  if (patch.persona !== undefined && role.personaSourcePointer) {
    for (const peer of next.roles)
      if (peer.personaSourcePointer === role.personaSourcePointer)
        peer.persona = patch.persona;
    for (const module of next.modules)
      if (module.sourcePointer === role.personaSourcePointer)
        module.content = patch.persona;
  }
  return next;
}
export function linkedRoleNames(
  document: NativeDocument,
  module: PromptModule,
): string[] {
  return document.schema === "rp.card/0.1" && module.sourcePointer
    ? document.roles
        .filter((role) => role.personaSourcePointer === module.sourcePointer)
        .map((role) => role.name)
    : [];
}
export function updateModule(
  document: NativeDocument,
  id: string,
  patch: Partial<PromptModule>,
): NativeDocument {
  const next = structuredClone(document),
    module = next.modules.find((item) => item.id === id);
  if (!module) return next;
  const activation = module.activation;
  Object.assign(module, patch);
  if (Object.hasOwn(patch, "activation")) {
    if (patch.activation)
      module.activation = { ...activation, ...patch.activation };
    else delete module.activation;
  }
  if (
    patch.content !== undefined &&
    module.sourcePointer &&
    next.schema === "rp.card/0.1"
  ) {
    const roles = next.roles.filter(
      (role) => role.personaSourcePointer === module.sourcePointer,
    );
    if (roles.length) {
      for (const role of roles) role.persona = patch.content;
      for (const peer of next.modules)
        if (peer.sourcePointer === module.sourcePointer)
          peer.content = patch.content;
    }
  }
  return next;
}
export function moveModule(
  document: NativeDocument,
  id: string,
  direction: -1 | 1,
): NativeDocument {
  const next = structuredClone(document),
    from = next.modules.findIndex((item) => item.id === id),
    to = from + direction;
  if (from < 0 || to < 0 || to >= next.modules.length) return next;
  [next.modules[from], next.modules[to]] = [
    next.modules[to],
    next.modules[from],
  ];
  return next;
}
export function removeModule(
  document: NativeDocument,
  id: string,
): NativeDocument {
  const next = structuredClone(document);
  next.modules = next.modules.filter((module) => module.id !== id);
  return next;
}
export function addModule(
  document: NativeDocument,
  id: string,
): NativeDocument {
  const next = structuredClone(document);
  next.modules.push({
    id,
    title: "",
    category: "supplement",
    content: "",
    enabled: true,
    targets: ["prose"],
    phase: "compose",
    priority:
      next.modules.reduce((max, module) => Math.max(max, module.priority), 0) +
      10,
  });
  return next;
}
export function orderModulePriorities(
  document: NativeDocument,
): NativeDocument {
  const next = structuredClone(document);
  next.modules.forEach((module, index) => {
    module.priority = (index + 1) * 10;
  });
  return next;
}
export function roleModules(document: CharacterCard, role: RoleDefinition) {
  return role.personaSourcePointer
    ? document.modules.filter(
        (module) => module.sourcePointer === role.personaSourcePointer,
      )
    : [];
}
