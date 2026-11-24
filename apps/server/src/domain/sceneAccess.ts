export type CampaignSceneRole = 'OWNER' | 'GM' | 'PLAYER';

export function canListScene(role: CampaignSceneRole, isActive: boolean, archived: boolean, includeArchived: boolean) {
  if (includeArchived) return role !== 'PLAYER' && archived;
  return !archived && (role !== 'PLAYER' || isActive);
}

export function canReadSceneTokens(role: CampaignSceneRole, isActive: boolean, archived: boolean) {
  return !archived && (role !== 'PLAYER' || isActive);
}
