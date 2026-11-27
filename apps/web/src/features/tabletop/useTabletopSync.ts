import { useCallback, useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Socket } from 'socket.io-client';
import type { PublicSceneLayer, PublicSceneObject, PublicToken } from '@nri/contracts';
import { api } from '../../services/api';
import type { Campaign, ChatItem, InitiativeView, Member, RollItem, Scene, SharedPointer, User } from './models';

type Options = {
  user: User | null;
  campaign: Campaign | null;
  socket: Socket;
  setCampaign: Dispatch<SetStateAction<Campaign | null>>;
  setCampaigns: Dispatch<SetStateAction<Campaign[]>>;
  setError: Dispatch<SetStateAction<string>>;
  setUser: Dispatch<SetStateAction<User | null>>;
};
type TokenChange = (tokens: PublicToken[]) => PublicToken[];
type TokenSnapshot = { sceneId: string; changes: TokenChange[] };

function mergeChat(current: ChatItem[], incoming: ChatItem[]) {
  const byId = new Map(incoming.map((item) => [item.id, { ...item, private: Boolean(item.private || item.recipientId) } as ChatItem]));
  for (const item of current) byId.set(item.id, item);
  return [...byId.values()].sort((left, right) => (left.createdAt ?? '').localeCompare(right.createdAt ?? '')).slice(-100);
}

function mergeToken(items: PublicToken[], next: PublicToken, canManage: boolean) {
  const previous = items.find((item) => item.id === next.id);
  if (!previous) return [...items, next];
  if (previous.version > next.version) return items;
  const ownerNote = next.ownerNote ?? (previous.ownerUserId === next.ownerUserId ? previous.ownerNote : undefined);
  const projection = canManage && previous.hidden !== undefined && next.hidden === undefined
    ? { ...previous, ...next, resources: previous.resources }
    : next;
  const token = ownerNote === undefined ? projection : { ...projection, ownerNote };
  return items.map((item) => item.id === next.id ? token : item);
}

function latestInitiative(current: InitiativeView, next: InitiativeView) {
  if (current.tracker && (!next.tracker || current.tracker.version > next.tracker.version)) return current;
  return next;
}

export function useTabletopSync({ user, campaign, socket, setCampaign, setCampaigns, setError, setUser }: Options) {
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [scene, updateScene] = useState<Scene | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tokens, setTokens] = useState<PublicToken[]>([]);
  const [layers, setLayers] = useState<PublicSceneLayer[]>([]);
  const [objects, setObjects] = useState<PublicSceneObject[]>([]);
  const [activeLayerId, setActiveLayerId] = useState('');
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [rolls, setRolls] = useState<RollItem[]>([]);
  const [initiative, updateInitiative] = useState<InitiativeView>({ tracker: null, entries: [] });
  const setInitiative = useCallback((view: InitiativeView) => updateInitiative((current) => latestInitiative(current, view)), []);
  const [connected, setConnected] = useState(false);
  const campaignId = campaign?.campaign.id ?? null;
  const role = campaign?.role;
  const userId = user?.id;
  const campaignIdRef = useRef(campaignId);
  campaignIdRef.current = campaignId;
  const scope = `${userId ?? ''}:${campaignId ?? ''}:${role ?? ''}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const sceneIdRef = useRef<string | null>(null);
  const sceneRequest = useRef(0);
  const contentRequest = useRef(0);
  const tokenSnapshot = useRef<TokenSnapshot | null>(null);

  const clearScene = useCallback(() => {
    sceneIdRef.current = null;
    tokenSnapshot.current = null;
    contentRequest.current++;
    updateScene(null);
    setTokens([]);
    setLayers([]);
    setObjects([]);
    setActiveLayerId('');
  }, []);

  const setScene = useCallback((value: Scene | null) => {
    if (value === null) clearScene();
    else if (sceneIdRef.current === value.id && value.campaignId === campaignIdRef.current) {
      updateScene((current) => current && current.version > value.version ? current : value);
    }
  }, [clearScene]);

  const reloadSceneContent = useCallback(async (sceneId: string) => {
    if (sceneIdRef.current !== sceneId) return;
    const request = ++contentRequest.current;
    const currentScope = scopeRef.current;
    const active = () => scopeRef.current === currentScope && sceneIdRef.current === sceneId && contentRequest.current === request;
    try {
      const [nextLayers, nextObjects] = await Promise.all([
        api<PublicSceneLayer[]>(`/api/scenes/${sceneId}/layers`),
        api<PublicSceneObject[]>(`/api/scenes/${sceneId}/objects`),
      ]);
      if (!active()) return;
      setLayers(nextLayers);
      setObjects(nextObjects);
      setActiveLayerId((current) => nextLayers.some((layer) => layer.id === current) ? current : nextLayers.find((layer) => layer.kind === 'OBJECTS')?.id ?? nextLayers[0]?.id ?? '');
    } catch (error) { if (active()) setError((error as Error).message); }
  }, [setError]);

  const openScene = useCallback(async (next: Scene) => {
    if (next.campaignId !== campaignIdRef.current) return;
    if (sceneIdRef.current !== next.id) clearScene();
    sceneIdRef.current = next.id;
    updateScene((current) => current?.id === next.id && current.version > next.version ? current : next);
    const currentScope = scopeRef.current;
    const snapshot: TokenSnapshot = { sceneId: next.id, changes: [] };
    tokenSnapshot.current = snapshot;
    const active = () => scopeRef.current === currentScope && tokenSnapshot.current === snapshot;
    await Promise.all([
      api<PublicToken[]>(`/api/scenes/${next.id}/tokens`).then((list) => {
        if (active()) setTokens(snapshot.changes.reduce((items, apply) => apply(items), list));
      }).catch((error) => { if (active()) setError((error as Error).message); }).finally(() => {
        if (active()) tokenSnapshot.current = null;
      }),
      reloadSceneContent(next.id),
    ]);
  }, [clearScene, reloadSceneContent, setError]);

  useLayoutEffect(() => {
    clearScene();
    setScenes([]);
    setMessages([]);
    setRolls([]);
    setMembers([]);
    updateInitiative({ tracker: null, entries: [] });
    setConnected(false);
  }, [scope, clearScene]);

  useEffect(() => {
    if (!campaignId || !userId) return;
    let active = true;
    const current = () => active && scopeRef.current === scope;
    const canManage = role === 'OWNER' || role === 'GM';
    const report = (error: Error) => { if (current()) setError(error.message); };

    const refreshScenes = async () => {
      const request = ++sceneRequest.current;
      const list = await api<Scene[]>(`/api/campaigns/${campaignId}/scenes`);
      if (!current() || sceneRequest.current !== request) return;
      setScenes(list);
      const next = (canManage ? list.find((item) => item.id === sceneIdRef.current) : undefined)
        ?? list.find((item) => item.isActive) ?? list[0];
      if (next) await openScene(next);
      else clearScene();
    };

    const refreshCampaign = () => {
      void refreshScenes().catch(report);
      void api<Member[]>(`/api/campaigns/${campaignId}/members`).then((list) => { if (current()) setMembers(list); }).catch(report);
      void api<ChatItem[]>(`/api/campaigns/${campaignId}/messages`).then((list) => { if (current()) setMessages((prev) => mergeChat(prev, list)); }).catch(report);
      void api<InitiativeView>(`/api/campaigns/${campaignId}/initiative`).then((view) => { if (current()) setInitiative(view); }).catch(report);
    };

    const closeCampaign = (removedId: string) => {
      setCampaigns((items) => items.filter((item) => item.campaign.id !== removedId));
      setCampaign((item) => item?.campaign.id === removedId ? null : item);
      if (removedId === campaignId) clearScene();
    };

    const changeRole = (nextRole: string) => {
      if (nextRole === role) return;
      const update = (entry: Campaign) => entry.campaign.id === campaignId ? { ...entry, role: nextRole } : entry;
      clearScene();
      setCampaign((entry) => entry ? update(entry) : entry);
      setCampaigns((entries) => entries.map(update));
    };

    const onConnect = () => {
      socket.emit('campaign:join', campaignId, (result: { role?: string; error?: string }) => {
        if (!current()) return;
        if (result.error === 'FORBIDDEN') { closeCampaign(campaignId); return; }
        if (result.error) { if (result.error !== 'JOIN_CANCELLED') setError(result.error); return; }
        if (result.role && result.role !== role) { changeRole(result.role); return; }
        setConnected(true);
        refreshCampaign();
      });
    };

    const onDisconnect = (reason: string) => {
      if (!current()) return;
      setConnected(false);
      if (reason !== 'io server disconnect') return;
      void api<{ user: User }>('/api/auth/me').then(() => {
        if (current()) socket.connect();
      }).catch((error: Error) => {
        if (current() && error.message === 'UNAUTHENTICATED') {
          setCampaign(null);
          setCampaigns([]);
          setUser(null);
        }
      });
    };

    const applyTokenChange = (id: string, change: TokenChange) => {
      if (!current() || sceneIdRef.current !== id) return;
      const snapshot = tokenSnapshot.current;
      if (snapshot?.sceneId === id) snapshot.changes.push(change);
      setTokens(change);
    };
    const onToken = (token: PublicToken) => {
      if (!canManage && token.hidden) return;
      applyTokenChange(token.sceneId, (items) => mergeToken(items, token, canManage));
    };
    const onTokenHidden = ({ id, sceneId }: { id: string; sceneId: string }) => {
      applyTokenChange(sceneId, (items) => items.filter((item) => item.id !== id));
    };
    const onOwnerNote = ({ id, ownerUserId, ownerNote, version }: { id: string; ownerUserId: string; ownerNote: string; version: number }) => {
      const sceneId = sceneIdRef.current;
      if (!sceneId || ownerUserId !== userId) return;
      applyTokenChange(sceneId, (items) => items.map((item) => item.id === id && item.ownerUserId === userId && item.version <= version ? { ...item, ownerNote } : item));
    };

    const onChat = (item: ChatItem) => { if (current() && item.campaignId === campaignId) setMessages((items) => mergeChat(items, [item])); };
    const onDice = (roll: RollItem) => {
      if (current() && roll.campaignId === campaignId) setRolls((items) => roll.id && items.some((item) => item.id === roll.id) ? items : [...items.slice(-19), roll]);
    };
    const onPointer = (pointer: SharedPointer) => {
      if (current() && pointer.sceneId === sceneIdRef.current && pointer.userId !== userId) window.dispatchEvent(new CustomEvent('nri-shared-pointer', { detail: pointer }));
    };
    const onSceneUpdated = ({ scene: updated }: { scene: Partial<Scene> & { id: string } }) => {
      if (!current() || updated.campaignId !== campaignId) return;
      const apply = (item: Scene) => item.id === updated.id && item.version <= (updated.version ?? 0) ? { ...item, ...updated } : item;
      setScenes((items) => items.map(apply));
      updateScene((item) => item ? apply(item) : item);
    };
    const onDrawingPermission = ({ id, playersCanDraw }: { id: string; playersCanDraw: boolean }) => {
      if (!current() || id !== campaignId) return;
      const apply = (item: Campaign) => item.campaign.id === id ? { ...item, campaign: { ...item.campaign, playersCanDraw } } : item;
      setCampaign((item) => item ? apply(item) : item);
      setCampaigns((items) => items.map(apply));
    };
    const onSceneActivated = (event: { campaignId?: string }) => {
      if (current() && (!event.campaignId || event.campaignId === campaignId)) void refreshScenes().catch(report);
    };
    const onMembershipChanged = (event: { campaignId?: string; userId: string; role: string }) => {
      if (!current() || (event.campaignId && event.campaignId !== campaignId)) return;
      if (event.userId === userId) changeRole(event.role);
      else setMembers((items) => items.map((item) => item.userId === event.userId ? { ...item, role: event.role } : item));
    };
    const onMembershipRemoved = (event: { userId: string; campaignId: string }) => {
      if (current() && event.userId === userId) closeCampaign(event.campaignId);
    };
    const onArchived = (event: { campaignId: string }) => { if (current()) closeCampaign(event.campaignId); };
    const reload = ({ sceneId }: { sceneId: string }) => { if (current()) void reloadSceneContent(sceneId); };
    const onObject = ({ object }: { object: PublicSceneObject }) => reload(object);
    const onInitiative = (view: InitiativeView & { campaignId?: string }) => {
      if (current() && (!view.campaignId || view.campaignId === campaignId)) setInitiative(view);
    };

    const listeners = {
      connect: onConnect, disconnect: onDisconnect,
      'campaign:archived': onArchived, 'campaign:drawing_permission': onDrawingPermission,
      'membership:changed': onMembershipChanged, 'membership:removed': onMembershipRemoved,
      'scene:updated': onSceneUpdated, 'scene:activated': onSceneActivated, 'scene:pointer': onPointer,
      'scene:layer_created': reload, 'scene:layer_updated': reload, 'scene:layer_hidden': reload, 'scene:layer_deleted': reload,
      'scene:object_created': onObject, 'scene:object_updated': onObject, 'scene:object_deleted': reload,
      'token:moved': onToken, 'token:updated': onToken, 'token:created': onToken, 'token:hidden': onTokenHidden, 'token:owner_note': onOwnerNote,
      'chat:message': onChat, 'chat:private': onChat, 'dice:result': onDice,
      [canManage ? 'initiative:gm_updated' : 'initiative:updated']: onInitiative,
    };
    for (const [event, handler] of Object.entries(listeners)) socket.on(event, handler);
    if (socket.connected) onConnect();
    else refreshCampaign();

    return () => {
      active = false;
      for (const [event, handler] of Object.entries(listeners)) socket.off(event, handler);
      if (socket.connected) socket.emit('campaign:leave', campaignId);
    };
  }, [scope, campaignId, role, userId, socket, clearScene, openScene, reloadSceneContent, setCampaign, setCampaigns, setError, setUser, setInitiative]);

  return { scenes, setScenes, scene, setScene, tokens, setTokens, layers, setLayers, objects, setObjects, activeLayerId, setActiveLayerId,
    members, messages, setMessages, rolls, setRolls, initiative, setInitiative, connected, campaignIdRef, openScene, reloadSceneContent };
}
