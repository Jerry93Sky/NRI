export const baseLayerKinds = ['BACKGROUND', 'OBJECTS', 'TOKENS', 'GM'] as const;
export const defaultLayerRows = [
  { name: 'Background', kind: 'BACKGROUND', sortOrder: 0, visibleToPlayers: true, locked: true },
  { name: 'Objects', kind: 'OBJECTS', sortOrder: 1, visibleToPlayers: true, locked: false },
  { name: 'Tokens', kind: 'TOKENS', sortOrder: 2, visibleToPlayers: true, locked: false },
  { name: 'GM', kind: 'GM', sortOrder: 3, visibleToPlayers: false, locked: false },
] as const;
