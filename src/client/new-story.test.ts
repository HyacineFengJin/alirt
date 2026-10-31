import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CharacterCard, OpeningDefinition, PlayerProfileDefinition } from "../shared/types";
import { NewStoryInitialization } from "./NewStoryInitialization";
import { newStoryRequest, resolveNewStorySelection, selectNewStoryOpening, storySummary, toggleNewStoryRoleGroup, type NewStorySelection } from "./new-story";

const opening = (id: string): OpeningDefinition => ({
  id, title: `开场${id}`, text: "夜雨中的车站，灯光刚刚亮起。",
  instruction: "PRIVATE_INSTRUCTION", world: { location: "车站", time: "入夜" },
  cast: [
    { roleId: "player", phase: "active", presence: "present" },
    { roleId: "friend", phase: "active", presence: "present" },
    { roleId: "stranger", phase: "dormant", presence: "absent" },
  ],
  state: [{ roleId: "player", key: "PRIVATE_FIELD", value: "PRIVATE_VALUE" }],
});
const profile = (id: string): PlayerProfileDefinition => ({
  id, title: `人设${id}`, name: "旅人", persona: "带着旧旅行箱回来寻找故友。",
  state: [{ roleId: "player", key: "PRIVATE_PROFILE_FIELD", value: 987654321 }],
});
function card(id = "card-a"): CharacterCard {
  return {
    schema: "rp.card/0.1", id, title: "雨夜", description: "车站重逢", opening: "旧开场", playerRoleId: "player",
    world: { location: "旧世界", time: "早晨", variables: {} }, fields: [], modules: [], panels: [],
    roles: [
      { id: "player", name: "原玩家", persona: "", goals: [], peers: [], phase: "active", presence: "present", state: {}, knowledge: [] },
      { id: "friend", name: "故友", persona: "", goals: [], peers: [], phase: "active", presence: "present", state: {}, knowledge: [] },
      { id: "stranger", name: "未登场者", persona: "", goals: [], peers: [], phase: "dormant", presence: "absent", state: {}, knowledge: [] },
    ],
    initialization: { schema: "rp.initialization/0.1", openings: [opening("one"), opening("two")], playerProfiles: [profile("one"), profile("two")] },
  };
}

describe("new story initialization choice", () => {
  function withSubset() {
    const target = card();
    const custom = opening('custom');
    custom.cast[1] = { roleId: 'friend', phase: 'dormant', presence: 'absent', interaction: { mode: 'remote', channel: 'audio' } };
    custom.roleSelection = { kind: 'role-subset', roleIds: ['friend', 'stranger'], min: 1, max: 2,
      nameToken: 'PRIVATE_TOKEN', nameSeparator: '、', selected: { phase: 'active', presence: 'absent', interaction: { mode: 'remote', channel: 'message' } },
      unselected: { phase: 'dormant', presence: 'absent' } };
    target.initialization!.openings.push(custom);
    return target;
  }
  function withGroups() {
    const target = card();
    const custom = opening('grouped');
    custom.cast[1] = { roleId: 'friend', phase: 'active', presence: 'absent', interaction: { mode: 'remote', channel: 'audio' } };
    custom.roleGroups = [
      { kind: 'role-subset', id: 'relationships', title: '关系分组', roleIds: ['friend', 'stranger'], min: 1, max: 2,
        nameToken: 'PRIVATE_RELATION_TOKEN', complementNameToken: 'PRIVATE_COMPLEMENT_TOKEN', nameSeparator: '、',
        selectedState: [{ key: 'PRIVATE_AFFINITY', value: 1000 }], unselectedState: [{ key: 'PRIVATE_AFFINITY', value: 500 }] },
      { kind: 'role-subset', id: 'attendees', title: '在场分组', roleIds: ['friend', 'stranger'], min: 1, max: 2,
        subsetOf: 'relationships', selectWithParent: true, nameToken: 'PRIVATE_ATTENDEE_TOKEN', nameSeparator: '、',
        selected: { phase: 'active', presence: 'present' }, unselected: { phase: 'dormant', presence: 'absent' } },
    ];
    target.initialization!.openings.push(custom, { ...structuredClone(custom), id: 'grouped-other-scene', title: '另一场景' });
    return target;
  }

  it('validates every named group, parent constraints and canonical role order without filtering invalid choices', () => {
    const target = withGroups(), selected = { cardId: target.id, openingId: 'grouped', playerProfileId: 'one' };
    const invalid: unknown[] = [undefined, {}, { relationships: ['friend'] }, { relationships: [], attendees: [] },
      { relationships: ['friend'], attendees: ['stranger'] }, { relationships: ['friend', 'friend'], attendees: ['friend'] },
      { relationships: ['player'], attendees: ['player'] }, { relationships: ['foreign'], attendees: ['foreign'] },
      { relationships: ['friend'], attendees: ['friend'], extra: ['friend'] }, { relationships: ['friend'], attendees: null },
      { relationships: ['friend'], attendees: ['friend', 'friend'] }];
    for (const selectedRoleGroups of invalid) expect(newStoryRequest(target, 'preset', { ...selected, selectedRoleGroups } as NewStorySelection)).toBeUndefined();
    const selectedRoleGroups = { relationships: ['stranger', 'friend'], attendees: ['stranger'] };
    expect(newStoryRequest(target, 'preset', { ...selected, selectedRoleGroups })).toEqual({ ...selected, presetId: 'preset', selectedRoleGroups: { relationships: ['friend', 'stranger'], attendees: ['stranger'] } });
    expect(selectedRoleGroups.relationships).toEqual(['stranger', 'friend']);
    expect(newStoryRequest(target, 'preset', { ...selected, selectedRoleGroups, selectedRoleIds: ['friend'] })).toBeUndefined();
    target.roles.find(role => role.id === 'stranger')!.phase = 'retired';
    expect(newStoryRequest(target, 'preset', { ...selected, selectedRoleGroups })).toBeUndefined();
  });

  it('keeps lover-style membership separate from attendance after the explicit parent checkbox default', () => {
    const target = withGroups();
    const initial: NewStorySelection = { cardId: target.id, openingId: 'grouped', playerProfileId: 'two', selectedRoleGroups: { relationships: [], attendees: [] } };
    let selected = toggleNewStoryRoleGroup(target, initial, 'relationships', 'stranger', true);
    selected = toggleNewStoryRoleGroup(target, selected, 'relationships', 'friend', true);
    expect(selected.selectedRoleGroups).toEqual({ relationships: ['friend', 'stranger'], attendees: ['friend', 'stranger'] });
    selected = toggleNewStoryRoleGroup(target, selected, 'attendees', 'stranger', false);
    expect(selected.selectedRoleGroups).toEqual({ relationships: ['friend', 'stranger'], attendees: ['friend'] });
    selected = toggleNewStoryRoleGroup(target, selected, 'relationships', 'friend', false);
    expect(selected.selectedRoleGroups).toEqual({ relationships: ['stranger'], attendees: [] });
    expect(toggleNewStoryRoleGroup(target, selected, 'attendees', 'friend', true)).toBe(selected);
    expect(newStoryRequest(target, 'preset', selected)).toBeUndefined();
    selected = toggleNewStoryRoleGroup(target, selected, 'attendees', 'stranger', true);
    expect(newStoryRequest(target, 'preset', selected)?.selectedRoleGroups).toEqual({ relationships: ['stranger'], attendees: ['stranger'] });
    expect(selected.playerProfileId).toBe('two');
    expect(initial.selectedRoleGroups).toEqual({ relationships: [], attendees: [] });
  });

  it('permits explicitly optional empty groups while required groups remain incomplete', () => {
    const target = withGroups(), groups = target.initialization!.openings.find(item => item.id === 'grouped')!.roleGroups!;
    const selected = { cardId: target.id, openingId: 'grouped', playerProfileId: 'one', selectedRoleGroups: { relationships: [], attendees: [] } };
    expect(newStoryRequest(target, 'preset', selected)).toBeUndefined();
    groups.forEach(group => { group.min = 0; });
    expect(newStoryRequest(target, 'preset', selected)).toEqual({ ...selected, presetId: 'preset' });
    groups[0].min = 1;
    expect(newStoryRequest(target, 'preset', selected)).toBeUndefined();
  });

  it('preserves compatible scene groups and player profile while clearing incompatible or legacy selection shapes', () => {
    const target = withGroups();
    const selected: NewStorySelection = { cardId: target.id, openingId: 'grouped', playerProfileId: 'two', selectedRoleGroups: { relationships: ['friend', 'stranger'], attendees: ['friend'] } };
    const otherScene = selectNewStoryOpening(target, selected, 'grouped-other-scene');
    expect(otherScene.selectedRoleGroups).toEqual(selected.selectedRoleGroups);
    expect(otherScene.selectedRoleGroups).not.toBe(selected.selectedRoleGroups);
    expect(otherScene.playerProfileId).toBe('two');
    target.initialization!.openings.find(item => item.id === 'grouped-other-scene')!.roleGroups![0].max = 1;
    expect(selectNewStoryOpening(target, selected, 'grouped-other-scene').selectedRoleGroups).toEqual({ relationships: [], attendees: [] });
    expect(selectNewStoryOpening(target, selected, 'one')).not.toHaveProperty('selectedRoleGroups');
    target.initialization!.defaultOpeningId = 'grouped';
    expect(resolveNewStorySelection(target, { ...selected, cardId: 'another' }).selectedRoleGroups).toEqual({ relationships: [], attendees: [] });
    expect(selected.selectedRoleGroups).toEqual({ relationships: ['friend', 'stranger'], attendees: ['friend'] });
  });

  it('previews actual attendance without promoting an absent relationship member or exposing template/state material', () => {
    const target = withGroups();
    const html = renderToStaticMarkup(createElement(NewStoryInitialization, { card: target,
      selection: { cardId: target.id, openingId: 'grouped', playerProfileId: 'one', selectedRoleGroups: { relationships: ['friend', 'stranger'], attendees: ['friend'] } }, onChange: () => {} }));
    expect(html).toContain('<legend>关系分组</legend>');
    expect(html).toContain('<legend>在场分组</legend>');
    expect(html).toContain('本次已选 2 位：故友、未登场者');
    expect(html).toContain('本次已选 1 位：故友');
    expect(html).toContain('2 位角色在场：旅人、故友');
    expect(html).not.toContain('3 位角色在场');
    expect(html).not.toContain('位角色远程参与');
    expect(html).not.toContain('PRIVATE_');
    const empty = renderToStaticMarkup(createElement(NewStoryInitialization, { card: target,
      selection: { cardId: target.id, openingId: 'grouped', playerProfileId: 'one', selectedRoleGroups: { relationships: [], attendees: [] } }, onChange: () => {} }));
    expect(empty).toContain('1 位角色在场：旅人');
    expect(empty).toContain('此分组至少选择 1 位');
    expect(empty).toContain('aria-label="在场分组 · 故友" disabled=""');
  });

  it('requires an explicit valid subset without silently filtering stale or repeated role IDs', () => {
    const target = withSubset();
    const selected = { cardId: target.id, openingId: 'custom', playerProfileId: 'one' };
    for (const selectedRoleIds of [[], ['friend', 'friend'], ['player'], ['foreign'], ['friend', 'stranger', 'player']])
      expect(newStoryRequest(target, 'preset', { ...selected, selectedRoleIds })).toBeUndefined();
    const selectedRoleIds = ['stranger', 'friend'];
    expect(newStoryRequest(target, 'preset', { ...selected, selectedRoleIds })).toEqual({ ...selected, presetId: 'preset', selectedRoleIds });
    expect(selectedRoleIds).toEqual(['stranger', 'friend']);
    expect(newStoryRequest(target, 'preset', { ...selected, openingId: 'one', selectedRoleIds })).not.toHaveProperty('selectedRoleIds');
    target.initialization!.defaultOpeningId = 'custom';
    target.initialization!.defaultPlayerProfileId = 'one';
    expect(resolveNewStorySelection(target, { ...selected, cardId: 'another', selectedRoleIds }).selectedRoleIds).toEqual([]);
  });

  it('previews remote selection without converting it into scene presence or exposing template data', () => {
    const target = withSubset();
    const html = renderToStaticMarkup(createElement(NewStoryInitialization, { card: target,
      selection: { cardId: target.id, openingId: 'custom', playerProfileId: 'one', selectedRoleIds: ['stranger'] }, onChange: () => {}, disabled: true }));
    expect(html).toContain('参与角色');
    expect(html).toContain('1 位角色在场：旅人');
    expect(html).toContain('1 位角色远程参与：未登场者');
    expect(html).not.toContain('2 位角色远程参与');
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('PRIVATE_');
  });

  it("requires explicit independent selections for multiple options without defaults", () => {
    const target = card();
    expect(resolveNewStorySelection(target, { cardId: target.id })).toEqual({ cardId: target.id, openingId: "", playerProfileId: "" });
    expect(newStoryRequest(target, "preset", { cardId: target.id, openingId: "two" })).toBeUndefined();
    expect(newStoryRequest(target, "preset", { cardId: target.id, openingId: "two", playerProfileId: "one" })).toEqual({ cardId: target.id, presetId: "preset", openingId: "two", playerProfileId: "one" });
  });

  it("uses valid defaults or unique options, ignoring an invalid default", () => {
    const target = card();
    target.initialization!.defaultOpeningId = "two";
    target.initialization!.defaultPlayerProfileId = "removed";
    target.initialization!.playerProfiles = [profile("only")];
    expect(newStoryRequest(target, "preset", { cardId: target.id })).toEqual({ cardId: target.id, presetId: "preset", openingId: "two", playerProfileId: "only" });
    target.initialization!.playerProfiles.push(profile("extra"));
    expect(newStoryRequest(target, "preset", { cardId: target.id })).toBeUndefined();
  });

  it("rejects stale IDs and never carries another card's choices into a request", () => {
    const target = card("card-b");
    expect(newStoryRequest(target, "preset", { cardId: "card-a", openingId: "one", playerProfileId: "two" })).toBeUndefined();
    expect(newStoryRequest(target, "preset", { cardId: target.id, openingId: "foreign", playerProfileId: "two" })).toBeUndefined();
    target.initialization!.defaultOpeningId = "two";
    target.initialization!.defaultPlayerProfileId = "one";
    expect(newStoryRequest(target, "preset", { cardId: "card-a", openingId: "one", playerProfileId: "two" })).toEqual({ cardId: target.id, presetId: "preset", openingId: "two", playerProfileId: "one" });
    // App resets to this state whenever the card select changes, including switching back.
    expect(resolveNewStorySelection(target, { cardId: target.id }).openingId).toBe("two");
  });

  it("keeps legacy card requests unchanged and refuses missing essentials", () => {
    const target = card();
    delete target.initialization;
    expect(newStoryRequest(target, "preset", { cardId: "old", openingId: "old", playerProfileId: "old" })).toEqual({ cardId: target.id, presetId: "preset" });
    expect(newStoryRequest(target, "", { cardId: target.id })).toBeUndefined();
    expect(newStoryRequest(undefined, "preset", { cardId: target.id })).toBeUndefined();
    expect(renderToStaticMarkup(createElement(NewStoryInitialization, { card: target, selection: { cardId: target.id }, onChange: () => {} }))).toBe("");
  });

  it("renders concise public choices, presence and persona without internal instructions or state", () => {
    const target = card();
    const html = renderToStaticMarkup(createElement(NewStoryInitialization, {
      card: target, selection: { cardId: target.id, openingId: "two", playerProfileId: "one" }, onChange: () => {},
    }));
    expect(html.match(/<select/g)).toHaveLength(2);
    expect(html).toContain("开场概要");
    expect(html).toContain("2 位角色在场：旅人、故友");
    expect(html).toContain("寻找故友");
    expect(html).not.toContain("未登场者");
    expect(html).not.toContain("PRIVATE_");
    expect(html).not.toContain("987654321");
    expect(storySummary(" a\n b ", 3)).toBe("a b");
    expect(storySummary("长".repeat(300))).toHaveLength(181);
  });
});
