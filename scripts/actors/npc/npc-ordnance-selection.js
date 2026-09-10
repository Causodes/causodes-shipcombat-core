/** Resolve the ordnance template explicitly selected in an NPC launch row. */
export function selectNpcOrdnanceTemplate(templates = [], templateId = null) {
  if (!Array.isArray(templates) || templates.length === 0) return null;
  if (!templateId) return templates[0];
  return templates.find(template => template?.id === templateId) ?? null;
}

/** Build the shared AppV1/AppV2 launch-selector context. */
export function buildNpcOrdnanceTemplateContext(ordnanceActors = {}, selectedIds = {}) {
  const source = ordnanceActors ?? {};
  const selection = selectedIds ?? {};
  const torpedoes = source.torpedo ?? [];
  const craft = source.strikeCraft ?? [];
  const selectedTorpedo = selectNpcOrdnanceTemplate(torpedoes, selection.torpedo) ?? torpedoes[0];
  const selectedCraft = selectNpcOrdnanceTemplate(craft, selection.strikeCraft) ?? craft[0];

  return {
    torpedoTemplates: torpedoes.map(template => ({
      ...template,
      torpedoCount: template.actorData?.system?.hull?.max ?? 1,
      selected: template.id === selectedTorpedo?.id,
    })),
    craftTemplates: craft.map(template => ({
      ...template,
      squadronSize: template.actorData?.system?.hull?.max ?? 1,
      selected: template.id === selectedCraft?.id,
    })),
    selectedTorpedoTemplate: selectedTorpedo ? {
      id: selectedTorpedo.id,
      torpedoCount: selectedTorpedo.actorData?.system?.hull?.max ?? 1,
    } : null,
    selectedCraftTemplate: selectedCraft ? {
      id: selectedCraft.id,
      squadronSize: selectedCraft.actorData?.system?.hull?.max ?? 1,
    } : null,
  };
}
