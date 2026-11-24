import { describe, expect, it } from 'vitest';
import { canListScene, canReadSceneLayer, canReadSceneTokens } from './sceneAccess.js';

describe('scene access projections', () => {
  it('keeps unpublished and archived scenes out of player lists', () => {
    expect(canListScene('PLAYER', true, false, false)).toBe(true);
    expect(canListScene('PLAYER', false, false, false)).toBe(false);
    expect(canListScene('PLAYER', true, true, false)).toBe(false);
    expect(canListScene('PLAYER', false, true, true)).toBe(false);
  });

  it('lets campaign managers prepare scenes and recover archives', () => {
    expect(canListScene('GM', false, false, false)).toBe(true);
    expect(canListScene('OWNER', false, true, true)).toBe(true);
    expect(canListScene('GM', true, false, true)).toBe(false);
  });

  it('allows token snapshots only for active scenes to players', () => {
    expect(canReadSceneTokens('PLAYER', true, false)).toBe(true);
    expect(canReadSceneTokens('PLAYER', false, false)).toBe(false);
    expect(canReadSceneTokens('PLAYER', true, true)).toBe(false);
    expect(canReadSceneTokens('GM', false, false)).toBe(true);
  });

  it('never projects GM layers or hidden layers to players', () => {
    expect(canReadSceneLayer('PLAYER', true, false, true, 'OBJECTS')).toBe(true);
    expect(canReadSceneLayer('PLAYER', true, false, false, 'OBJECTS')).toBe(false);
    expect(canReadSceneLayer('PLAYER', true, false, true, 'GM')).toBe(false);
    expect(canReadSceneLayer('PLAYER', false, false, true, 'OBJECTS')).toBe(false);
    expect(canReadSceneLayer('GM', false, false, false, 'GM')).toBe(true);
    expect(canReadSceneLayer('OWNER', true, true, true, 'OBJECTS')).toBe(false);
  });
});
