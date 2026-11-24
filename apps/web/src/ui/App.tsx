import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { io, type Socket } from 'socket.io-client';
import { useTranslation } from 'react-i18next';
import type { PublicToken, TokenResource } from '@nri/contracts';
import { calculateCellSize } from './canvasMath';
const TableCanvas = lazy(() => import('./TableCanvas').then(({ TableCanvas: component }) => ({ default: component })));

type User = { id: string; email: string; displayName: string };
type Campaign = { campaign: { id: string; title: string; description: string }; role: string };
type Scene = { id: string; campaignId: string; title: string; gridSize: number; width: number; height: number; gridColor: string; gridOpacity: number; gridOffsetX: number; gridOffsetY: number; gridEnabled: boolean; snapToGrid: boolean; unitsPerCell: number; unitLabel: string; backgroundAssetId: string | null; isActive: boolean; published: boolean; sortOrder: number; cameraX: number; cameraY: number; cameraZoom: number; version: number; archivedAt: string | null };
type Member = { userId: string; displayName: string; role: string };
type CampaignAsset = { id: string; name: string; category: 'MAP' | 'TOKEN' | 'DECORATION' | 'PORTRAIT' | 'OTHER'; mediaType: string; size: number; usageCount: number };
type DeletedToken = { id: string; sceneId: string; sceneTitle: string; name: string; version: number; deletedAt: string; sceneArchivedAt: string | null };
type SceneLayer = { id: string; sceneId: string; name: string; kind: string; sortOrder: number; visibleToPlayers: boolean; locked: boolean; version: number };
type SceneObject = { id: string; sceneId: string; layerId: string; kind: string; x: number; y: number; width: number; height: number; rotation: number; opacity: number; zIndex: number; assetId: string | null; color: string | null; strokeWidth: number | null; points: Array<{ x: number; y: number }> | null; text: string | null; visible: boolean; locked: boolean; version: number };
type ChatItem = { id: string; senderId: string; displayName: string; body: string; createdAt?: string; private?: boolean; recipientId?: string | null };
type RollItem = { id?: string; displayName: string; expression: string; rolls: number[]; modifier: number; result: number };
type InitiativeView = { tracker: { id: string; active: boolean; round: number; version: number; activeIndex?: number; currentEntryId: string | null } | null; entries: Array<{ id: string; tokenId: string | null; label: string; score: number }> };

function mergeToken(items: PublicToken[], incoming: PublicToken): PublicToken[] {
  return items.map((item) => {
    if (item.id !== incoming.id) return item;
    if (incoming.ownerNote !== undefined || incoming.ownerUserId !== item.ownerUserId) return incoming;
    return item.ownerNote === undefined ? incoming : { ...incoming, ownerNote: item.ownerNote };
  });
}

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...options, credentials: 'include', headers: { 'content-type': 'application/json', ...options.headers } });
  const result = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(result?.error ?? 'REQUEST_FAILED');
  return result as T;
}

export function App() {
  const { t, i18n } = useTranslation();
  const [user, setUser] = useState<User | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [scenes, setScenes] = useState<Scene[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [scene, setScene] = useState<Scene | null>(null);
  const [tokens, setTokens] = useState<PublicToken[]>([]);
  const [selectedTokenIds, setSelectedTokenIds] = useState<string[]>([]);
  const [assets, setAssets] = useState<CampaignAsset[]>([]);
  const [deletedTokens, setDeletedTokens] = useState<DeletedToken[]>([]);
  const [assetStorageBytes, setAssetStorageBytes] = useState(0);
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [tokenTrashOpen, setTokenTrashOpen] = useState(false);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetCategoryFilter, setAssetCategoryFilter] = useState('ALL');
  const [assetSort, setAssetSort] = useState<'NAME' | 'SIZE'>('NAME');
  const [assetUploadCategory, setAssetUploadCategory] = useState<CampaignAsset['category']>('OTHER');
  const [layers, setLayers] = useState<SceneLayer[]>([]);
  const [objects, setObjects] = useState<SceneObject[]>([]);
  const [activeLayerId, setActiveLayerId] = useState('');
  const [drawMode, setDrawMode] = useState(false);
  const [drawingColor, setDrawingColor] = useState('#c8794a');
  const [drawingWidth, setDrawingWidth] = useState(3);
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [rolls, setRolls] = useState<RollItem[]>([]);
  const [initiative, setInitiative] = useState<InitiativeView>({ tracker: null, entries: [] });
  const [initiativeScores, setInitiativeScores] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  useEffect(() => { setSelectedTokenIds([]); }, [scene?.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [chatText, setChatText] = useState('');
  const [messageRecipient, setMessageRecipient] = useState('');
  const [sceneDialog, setSceneDialog] = useState<'create' | 'rename' | 'grid' | null>(null);
  const [calibrationActive, setCalibrationActive] = useState(false);
  const [calibrationDistance, setCalibrationDistance] = useState<number | null>(null);
  const [calibrationCellCount, setCalibrationCellCount] = useState('1');
  const [gridPreviewSize, setGridPreviewSize] = useState<number | null>(null);
  const [gridPreviewOffsetX, setGridPreviewOffsetX] = useState<number | null>(null);
  const [gridPreviewOffsetY, setGridPreviewOffsetY] = useState<number | null>(null);
  const [calibrationDialog, setCalibrationDialog] = useState(false);
  const [sceneTitle, setSceneTitle] = useState('');
  const [archivedScenes, setArchivedScenes] = useState<Scene[]>([]);
  const [showArchivedScenes, setShowArchivedScenes] = useState(false);
  const [confirmAction, setConfirmAction] = useState<(() => void) | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [sceneMenu, setSceneMenu] = useState<{ x: number; y: number; scene: Scene } | null>(null);
  const mapInput = useRef<HTMLInputElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const socket = useMemo<Socket>(() => io({ autoConnect: false, withCredentials: true, transports: ['websocket', 'polling'] }), []);
  const role = campaign?.role ?? 'PLAYER';
  const canManage = role === 'OWNER' || role === 'GM';
  const visibleAssets = useMemo(() => assets.filter((asset) => (assetCategoryFilter === 'ALL' || asset.category === assetCategoryFilter) && asset.name.toLocaleLowerCase().includes(assetSearch.trim().toLocaleLowerCase())).sort((a, b) => assetSort === 'SIZE' ? b.size - a.size : a.name.localeCompare(b.name)), [assets, assetCategoryFilter, assetSearch, assetSort]);

  useEffect(() => {
    if (calibrationDistance === null) { setGridPreviewSize(null); return; }
    setGridPreviewSize(calculateCellSize(calibrationDistance, Number(calibrationCellCount)));
  }, [calibrationDistance, calibrationCellCount]);

  useEffect(() => { void api<{ user: User }>('/api/auth/me').then((result) => setUser(result.user)).catch(() => {}); return () => { socket.disconnect(); }; }, [socket]);
  useEffect(() => {
    if (!user) return;
    const invite = new URLSearchParams(location.search).get('invite');
    if (invite) {
      void api<{ campaignId: string }>(`/api/invitations/${encodeURIComponent(invite)}/accept`, { method: 'POST' }).then(async ({ campaignId }) => {
        history.replaceState(null, '', location.pathname);
        const list = await api<Campaign[]>('/api/campaigns'); setCampaigns(list);
        const joined = list.find((entry) => entry.campaign.id === campaignId); if (joined) setCampaign(joined);
      }).catch((e) => { history.replaceState(null, '', location.pathname); setError((e as Error).message); });
    } else void api<Campaign[]>('/api/campaigns').then(setCampaigns).catch((e) => setError(e.message));
  }, [user]);
  useEffect(() => {
    if (!campaign) return;
    let active = true;
    void api<Scene[]>(`/api/campaigns/${campaign.campaign.id}/scenes`).then(async (list) => {
      if (!active) return;
      setScenes(list);
      const first = list[0];
      if (first) await openScene(first);
      else setScene(null);
    }).catch((e) => setError(e.message));
    return () => { active = false; setScene(null); setTokens([]); setLayers([]); setObjects([]); setActiveLayerId(''); socket.emit('campaign:leave', campaign.campaign.id); };
  }, [campaign?.campaign.id]);
  useEffect(() => {
    if (!campaign) return;
    void api<Member[]>(`/api/campaigns/${campaign.campaign.id}/members`).then(setMembers).catch((e) => setError(e.message));
    void api<Array<ChatItem & { recipientId: string | null }>>(`/api/campaigns/${campaign.campaign.id}/messages`).then((list) => setMessages(list.map((message) => ({ ...message, private: Boolean(message.recipientId) })))).catch((e) => setError((e as Error).message));
    void api<InitiativeView>(`/api/campaigns/${campaign.campaign.id}/initiative`).then(setInitiative).catch((e) => setError((e as Error).message));
  }, [campaign?.campaign.id]);

  async function openScene(next: Scene) {
    setScene(next);
    socket.emit('campaign:join', next.campaignId, (result: { error?: string; role?: string }) => {
      if (result?.error) setError(result.error);
      setConnected(!result?.error);
    });
    try {
      const [nextTokens, nextLayers, nextObjects] = await Promise.all([
        api<PublicToken[]>(`/api/scenes/${next.id}/tokens`),
        api<SceneLayer[]>(`/api/scenes/${next.id}/layers`),
        api<SceneObject[]>(`/api/scenes/${next.id}/objects`),
      ]);
      setTokens(nextTokens); setLayers(nextLayers); setObjects(nextObjects);
      setActiveLayerId((current) => nextLayers.some((layer) => layer.id === current) ? current : nextLayers.find((layer) => layer.kind === 'OBJECTS')?.id ?? nextLayers[0]?.id ?? '');
    } catch (e) { setError((e as Error).message); }
  }
  async function reloadSceneContent(sceneId: string) {
    if (scene?.id !== sceneId) return;
    try {
      const [nextLayers, nextObjects] = await Promise.all([api<SceneLayer[]>(`/api/scenes/${sceneId}/layers`), api<SceneObject[]>(`/api/scenes/${sceneId}/objects`)]);
      setLayers(nextLayers); setObjects(nextObjects); setActiveLayerId((current) => nextLayers.some((layer) => layer.id === current) ? current : nextLayers.find((layer) => layer.kind === 'OBJECTS')?.id ?? nextLayers[0]?.id ?? '');
    } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      if (scene) socket.emit('campaign:join', scene.campaignId, async (result: { error?: string }) => {
        if (result?.error) { setError(result.error); return; }
        try { setTokens(await api<PublicToken[]>(`/api/scenes/${scene.id}/tokens`)); await reloadSceneContent(scene.id); } catch (e) { setError((e as Error).message); }
      });
    };
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect); socket.on('disconnect', onDisconnect);
    socket.on('token:moved', (token: PublicToken) => setTokens((items) => mergeToken(items, token)));
    socket.on('token:created', (token: PublicToken) => setTokens((items) => items.some((item) => item.id === token.id) ? items : [...items, token]));
    socket.on('token:updated', (token: PublicToken) => setTokens((items) => mergeToken(items, token)));
    socket.on('token:owner_note', ({ id, ownerUserId, ownerNote }: { id: string; ownerUserId: string | null; ownerNote: string }) => setTokens((items) => items.map((item) => {
      if (item.id !== id) return item;
      if (ownerUserId === user?.id) return { ...item, ownerUserId, ownerNote };
      const { ownerNote: _ownerNote, ...withoutOwnerNote } = item;
      return { ...withoutOwnerNote, ownerUserId };
    })));
    socket.on('token:hidden', ({ id }: { id: string }) => setTokens((items) => items.filter((item) => item.id !== id)));
    socket.on('chat:message', (message: ChatItem) => setMessages((items) => items.some((item) => item.id === message.id) ? items : [...items.slice(-99), message]));
    socket.on('chat:private', (message: ChatItem) => setMessages((items) => items.some((item) => item.id === message.id) ? items : [...items.slice(-99), { ...message, private: true }]));
    socket.on('dice:result', (roll: RollItem) => setRolls((items) => roll.id && items.some((item) => item.id === roll.id) ? items : [...items.slice(-19), roll]));
    const onSceneUpdated = ({ scene: updated }: { scene: Partial<Scene> & { id: string } }) => {
      setScenes((items) => items.map((item) => item.id === updated.id ? { ...item, ...updated } : item));
      setScene((item) => item?.id === updated.id ? { ...item, ...updated } : item);
    };
    const onSceneActivated = async ({ sceneId }: { sceneId: string | null }) => {
      if (!campaign) return;
      try {
        const list = await api<Scene[]>(`/api/campaigns/${campaign.campaign.id}/scenes`); setScenes(list);
        if (canManage) setScene((item) => item ? list.find((entry) => entry.id === item.id) ?? item : null);
        else if (sceneId) { const next = list.find((entry) => entry.id === sceneId); if (next) await openScene(next); }
        else { setScene(null); setTokens([]); }
      } catch (e) { setError((e as Error).message); }
    };
    const refreshSceneContent = ({ sceneId }: { sceneId: string }) => { if (sceneId) void reloadSceneContent(sceneId); };
    const refreshChangedObject = ({ object }: { object: SceneObject }) => { if (object?.sceneId === scene?.id) void reloadSceneContent(object.sceneId); };
    const removeChangedObject = ({ sceneId, objectId }: { sceneId: string; objectId: string }) => { if (sceneId === scene?.id) setObjects((items) => items.filter((object) => object.id !== objectId)); };
    const onMembershipRemoved = ({ userId }: { userId: string }) => {
      if (userId !== user?.id) return;
      setCampaign(null); setCampaigns((items) => items.filter((item) => item.campaign.id !== campaign?.campaign.id));
      setError('Your campaign access was removed.');
    };
    socket.on('scene:updated', onSceneUpdated); socket.on('scene:activated', onSceneActivated); socket.on('scene:unavailable', () => { setScene(null); setTokens([]); setLayers([]); setObjects([]); }); socket.on('membership:removed', onMembershipRemoved);
    socket.on('scene:layer_created', refreshSceneContent); socket.on('scene:layer_updated', refreshSceneContent); socket.on('scene:layer_hidden', refreshSceneContent); socket.on('scene:layer_deleted', refreshSceneContent);
    socket.on('scene:object_created', refreshChangedObject); socket.on('scene:object_updated', refreshChangedObject); socket.on('scene:object_deleted', removeChangedObject);
    socket.on('initiative:updated', (view: InitiativeView) => setInitiative(view));
    socket.on('initiative:gm_updated', (view: InitiativeView) => setInitiative(view));
    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); socket.off('token:moved'); socket.off('token:created'); socket.off('token:updated'); socket.off('token:owner_note'); socket.off('token:hidden'); socket.off('chat:message'); socket.off('chat:private'); socket.off('dice:result'); socket.off('scene:updated', onSceneUpdated); socket.off('scene:activated', onSceneActivated); socket.off('scene:unavailable'); socket.off('membership:removed', onMembershipRemoved); socket.off('scene:layer_created', refreshSceneContent); socket.off('scene:layer_updated', refreshSceneContent); socket.off('scene:layer_hidden', refreshSceneContent); socket.off('scene:layer_deleted', refreshSceneContent); socket.off('scene:object_created', refreshChangedObject); socket.off('scene:object_updated', refreshChangedObject); socket.off('scene:object_deleted', removeChangedObject); socket.off('initiative:updated'); socket.off('initiative:gm_updated'); };
  }, [socket, scene?.id, campaign?.campaign.id, canManage, user?.id]);
  useEffect(() => { if (user && !socket.connected) socket.connect(); }, [user, socket]);

  async function submitAuth(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const form = new FormData(event.currentTarget);
    try {
      const input = Object.fromEntries(form.entries());
      const data = await api<{ user: User }>(`/api/auth/${authMode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(input) }); setUser(data.user);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function createCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(''); const data = new FormData(event.currentTarget);
    try { const created = await api<{ campaign: Campaign['campaign'] }>('/api/campaigns', { method: 'POST', body: JSON.stringify({ title: data.get('title'), description: data.get('description') }) }); const entry = { campaign: created.campaign, role: 'OWNER' }; setCampaigns((items) => [...items, entry]); setCampaign(entry); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function addScene() {
    if (!campaign || !sceneTitle.trim()) return;
    try { const data = await api<{ scene: Scene }>('/api/scenes', { method: 'POST', body: JSON.stringify({ campaignId: campaign.campaign.id, title: sceneTitle.trim() }) }); setScenes((items) => [...items, data.scene].sort((a, b) => a.sortOrder - b.sortOrder)); setSceneTitle(''); setSceneDialog(null); await openScene(data.scene); }
    catch (e) { setError((e as Error).message); }
  }
  async function patchScene(patch: Partial<Scene>) {
    if (!scene) return;
    const { scene: updated } = await api<{ scene: Scene }>(`/api/scenes/${scene.id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, expectedVersion: scene.version }) });
    setScene(updated); setScenes((items) => items.map((item) => item.id === updated.id ? updated : item));
  }
  async function renameScene() {
    if (!scene || !sceneTitle.trim()) return;
    try { await patchScene({ title: sceneTitle.trim() }); setSceneDialog(null); setSceneTitle(''); }
    catch (e) { setError((e as Error).message); }
  }
  async function duplicateScene(target: Scene) {
    try { const { scene: duplicate } = await api<{ scene: Scene }>(`/api/scenes/${target.id}/duplicate`, { method: 'POST' }); setScenes((items) => [...items, duplicate].sort((a, b) => a.sortOrder - b.sortOrder)); setNotice(t('duplicateDraft')); }
    catch (e) { setError((e as Error).message); }
  }
  async function performArchive(target: Scene) {
    try {
      await api(`/api/scenes/${target.id}/archive`, { method: 'PUT', body: JSON.stringify({ expectedVersion: target.version }) });
      const next = scenes.filter((item) => item.id !== target.id); setScenes(next);
      if (scene?.id === target.id) { const active = next.find((item) => item.isActive); if (active) await openScene(active); else { setScene(null); setTokens([]); } }
      setConfirmAction(null);
    } catch (e) { setError((e as Error).message); }
  }
  function archiveScene(target: Scene) { setConfirmText(t('archiveConfirm', { title: target.title })); setConfirmAction(() => () => void performArchive(target)); }
  async function performActivation(target: Scene) {
    try {
      const { scene: activated } = await api<{ scene: Scene }>(`/api/scenes/${target.id}/activate`, { method: 'PUT', body: JSON.stringify({ expectedVersion: target.version }) });
      setScenes((items) => items.map((item) => ({ ...item, isActive: item.id === activated.id, published: item.id === activated.id || item.published })));
      setConfirmAction(null); setNotice(t('activeChanged'));
    } catch (e) { setError((e as Error).message); }
  }
  function activateScene(target: Scene) { if (target.isActive) return; setConfirmText(t('activeConfirm', { title: target.title })); setConfirmAction(() => () => void performActivation(target)); }
  async function restoreScene(target: Scene) {
    try { const { scene: restored } = await api<{ scene: Scene }>(`/api/scenes/${target.id}/restore`, { method: 'PUT', body: JSON.stringify({ expectedVersion: target.version }) }); setArchivedScenes((items) => items.filter((item) => item.id !== target.id)); setScenes((items) => [...items, restored].sort((a, b) => a.sortOrder - b.sortOrder)); }
    catch (e) { setError((e as Error).message); }
  }
  async function loadArchivedScenes() {
    if (!campaign || !canManage) return;
    try { setArchivedScenes(await api<Scene[]>(`/api/campaigns/${campaign.campaign.id}/scenes?archived=true`)); setShowArchivedScenes((value) => !value); }
    catch (e) { setError((e as Error).message); }
  }
  async function reorderScene(target: Scene, direction: -1 | 1) {
    if (!campaign) return;
    const index = scenes.findIndex((item) => item.id === target.id); const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || nextIndex >= scenes.length) return;
    const reordered = [...scenes]; [reordered[index], reordered[nextIndex]] = [reordered[nextIndex]!, reordered[index]!];
    try { const updated = await api<Scene[]>(`/api/campaigns/${campaign.campaign.id}/scenes/reorder`, { method: 'PUT', body: JSON.stringify({ scenes: scenes.map((item) => ({ id: item.id, expectedVersion: item.version })).sort((a, b) => reordered.findIndex((item) => item.id === a.id) - reordered.findIndex((item) => item.id === b.id)) }) }); setScenes(updated); }
    catch (e) { setError((e as Error).message); }
  }
  async function saveGridSettings(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!scene) return;
    const fields = new FormData(event.currentTarget);
    try {
      await patchScene({ gridSize: Number(fields.get('gridSize')), width: Number(fields.get('width')), height: Number(fields.get('height')), gridColor: String(fields.get('gridColor')), gridOpacity: Number(fields.get('gridOpacity')), gridOffsetX: Number(fields.get('gridOffsetX')), gridOffsetY: Number(fields.get('gridOffsetY')), gridEnabled: fields.has('gridEnabled'), snapToGrid: fields.has('snapToGrid'), unitsPerCell: Number(fields.get('unitsPerCell')), unitLabel: String(fields.get('unitLabel')), cameraX: Number(fields.get('cameraX')), cameraY: Number(fields.get('cameraY')), cameraZoom: Number(fields.get('cameraZoom')) });
      setGridPreviewSize(null); setCalibrationDistance(null); setSceneDialog(null); setNotice(t('settingsSaved'));
    } catch (e) { setError((e as Error).message); }
  }
  async function addSceneObject(kind: 'RECTANGLE' | 'ELLIPSE' | 'LINE') {
    if (!scene || !activeLayerId) return;
    try {
      const width = scene.gridSize * 2; const height = scene.gridSize * 2;
      const points = kind === 'LINE' ? [{ x: 0, y: height / 2 }, { x: width, y: height / 2 }] : undefined;
      const { object } = await api<{ object: SceneObject }>(`/api/scenes/${scene.id}/objects`, { method: 'POST', body: JSON.stringify({ layerId: activeLayerId, kind, x: Math.round(scene.width / 2 - scene.gridSize), y: Math.round(scene.height / 2 - scene.gridSize), width, height, color: drawingColor, strokeWidth: drawingWidth, points }) });
      setObjects((items) => [...items, object]);
    } catch (e) { setError((e as Error).message); }
  }
  async function addFreehandDrawing(points: Array<{ x: number; y: number }>) {
    if (!scene || !activeLayerId || points.length < 2) return;
    const xs = points.map((point) => point.x); const ys = points.map((point) => point.y);
    const x = Math.min(...xs); const y = Math.min(...ys); const width = Math.max(8, Math.max(...xs) - x); const height = Math.max(8, Math.max(...ys) - y);
    try {
      const { object } = await api<{ object: SceneObject }>(`/api/scenes/${scene.id}/objects`, { method: 'POST', body: JSON.stringify({ layerId: activeLayerId, kind: 'FREEHAND', x, y, width, height, color: drawingColor, strokeWidth: drawingWidth, points: points.map((point) => ({ x: point.x - x, y: point.y - y })) }) });
      setObjects((items) => [...items, object]);
    } catch (e) { setError((e as Error).message); }
  }
  async function updateSceneObject(object: SceneObject, patch: Partial<SceneObject>) {
    try {
      const { object: updated } = await api<{ object: SceneObject }>(`/api/objects/${object.id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, expectedVersion: object.version }) });
      setObjects((items) => items.map((item) => item.id === updated.id ? updated : item));
    } catch (e) { setError((e as Error).message); }
  }
  async function duplicateSceneObject(object: SceneObject) {
    if (!scene) return;
    try {
      const { object: copy } = await api<{ object: SceneObject }>(`/api/scenes/${scene.id}/objects`, { method: 'POST', body: JSON.stringify({ layerId: object.layerId, kind: object.kind, x: object.x + scene.gridSize / 2, y: object.y + scene.gridSize / 2, width: object.width, height: object.height, rotation: object.rotation, opacity: object.opacity, zIndex: object.zIndex + 1, assetId: object.assetId, color: object.color, strokeWidth: object.strokeWidth, points: object.points, text: object.text, visible: object.visible, locked: false }) });
      setObjects((items) => [...items, copy]);
    } catch (e) { setError((e as Error).message); }
  }
  async function deleteSceneObject(object: SceneObject) {
    try { await api(`/api/objects/${object.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: object.version }) }); setObjects((items) => items.filter((item) => item.id !== object.id)); }
    catch (e) { setError((e as Error).message); }
  }
  async function updateSceneLayer(layer: SceneLayer, patch: Partial<SceneLayer>) {
    try {
      const { layer: updated } = await api<{ layer: SceneLayer }>(`/api/layers/${layer.id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, expectedVersion: layer.version }) });
      setLayers((items) => items.map((item) => item.id === updated.id ? updated : item).sort((a, b) => a.sortOrder - b.sortOrder));
    } catch (e) { setError((e as Error).message); }
  }
  async function addCustomLayer() {
    if (!scene) return;
    try {
      const { layer } = await api<{ layer: SceneLayer }>(`/api/scenes/${scene.id}/layers`, { method: 'POST', body: JSON.stringify({ name: `${t('customLayer')} ${layers.filter((item) => item.kind === 'CUSTOM').length + 1}`, kind: 'CUSTOM', sortOrder: layers.length, visibleToPlayers: true }) });
      setLayers((items) => [...items, layer].sort((a, b) => a.sortOrder - b.sortOrder)); setActiveLayerId(layer.id);
    } catch (e) { setError((e as Error).message); }
  }
  async function deleteCustomLayer(layer: SceneLayer) {
    try { await api(`/api/layers/${layer.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: layer.version }) }); setLayers((items) => items.filter((item) => item.id !== layer.id)); if (activeLayerId === layer.id) setActiveLayerId(layers.find((item) => item.id !== layer.id)?.id ?? ''); }
    catch (e) { setError((e as Error).message); }
  }
  function startGridCalibration() {
    setGridPreviewSize(null); setCalibrationDistance(null); setCalibrationCellCount('1'); setGridPreviewOffsetX(scene?.gridOffsetX ?? 0); setGridPreviewOffsetY(scene?.gridOffsetY ?? 0); setSceneDialog(null); setCalibrationActive(true);
  }
  function finishGridCalibration(start: { x: number; y: number }, end: { x: number; y: number }) {
    setCalibrationActive(false); setCalibrationCellCount('1'); setCalibrationDistance(Math.hypot(end.x - start.x, end.y - start.y)); setCalibrationDialog(true);
  }
  async function saveCalibratedGrid() {
    if (!scene || gridPreviewSize === null) return;
    try { await patchScene({ gridSize: gridPreviewSize, gridOffsetX: gridPreviewOffsetX ?? 0, gridOffsetY: gridPreviewOffsetY ?? 0 }); setCalibrationDialog(false); setCalibrationDistance(null); setGridPreviewSize(null); setGridPreviewOffsetX(null); setGridPreviewOffsetY(null); setNotice(t('settingsSaved')); }
    catch (e) { setError((e as Error).message); }
  }
  async function addToken() {
    if (!scene) return;
    try { const data = await api<{ token: PublicToken }>('/api/tokens', { method: 'POST', body: JSON.stringify({ sceneId: scene.id, name: `Token ${tokens.length + 1}`, x: 3 + tokens.length % 5, y: 3, color: ['#c8794a', '#668d7b', '#b2a26a', '#9b738d'][tokens.length % 4] }) }); setTokens((items) => items.some((item) => item.id === data.token.id) ? items : [...items, data.token]); }
    catch (e) { setError((e as Error).message); }
  }
  async function invite() {
    if (!campaign) return;
    try { const data = await api<{ invitation: string }>('/api/invitations', { method: 'POST', body: JSON.stringify({ campaignId: campaign.campaign.id }) }); const link = `${location.origin}/?invite=${data.invitation}`; await navigator.clipboard.writeText(link); setNotice(t('inviteCreated')); }
    catch (e) { setError((e as Error).message); }
  }
  async function assignToken(token: PublicToken, ownerUserId: string) {
    try { const result = await api<{ token: PublicToken }>(`/api/tokens/${token.id}/owner`, { method: 'POST', body: JSON.stringify({ ownerUserId: ownerUserId || null }) }); setTokens((items) => items.map((item) => item.id === token.id ? result.token : item)); }
    catch (e) { setError((e as Error).message); }
  }
  async function updateToken(token: PublicToken, patch: Partial<PublicToken>) {
    try { const result = await api<{ token: PublicToken }>(`/api/tokens/${token.id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, expectedVersion: token.version }) }); setTokens((items) => items.map((item) => item.id === token.id ? result.token : item)); }
    catch (e) { setError((e as Error).message); if (scene) try { setTokens(await api<PublicToken[]>(`/api/scenes/${scene.id}/tokens`)); } catch { /* Keep the original update error visible. */ } }
  }
  async function updateTokenGroup(patch: Partial<Pick<PublicToken, 'color' | 'hidden' | 'locked' | 'showName' | 'opacity' | 'zIndex'>>) {
    if (!scene) return;
    const selected = tokens.filter((token) => selectedTokenIds.includes(token.id));
    if (selected.length < 2) return;
    try {
      const result = await api<{ tokens: PublicToken[] }>(`/api/scenes/${scene.id}/tokens/group`, { method: 'PATCH', body: JSON.stringify({ updates: selected.map((token) => ({ tokenId: token.id, expectedVersion: token.version, patch })) }) });
      setTokens((items) => items.map((token) => result.tokens.find((next) => next.id === token.id) ?? token));
    } catch (e) { setError((e as Error).message); if (scene) try { setTokens(await api<PublicToken[]>(`/api/scenes/${scene.id}/tokens`)); } catch { /* Keep the original update error visible. */ } }
  }
  async function moveTokenGroup(tokenIds: string[], deltaX: number, deltaY: number) {
    if (!scene) return;
    const selected = tokens.filter((token) => tokenIds.includes(token.id));
    if (selected.length < 2 || selected.length > 50) return;
    try {
      const result = await api<{ tokens: PublicToken[] }>(`/api/scenes/${scene.id}/tokens/group`, { method: 'PATCH', body: JSON.stringify({ updates: selected.map((token) => ({ tokenId: token.id, expectedVersion: token.version, patch: { x: token.x + deltaX, y: token.y + deltaY } })) }) });
      setTokens((items) => items.map((token) => result.tokens.find((next) => next.id === token.id) ?? token));
    } catch (e) { setError((e as Error).message); try { setTokens(await api<PublicToken[]>(`/api/scenes/${scene.id}/tokens`)); } catch { /* Keep the original update error visible. */ } }
  }
  async function updateTokenResource(token: PublicToken, index: 0 | 1, patch: Partial<TokenResource>) {
    const resources = token.resources.map((resource, resourceIndex) => {
      const current = resource ?? { label: `Resource ${resourceIndex + 1}`, current: 0, maximum: 0 };
      const visible = resource?.visible ?? false;
      const next = resourceIndex === index ? { ...current, ...patch, visible: patch.visible ?? visible } : { ...current, visible };
      if (resourceIndex === index && next.current > next.maximum) next.current = next.maximum;
      return next;
    }) as [TokenResource, TokenResource];
    await updateToken(token, { resources });
  }
  async function adjustTokenResource(token: PublicToken, resourceIndex: 0 | 1, delta: -1 | 1) {
    try {
      const result = await api<{ token: PublicToken }>(`/api/tokens/${token.id}/resources/adjust`, { method: 'POST', body: JSON.stringify({ resourceIndex, delta, expectedVersion: token.version }) });
      setTokens((items) => items.map((item) => item.id === token.id ? result.token : item));
    } catch (e) { setError((e as Error).message); if (scene) try { setTokens(await api<PublicToken[]>(`/api/scenes/${scene.id}/tokens`)); } catch { /* Keep the original resource error visible. */ } }
  }
  async function uploadBackground(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = '';
    if (!file || !campaign || !scene) return;
    const form = new FormData(); form.set('file', file);
    try {
      const upload = await fetch(`/api/campaigns/${campaign.campaign.id}/assets`, { method: 'POST', credentials: 'include', body: form });
      const uploaded = await upload.json(); if (!upload.ok) throw new Error(uploaded.error ?? 'UPLOAD_FAILED');
      const updated = await api<{ scene: Scene }>(`/api/scenes/${scene.id}/background`, { method: 'PUT', body: JSON.stringify({ assetId: uploaded.asset.id, expectedVersion: scene.version }) });
      setScene(updated.scene); setScenes((items) => items.map((item) => item.id === scene.id ? updated.scene : item)); setNotice('Map uploaded');
    } catch (e) { setError((e as Error).message); }
  }
  async function openAssetLibrary() {
    if (!campaign) return;
    try { const library = await api<{ assets: CampaignAsset[]; storageBytes: number }>(`/api/campaigns/${campaign.campaign.id}/assets`); setAssets(library.assets); setAssetStorageBytes(library.storageBytes); setAssetLibraryOpen(true); }
    catch (e) { setError((e as Error).message); }
  }
  async function uploadAssets(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]; event.target.value = '';
    if (!files.length || !campaign) return;
    const form = new FormData(); for (const file of files) form.append('files', file);
    try {
      const response = await fetch(`/api/campaigns/${campaign.campaign.id}/assets?category=${assetUploadCategory}`, { method: 'POST', credentials: 'include', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'UPLOAD_FAILED');
      setAssets((items) => [...result.assets.map((item: CampaignAsset) => ({ ...item, usageCount: 0 })), ...items]); setAssetStorageBytes((bytes) => bytes + result.assets.reduce((total: number, item: CampaignAsset) => total + item.size, 0));
      if (result.failures?.length) setError(`${result.failures.length} ${t('assetUploadFailed')}`);
      else setNotice(t('assetsUploaded', { count: result.assets.length }));
    } catch (e) { setError((e as Error).message); }
  }
  async function updateAsset(asset: CampaignAsset, patch: Partial<Pick<CampaignAsset, 'name' | 'category'>>) {
    try {
      const result = await api<{ asset: CampaignAsset }>(`/api/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setAssets((items) => items.map((item) => item.id === asset.id ? { ...item, ...result.asset } : item));
    } catch (e) { setError((e as Error).message); }
  }
  async function deleteAsset(asset: CampaignAsset) {
    if (asset.usageCount !== 0) return;
    if (!window.confirm(t('confirmDeleteAsset', { name: asset.name }))) return;
    try { await api(`/api/assets/${asset.id}`, { method: 'DELETE' }); setAssets((items) => items.filter((item) => item.id !== asset.id)); setAssetStorageBytes((bytes) => Math.max(0, bytes - asset.size)); }
    catch (e) { setError((e as Error).message); }
  }
  async function openTokenTrash() {
    if (!campaign) return;
    try { setDeletedTokens(await api<DeletedToken[]>(`/api/campaigns/${campaign.campaign.id}/token-trash`)); setTokenTrashOpen(true); }
    catch (e) { setError((e as Error).message); }
  }
  async function restoreToken(item: DeletedToken) {
    try {
      const result = await api<{ token: PublicToken }>(`/api/tokens/${item.id}/restore`, { method: 'POST', body: JSON.stringify({ expectedVersion: item.version }) });
      if (scene?.id === item.sceneId) setTokens((items) => items.some((token) => token.id === result.token.id) ? items : [...items, result.token]);
      setDeletedTokens((items) => items.filter((token) => token.id !== item.id));
    } catch (e) { setError((e as Error).message); }
  }
  function requestDeleteToken(token: PublicToken) {
    setConfirmText(t('confirmDeleteToken', { name: token.name }));
    setConfirmAction(() => async () => {
      try {
        await api(`/api/tokens/${token.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: token.version }) });
        setTokens((items) => items.filter((item) => item.id !== token.id));
        setConfirmAction(null);
      } catch (e) { setError((e as Error).message); setConfirmAction(null); }
    });
  }
  async function startInitiative() {
    if (!campaign || !scene) return;
    const entries = tokens.map((token) => ({ tokenId: token.id, label: token.name, score: Number(initiativeScores[token.id] ?? 0) }));
    if (!entries.length || entries.some((entry) => !Number.isFinite(entry.score))) { setError('Add a token and a valid initiative score.'); return; }
    try { setInitiative(await api<InitiativeView>(`/api/campaigns/${campaign.campaign.id}/initiative/start`, { method: 'POST', body: JSON.stringify({ sceneId: scene.id, entries }) })); }
    catch (e) { setError((e as Error).message); }
  }
  async function advanceInitiative() {
    if (!campaign || !initiative.tracker) return;
    try { setInitiative(await api<InitiativeView>(`/api/campaigns/${campaign.campaign.id}/initiative/advance`, { method: 'POST', body: JSON.stringify({ expectedVersion: initiative.tracker.version }) })); }
    catch (e) { setError((e as Error).message); }
  }
  async function stopInitiative() {
    if (!campaign || !initiative.tracker) return;
    try { setInitiative(await api<InitiativeView>(`/api/campaigns/${campaign.campaign.id}/initiative/stop`, { method: 'POST', body: JSON.stringify({ expectedVersion: initiative.tracker.version }) })); }
    catch (e) { setError((e as Error).message); }
  }
  function moveToken(token: PublicToken, x: number, y: number) {
    socket.emit('token:move', { tokenId: token.id, x, y, expectedVersion: token.version }, (result: { error?: string; token?: PublicToken }) => {
      if (result?.token) setTokens((items) => items.map((item) => item.id === token.id ? result.token! : item));
      else if (result?.error) setError(result.error === 'CONFLICT' ? 'This token changed elsewhere. Refreshing…' : result.error);
    });
  }
  function sendChat(event: React.FormEvent) {
    event.preventDefault(); if (!campaign || !chatText.trim()) return;
    socket.emit('chat:send', { campaignId: campaign.campaign.id, body: chatText, recipientId: messageRecipient || null }, (result: { error?: string; message?: ChatItem }) => { if (result.message) setMessages((items) => items.some((item) => item.id === result.message!.id) ? items : [...items.slice(-99), result.message!]); if (result.error) setError(result.error); }); setChatText('');
  }
  function rollDice() { if (!campaign) return; socket.emit('dice:roll', { campaignId: campaign.campaign.id, expression: '1d20' }, (result: { error?: string; roll?: RollItem }) => { if (result.roll) setRolls((items) => result.roll!.id && items.some((item) => item.id === result.roll!.id) ? items : [...items.slice(-19), result.roll!]); if (result.error) setError(result.error); }); }

  if (!user) return <main className="auth-shell"><div className="auth-card"><div className="brand-mark">N</div><p className="eyebrow">TABLETOP, REIMAGINED</p><h1>{t('subtitle')}</h1><p className="muted">A calm, flexible space for stories shared around a table.</p><form onSubmit={submitAuth} className="form-stack">
    {authMode === 'register' && <label>{t('displayName')}<input name="displayName" minLength={1} maxLength={48} required /></label>}
    <label>{t('email')}<input type="email" name="email" autoComplete="email" required /></label><label>{t('password')}<input type="password" name="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} minLength={authMode === 'register' ? 12 : 1} required /></label>
    {error && <p className="form-error">{error}</p>}<button className="button primary" disabled={busy}>{t(authMode === 'login' ? 'signIn' : 'signUp')}</button></form><button className="link-button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>{t(authMode === 'login' ? 'signUp' : 'signIn')}</button>
    <div className="language"><button onClick={() => void i18n.changeLanguage('en')}>EN</button><span>·</span><button onClick={() => void i18n.changeLanguage('ru')}>RU</button></div></div></main>;

  return <main className="app-shell"><header className="topbar"><button className="brand" onClick={() => setCampaign(null)}><span className="brand-mark small">N</span><span>NRI</span></button><div className="topbar-right">{campaign && <span className={`live-status ${connected ? 'online' : ''}`}><i />{t(connected ? 'connection' : 'offline')}</span>}<span className="user-chip">{user.displayName}</span><button className="icon-button" title="Language" onClick={() => void i18n.changeLanguage(i18n.language === 'en' ? 'ru' : 'en')}>{i18n.language.toUpperCase()}</button><button className="quiet-button" onClick={() => void api('/api/auth/logout', { method: 'POST' }).finally(() => { setUser(null); setCampaign(null); socket.disconnect(); })}>{t('signOut')}</button></div></header>
    {!campaign ? <section className="campaign-home"><div className="welcome"><p className="eyebrow">YOUR ADVENTURE STARTS HERE</p><h1>{t('campaigns')}</h1><p className="muted">Gather your group and make a little room for the unexpected.</p></div><div className="campaign-layout"><div className="campaign-list">{campaigns.map((item) => <button key={item.campaign.id} className="campaign-card" onClick={() => setCampaign(item)}><span className="campaign-art"><span>✳</span></span><span><strong>{item.campaign.title}</strong><small>{item.campaign.description || item.role}</small></span><span className="card-arrow">↗</span></button>)}{campaigns.length === 0 && <p className="empty-state">{t('noCampaigns')}</p>}</div><form className="create-card" onSubmit={createCampaign}><p className="eyebrow">START SOMETHING NEW</p><h2>{t('newCampaign')}</h2><label>{t('title')}<input name="title" maxLength={80} required /></label><label>{t('description')}<textarea name="description" maxLength={500} rows={3} /></label><button className="button primary" disabled={busy}>{t('create')} <span>↗</span></button></form></div></section> : <section className="table-layout">
      <header className="table-heading"><div><button className="back-link" onClick={() => setCampaign(null)}>← {t('back')}</button><h1>{campaign.campaign.title}</h1><p>{campaign.campaign.description}</p></div><div className="table-actions">{canManage && <><button className="button secondary" onClick={() => void invite()}>{t('invite')} <span>↗</span></button><button className="button secondary" onClick={() => { setSceneTitle(''); setSceneDialog('create'); }}>＋ {t('addScene')}</button><button className="button secondary" onClick={() => void openAssetLibrary()}>{t('assetLibrary')}</button><button className="button secondary" onClick={() => void openTokenTrash()}>{t('tokenTrash')}</button><button className="button secondary" onClick={() => mapInput.current?.click()} disabled={!scene}>⇧ {t('uploadMap')}</button><input ref={mapInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={uploadBackground} /><button className="button primary" onClick={() => void addToken()} disabled={!scene}>＋ {t('addToken')}</button></>}</div></header>
      <div className="scene-workbench"><div className="scene-tabs">{scenes.map((item) => <div className={`scene-tab-wrap ${scene?.id === item.id ? 'selected' : ''}`} key={item.id} onContextMenu={(event) => { event.preventDefault(); if (canManage) setSceneMenu({ x: event.clientX, y: event.clientY, scene: item }); }}><button className="scene-tab" onClick={() => void openScene(item)}><span className="scene-thumbnail" style={item.backgroundAssetId ? { backgroundImage: `url(/api/assets/${item.backgroundAssetId})` } : undefined} /><span className="scene-tab-copy">{item.title}<small className={item.isActive ? 'scene-live' : 'scene-draft'}>{canManage ? t(item.isActive ? 'live' : 'draft') : t('scene')}</small></span></button>{canManage && <button className="scene-menu-trigger" aria-label={`Actions for ${item.title}`} onClick={(event) => setSceneMenu({ x: event.currentTarget.getBoundingClientRect().left, y: event.currentTarget.getBoundingClientRect().bottom, scene: item })}>•••</button>}</div>)}{!scenes.length && <span className="muted">Create a scene to set up the table.</span>}</div>{canManage && scene && <div className="scene-actions"><button className="quiet-button" onClick={() => { setSceneTitle(scene.title); setSceneDialog('rename'); }}>{t('renameScene')}</button><button className="quiet-button" onClick={() => void duplicateScene(scene)}>{t('duplicateScene')}</button><button className="quiet-button" onClick={() => setSceneDialog('grid')}>{t('gridSettings')}</button><button className="quiet-button" disabled={scene.isActive} onClick={() => activateScene(scene)}>{scene.isActive ? t('activeForPlayers') : t('setActive')}</button><button className="quiet-button" onClick={() => void reorderScene(scene, -1)}>←</button><button className="quiet-button" onClick={() => void reorderScene(scene, 1)}>→</button><button className="quiet-button" onClick={() => void archiveScene(scene)}>{t('archive')}</button><button className="quiet-button" onClick={() => void loadArchivedScenes()}>{showArchivedScenes ? t('hideArchived') : t('archived')}</button></div>}{canManage && showArchivedScenes && archivedScenes.length > 0 && <div className="archived-scenes">{archivedScenes.map((item) => <span key={item.id}>{item.title}<button className="quiet-button" onClick={() => void restoreScene(item)}>{t('restore')}</button></span>)}</div>}</div>
      {canManage && scene && <details className="layer-tools"><summary>{t('layers')} · {objects.length} {t('sceneObjects')}</summary><div className="layer-tools-body"><div className="layer-list">{layers.map((layer) => <div className={`layer-row ${activeLayerId === layer.id ? 'selected' : ''}`} key={layer.id}><button className="layer-select" onClick={() => setActiveLayerId(layer.id)}>{layer.name}<small>{layer.kind}</small></button><label><input type="checkbox" checked={layer.visibleToPlayers} disabled={layer.kind === 'GM'} onChange={(event) => void updateSceneLayer(layer, { visibleToPlayers: event.target.checked })} />{t('visibleForPlayers')}</label><button className="quiet-button" title={t('raiseLayer')} onClick={() => void updateSceneLayer(layer, { sortOrder: layer.sortOrder + 1 })}>↑</button><button className="quiet-button" title={t('lowerLayer')} onClick={() => void updateSceneLayer(layer, { sortOrder: layer.sortOrder - 1 })}>↓</button><button className="quiet-button" onClick={() => void updateSceneLayer(layer, { locked: !layer.locked })}>{t(layer.locked ? 'unlock' : 'lock')}</button>{layer.kind === 'CUSTOM' && <button className="quiet-button" onClick={() => void deleteCustomLayer(layer)}>×</button>}</div>)}<button className="quiet-button add-layer" onClick={() => void addCustomLayer()}>＋ {t('addCustomLayer')}</button></div><div className="layer-object-tools"><div className="draw-style-controls"><label>{t('drawingColor')} <input type="color" value={drawingColor} onChange={(event) => setDrawingColor(event.target.value)} /></label><label>{t('drawingWidth')} <input type="range" min="1" max="16" step="1" value={drawingWidth} onChange={(event) => setDrawingWidth(Number(event.target.value))} /></label></div><div className="object-tool-actions"><button className="button secondary" disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => void addSceneObject('RECTANGLE')}>{t('addRectangle')}</button><button className="button secondary" disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => void addSceneObject('ELLIPSE')}>{t('addEllipse')}</button><button className="button secondary" disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => void addSceneObject('LINE')}>{t('addLine')}</button><button className={drawMode ? 'button primary' : 'button secondary'} aria-pressed={drawMode} disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => setDrawMode((enabled) => !enabled)}>{t(drawMode ? 'finishDrawing' : 'drawFreehand')}</button></div><div className="scene-object-list">{objects.filter((object) => object.layerId === activeLayerId).map((object) => <div className="scene-object-row" key={object.id}><span>{t(object.kind.toLowerCase())}</span><button className="quiet-button" title={t(object.visible ? 'hideObject' : 'showObject')} onClick={() => void updateSceneObject(object, { visible: !object.visible })}>{object.visible ? '◉' : '◎'}</button><button className="quiet-button" title={t('rotateObject')} onClick={() => void updateSceneObject(object, { rotation: (object.rotation + 15) % 360 })}>↻</button><input aria-label={t('objectColor')} type="color" value={object.color ?? '#c8794a'} onChange={(event) => void updateSceneObject(object, { color: event.target.value })} /><input aria-label={t('objectOpacity')} type="range" min="0" max="1" step="0.05" value={object.opacity} onChange={(event) => void updateSceneObject(object, { opacity: Number(event.target.value) })} /><button className="quiet-button" title={t('raiseObject')} onClick={() => void updateSceneObject(object, { zIndex: object.zIndex + 1 })}>↑</button><button className="quiet-button" title={t('lowerObject')} onClick={() => void updateSceneObject(object, { zIndex: object.zIndex - 1 })}>↓</button><select aria-label={t('moveToLayer')} value={object.layerId} onChange={(event) => void updateSceneObject(object, { layerId: event.target.value })}>{layers.map((layer) => <option key={layer.id} value={layer.id} disabled={layer.locked}>{layer.name}</option>)}</select><button className="quiet-button" title={t('duplicateObject')} onClick={() => void duplicateSceneObject(object)}>⧉</button><button className="quiet-button" onClick={() => void updateSceneObject(object, { locked: !object.locked })}>{t(object.locked ? 'unlock' : 'lock')}</button><button className="quiet-button" onClick={() => void deleteSceneObject(object)}>{t('deleteObject')}</button></div>)}{objects.every((object) => object.layerId !== activeLayerId) && <span className="muted">{t('noObjects')}</span>}</div></div></div></details>}
      <div className="table-content">
        <section className="table-main">
          {scene ? (
            <Suspense fallback={<div className="canvas-loading">Loading tabletop…</div>}>
              <TableCanvas tokens={tokens} objects={objects} canManage={canManage} selectedTokenIds={selectedTokenIds} onMoveGroup={moveTokenGroup} activeLayerId={activeLayerId} layerSortOrder={Object.fromEntries(layers.map((layer) => [layer.id, layer.sortOrder]))} canEditObject={(object) => object.layerId === activeLayerId && !object.locked && !layers.find((layer) => layer.id === object.layerId)?.locked} onEditObject={(id, patch) => { const object = objects.find((item) => item.id === id); if (object) void updateSceneObject(object, patch); }} gridSize={scene.gridSize} gridColor={scene.gridColor} gridOpacity={scene.gridOpacity} gridOffsetX={scene.gridOffsetX} gridOffsetY={scene.gridOffsetY} gridEnabled={scene.gridEnabled} snapToGrid={scene.snapToGrid} backgroundUrl={scene.backgroundAssetId ? '/api/assets/' + scene.backgroundAssetId : undefined} sceneId={scene.id} sceneWidth={scene.width} sceneHeight={scene.height} cameraX={scene.cameraX} cameraY={scene.cameraY} cameraZoom={scene.cameraZoom} onMove={moveToken} fitLabel={t('fitScene')} calibrationActive={calibrationActive} gridPreviewSize={gridPreviewSize} gridPreviewOffsetX={gridPreviewOffsetX} gridPreviewOffsetY={gridPreviewOffsetY} onCalibrationComplete={finishGridCalibration} drawMode={canManage && drawMode && !layers.find((layer) => layer.id === activeLayerId)?.locked && layers.find((layer) => layer.id === activeLayerId)?.kind !== 'BACKGROUND'} onCreateDrawing={(points) => void addFreehandDrawing(points)} canEdit={(token) => canManage || token.ownerUserId === user.id} />
            </Suspense>
          ) : (
            <div className="empty-table"><div className="brand-mark">✳</div><h2>{t('guide')}</h2><p>{t('guideText')}</p>{canManage && <button className="button primary" onClick={() => setSceneDialog('create')}>{t('addScene')}</button>}</div>
          )}
          <div className="canvas-toolbar"><span>{scene?.title ?? t('mapLabel')}</span><span className="zoom-hint">{calibrationActive ? t('calibrationPrompt') : t('canvasHelp')}</span>{calibrationActive && <button className="quiet-button calibration-cancel" onClick={() => setCalibrationActive(false)}>{t('cancel')}</button>}</div>
        </section><aside className="right-rail"><div className="rail-header"><span className="online-dot" /> {t('players')} <span className="role-badge">{role}</span></div><section className="rail-section"><div className="section-title"><span>✦</span> {t('guide')}</div><p className="guide-copy">{t('guideText')}</p></section>{canManage && <section className="rail-section token-owners"><div className="section-title">♙ {t('tokenProperties')}</div><div className="token-group-tools"><span>{t('selectedTokens', { count: selectedTokenIds.length })}</span><button className="quiet-button" onClick={() => setSelectedTokenIds(tokens.slice(0, 50).map((token) => token.id))}>{t('selectAllTokens')}</button><button className="quiet-button" onClick={() => setSelectedTokenIds([])}>{t('clearTokenSelection')}</button><button className="quiet-button" disabled={selectedTokenIds.length < 2} onClick={() => void updateTokenGroup({ locked: true })}>{t('groupLock')}</button><button className="quiet-button" disabled={selectedTokenIds.length < 2} onClick={() => void updateTokenGroup({ locked: false })}>{t('groupUnlock')}</button><button className="quiet-button" disabled={selectedTokenIds.length < 2} onClick={() => void updateTokenGroup({ hidden: true })}>{t('groupHide')}</button><button className="quiet-button" disabled={selectedTokenIds.length < 2} onClick={() => void updateTokenGroup({ hidden: false })}>{t('groupShow')}</button></div>{tokens.map((token) => <details className="token-property-card" key={`${token.id}-${token.version}`}><summary><input type="checkbox" checked={selectedTokenIds.includes(token.id)} aria-label={t('selectToken', { name: token.name })} onClick={(event) => event.stopPropagation()} onChange={(event) => setSelectedTokenIds((ids) => event.target.checked ? ids.length >= 50 ? ids : [...ids, token.id] : ids.filter((id) => id !== token.id))} /><span>{token.name}</span></summary><label>{t('tokenName')}<input defaultValue={token.name} maxLength={48} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== token.name) void updateToken(token, { name: event.target.value }); }} /></label><label>{t('tokenColor')}<input type="color" defaultValue={token.color} onBlur={(event) => { if (event.target.value !== token.color) void updateToken(token, { color: event.target.value }); }} /></label><label>{t('tokenImage')}<select value={token.imageAssetId ?? ''} onChange={(event) => void updateToken(token, { imageAssetId: event.target.value || null })}><option value="">{t('noTokenImage')}</option>{assets.filter((asset) => asset.category === 'TOKEN').map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label>{t('tokenBorder')}<input type="color" defaultValue={token.borderColor} onBlur={(event) => { if (event.target.value !== token.borderColor) void updateToken(token, { borderColor: event.target.value }); }} /></label><div className="token-size-fields"><label>{t('tokenWidth')}<input type="number" min="0.25" max="100" step="0.25" defaultValue={token.width} onBlur={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value !== token.width) void updateToken(token, { width: value }); }} /></label><label>{t('tokenHeight')}<input type="number" min="0.25" max="100" step="0.25" defaultValue={token.height} onBlur={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value !== token.height) void updateToken(token, { height: value }); }} /></label></div><label>{t('tokenRotation')}<input type="number" min="-360000" max="360000" step="15" defaultValue={token.rotation} onBlur={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value !== token.rotation) void updateToken(token, { rotation: value }); }} /></label><label>{t('tokenOpacity')}<input type="range" min="0" max="1" step="0.05" defaultValue={token.opacity} onBlur={(event) => { const value = Number(event.target.value); if (value !== token.opacity) void updateToken(token, { opacity: value }); }} /></label><label>{t('tokenOrder')}<input type="number" min="-100000" max="100000" defaultValue={token.zIndex} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value !== token.zIndex) void updateToken(token, { zIndex: value }); }} /></label><label><input type="checkbox" checked={token.showName} onChange={(event) => void updateToken(token, { showName: event.target.checked })} />{t('showTokenName')}</label><label><input type="checkbox" checked={token.locked} onChange={(event) => void updateToken(token, { locked: event.target.checked })} />{t(token.locked ? 'unlock' : 'lock')}</label><label><input type="checkbox" checked={Boolean(token.hidden)} onChange={(event) => void updateToken(token, { hidden: event.target.checked })} />{t('hideToken')}</label><label>{t('tokenOwner')}<select aria-label={`${t('tokenOwner')} ${token.name}`} value={token.ownerUserId ?? ''} onChange={(event) => void assignToken(token, event.target.value)}><option value="">GM controlled</option>{members.filter((member) => member.role === 'PLAYER').map((member) => <option value={member.userId} key={member.userId}>{member.displayName}</option>)}</select></label><button className="quiet-button token-delete-button" onClick={() => requestDeleteToken(token)}>{t('deleteToken')}</button><label>{t('gmNote')}<textarea maxLength={4000} defaultValue={token.gmNote ?? ''} onBlur={(event) => { if (event.target.value !== token.gmNote) void updateToken(token, { gmNote: event.target.value }); }} /></label><label>{t('ownerNote')}<textarea maxLength={4000} defaultValue={token.ownerNote ?? ''} onBlur={(event) => { if (event.target.value !== token.ownerNote) void updateToken(token, { ownerNote: event.target.value }); }} /></label>{token.resources.map((resource, index) => <fieldset className="token-resource-editor" key={index}><legend>{t('resource')} {index + 1}</legend><label>{t('resourceName')}<input defaultValue={resource?.label ?? `${t('resource')} ${index + 1}`} maxLength={24} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== resource?.label) void updateTokenResource(token, index as 0 | 1, { label: event.target.value }); }} /></label><div className="token-size-fields"><label>{t('currentValue')}<input type="number" min="0" max="9999" step="1" defaultValue={resource?.current ?? 0} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value !== resource?.current) void updateTokenResource(token, index as 0 | 1, { current: value }); }} /></label><label>{t('maximumValue')}<input type="number" min="0" max="9999" step="1" defaultValue={resource?.maximum ?? 0} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value !== resource?.maximum) void updateTokenResource(token, index as 0 | 1, { maximum: value }); }} /></label></div><label><input type="checkbox" checked={Boolean(resource?.visible)} onChange={(event) => void updateTokenResource(token, index as 0 | 1, { visible: event.target.checked })} />{t('visibleForPlayers')}</label><div className="token-resource-quick"><button className="quiet-button" disabled={!resource || resource.current <= 0} onClick={() => void adjustTokenResource(token, index as 0 | 1, -1)}>−</button><span>{resource?.current ?? 0} / {resource?.maximum ?? 0}</span><button className="quiet-button" disabled={!resource || resource.current >= resource.maximum} onClick={() => void adjustTokenResource(token, index as 0 | 1, 1)}>＋</button></div></fieldset>)}</details>)}</section>}{!canManage && tokens.some((token) => token.ownerUserId === user.id && token.ownerNote) && <section className="rail-section token-owner-notes"><div className="section-title">{t('tokenNotes')}</div>{tokens.filter((token) => token.ownerUserId === user.id && token.ownerNote).map((token) => <article key={token.id}><strong>{token.name}</strong><p>{token.ownerNote}</p></article>)}</section>}{tokens.some((token) => canManage || token.ownerUserId === user.id) && <section className="rail-section token-resource-controls"><div className="section-title">{t('resourceTracks')}</div>{tokens.filter((token) => canManage || token.ownerUserId === user.id).map((token) => <div className="owned-token-resources" key={token.id}><strong>{token.name}</strong>{token.resources.map((resource, index) => resource && <div className="token-resource-quick" key={index}><span>{resource.label}</span><button className="quiet-button" disabled={resource.current <= 0} onClick={() => void adjustTokenResource(token, index as 0 | 1, -1)}>−</button><span>{resource.current} / {resource.maximum}</span><button className="quiet-button" disabled={resource.current >= resource.maximum} onClick={() => void adjustTokenResource(token, index as 0 | 1, 1)}>＋</button></div>)}</div>)}</section>}{scene && <section className="rail-section initiative-section"><div className="section-title">⚑ Initiative</div>{initiative.tracker?.active ? <><p className="guide-copy">Round {initiative.tracker.round}</p><div className="initiative-list">{initiative.entries.map((entry) => <div className={initiative.tracker?.currentEntryId === entry.id ? "initiative-row active" : "initiative-row"} key={entry.id}><span>{entry.label}</span><strong>{entry.score}</strong></div>)}</div>{canManage && <div className="initiative-actions"><button className="button secondary" onClick={() => void advanceInitiative()}>Next turn ↗</button><button className="quiet-button" onClick={() => void stopInitiative()}>Stop</button></div>}</> : canManage ? <><p className="guide-copy">Set each token's initiative score, then start the tracker.</p>{tokens.map((token) => <label className="initiative-score" key={token.id}>{token.name}<input type="number" min="-9999" max="9999" value={initiativeScores[token.id] ?? "0"} onChange={(event) => setInitiativeScores((scores) => ({ ...scores, [token.id]: event.target.value }))} /></label>)}<button className="button secondary" disabled={!tokens.length} onClick={() => void startInitiative()}>Start initiative</button></> : <p className="guide-copy">Initiative is not active.</p>}</section>}<section className="rail-section roll-section"><div className="section-title">◉ Dice</div><button className="roll-button" onClick={rollDice}>d20 <span>{t('roll')} ↗</span></button>{rolls.slice(-4).reverse().map((roll, i) => <div className="roll-row" key={`${roll.id ?? i}-${i}`}><span>{roll.displayName} rolled {roll.expression}</span><strong>{roll.result}</strong></div>)}</section><section className="rail-section chat-section"><div className="section-title">◌ {t('chat')}</div><select className="message-recipient" aria-label="Message recipient" value={messageRecipient} onChange={(event) => setMessageRecipient(event.target.value)}><option value="">Everyone</option>{members.filter((member) => member.userId !== user.id && (canManage || member.role === 'OWNER' || member.role === 'GM')).map((member) => <option key={member.userId} value={member.userId}>Private · {member.displayName}</option>)}</select><div className="chat-messages">{messages.map((message) => <div className={`chat-message ${message.private ? 'private' : ''}`} key={message.id}><strong>{message.private ? '🔒 ' : ''}{message.displayName}</strong><p>{message.body}</p></div>)}</div><form className="chat-compose" onSubmit={sendChat}><input value={chatText} onChange={(e) => setChatText(e.target.value)} maxLength={2000} placeholder="Write a message…" /><button aria-label={t('send')}>↗</button></form></section></aside></div>
      {error && <button className="toast-error" onClick={() => setError('')}>{error} ×</button>}
      {notice && <button className="toast-notice" onClick={() => setNotice('')}>{notice} ×</button>}
      {tokenTrashOpen && <div className="modal-backdrop" onClick={() => setTokenTrashOpen(false)}><section className="dialog-card" onClick={(event) => event.stopPropagation()}><header><div><p className="eyebrow">{t('tokenTrash')}</p><h2>{campaign.campaign.title}</h2></div><button className="quiet-button" onClick={() => setTokenTrashOpen(false)}>×</button></header><div className="token-trash-list">{deletedTokens.map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.sceneTitle}</small></div><button className="button secondary" disabled={Boolean(item.sceneArchivedAt)} onClick={() => void restoreToken(item)}>{t('restoreToken')}</button></article>)}{deletedTokens.length === 0 && <p className="empty-state">{t('tokenTrashEmpty')}</p>}</div></section></div>}
      {assetLibraryOpen && <div className="modal-backdrop" onClick={() => setAssetLibraryOpen(false)}><section className="dialog-card asset-library-dialog" onClick={(event) => event.stopPropagation()}><header><div><p className="eyebrow">{t('assetLibrary')}</p><h2>{campaign.campaign.title}</h2></div><button className="quiet-button" onClick={() => setAssetLibraryOpen(false)}>×</button></header><div className="asset-library-tools"><p className="asset-storage-summary">{t('assetStorage')}: {(assetStorageBytes / 1024 / 1024).toFixed(2)} MB · {assets.length}</p><input aria-label={t('assetSearch')} placeholder={t('assetSearch')} value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} /><select aria-label={t('assetCategory')} value={assetCategoryFilter} onChange={(event) => setAssetCategoryFilter(event.target.value)}><option value="ALL">{t('allCategories')}</option><option value="MAP">{t('assetMap')}</option><option value="TOKEN">{t('assetToken')}</option><option value="DECORATION">{t('assetDecoration')}</option><option value="PORTRAIT">{t('assetPortrait')}</option><option value="OTHER">{t('assetOther')}</option></select><select aria-label={t('assetSort')} value={assetSort} onChange={(event) => setAssetSort(event.target.value as 'NAME' | 'SIZE')}><option value="NAME">{t('sortByName')}</option><option value="SIZE">{t('sortBySize')}</option></select><select aria-label={t('uploadCategory')} value={assetUploadCategory} onChange={(event) => setAssetUploadCategory(event.target.value as CampaignAsset['category'])}><option value="MAP">{t('assetMap')}</option><option value="TOKEN">{t('assetToken')}</option><option value="DECORATION">{t('assetDecoration')}</option><option value="PORTRAIT">{t('assetPortrait')}</option><option value="OTHER">{t('assetOther')}</option></select><input ref={assetInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={uploadAssets} /><button className="button primary" onClick={() => assetInput.current?.click()}>{t('uploadAssets')}</button></div><div className="asset-library-grid">{visibleAssets.map((asset) => <article className="asset-card" key={asset.id}><img src={`/api/assets/${asset.id}`} alt={asset.name} loading="lazy" /><label>{t('assetName')}<input defaultValue={asset.name} maxLength={120} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== asset.name) void updateAsset(asset, { name: event.target.value }); }} /></label><label>{t('assetCategory')}<select value={asset.category} onChange={(event) => void updateAsset(asset, { category: event.target.value as CampaignAsset['category'] })}><option value="MAP">{t('assetMap')}</option><option value="TOKEN">{t('assetToken')}</option><option value="DECORATION">{t('assetDecoration')}</option><option value="PORTRAIT">{t('assetPortrait')}</option><option value="OTHER">{t('assetOther')}</option></select></label><small>{(asset.size / 1024 / 1024).toFixed(2)} MB · {t('assetUsage', { count: asset.usageCount })}</small>{asset.usageCount === 0 && <button className="quiet-button" onClick={() => void deleteAsset(asset)}>{t('deleteUnusedAsset')}</button>}</article>)}</div>{visibleAssets.length === 0 && <p className="empty-state">{t('noAssets')}</p>}</section></div>}
      {sceneDialog === 'create' && <div className="modal-backdrop"><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void addScene(); }}><p className="eyebrow">{t('newLocation')}</p><h2>{t('addScene')}</h2><label>{t('sceneName')}<input autoFocus value={sceneTitle} onChange={(event) => setSceneTitle(event.target.value)} maxLength={80} required /></label><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => { setSceneTitle(''); setSceneDialog(null); }}>{t('cancel')}</button><button className="button primary">{t('create')}</button></div></form></div>}
      {sceneDialog === 'rename' && <div className="modal-backdrop"><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void renameScene(); }}><p className="eyebrow">SCENE</p><h2>{t('renameScene')} {t('scene').toLowerCase()}</h2><label>{t('sceneName')}<input autoFocus value={sceneTitle} onChange={(event) => setSceneTitle(event.target.value)} maxLength={80} required /></label><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setSceneDialog(null)}>{t('cancel')}</button><button className="button primary">{t('save')}</button></div></form></div>}
      {sceneDialog === 'grid' && scene && <div className="modal-backdrop"><form className="dialog-card settings-dialog" onSubmit={(event) => void saveGridSettings(event)}><p className="eyebrow">{t('sceneSettings')}</p><h2>{t('gridSettings')}</h2><div className="settings-grid"><label>{t('cellSize')}<input name="gridSize" type="number" min="8" max="256" defaultValue={scene.gridSize} required /></label><label>{t('gridColor')}<input name="gridColor" type="color" defaultValue={scene.gridColor} /></label><label>{t('opacity')}<input name="gridOpacity" type="number" min="0" max="1" step="0.05" defaultValue={scene.gridOpacity} required /></label><label>{t('offsetX')}<input name="gridOffsetX" type="number" step="0.5" defaultValue={scene.gridOffsetX} required /></label><label>{t('offsetY')}<input name="gridOffsetY" type="number" step="0.5" defaultValue={scene.gridOffsetY} required /></label><label>{t('sceneWidth')}<input name="width" type="number" min="256" max="16384" step="128" defaultValue={scene.width} required /></label><label>{t('sceneHeight')}<input name="height" type="number" min="256" max="16384" step="128" defaultValue={scene.height} required /></label><label>{t('distancePerCell')}<input name="unitsPerCell" type="number" min="0.01" max="100000" step="0.5" defaultValue={scene.unitsPerCell} required /></label><label>{t('unitLabel')}<input name="unitLabel" maxLength={24} defaultValue={scene.unitLabel} required /></label><label>{t('cameraCenterX')}<input name="cameraX" type="number" min="-32768" max="32768" step="1" defaultValue={scene.cameraX} required /></label><label>{t('cameraCenterY')}<input name="cameraY" type="number" min="-32768" max="32768" step="1" defaultValue={scene.cameraY} required /></label><label>{t('cameraZoom')}<input name="cameraZoom" type="number" min="0.25" max="4" step="0.05" defaultValue={scene.cameraZoom} required /></label><label className="check-setting"><input name="gridEnabled" type="checkbox" defaultChecked={scene.gridEnabled} /> {t('showGrid')}</label><label className="check-setting"><input name="snapToGrid" type="checkbox" defaultChecked={scene.snapToGrid} /> {t('snapGrid')}</label></div><button type="button" className="button secondary calibration-start" disabled={!scene.backgroundAssetId} onClick={startGridCalibration}>{t('calibrateGrid')}</button><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setSceneDialog(null)}>{t('cancel')}</button><button className="button primary">{t('saveSettings')}</button></div></form></div>}
      {calibrationDialog && calibrationDistance !== null && <div className="modal-backdrop"><div className="dialog-card calibration-dialog"><p className="eyebrow">{t('sceneSettings')}</p><h2>{t('calibrateGrid')}</h2><p>{t('calibrationMeasure')}</p><label>{t('calibrationDistance')}<output>{Math.round(calibrationDistance)} px</output></label><label>{t('calibrationCells')}<input type="number" min="1" max="100" step="1" value={calibrationCellCount} onChange={(event) => setCalibrationCellCount(event.target.value)} /></label><p className="calibration-preview">{gridPreviewSize === null ? t('calibrationOutOfRange') : `${t('previewCellSize')}: ${gridPreviewSize}px`}</p><div className="settings-grid calibration-offsets"><label>{t('offsetX')}<input type="number" step="0.5" value={gridPreviewOffsetX ?? 0} onChange={(event) => setGridPreviewOffsetX(Number(event.target.value))} /></label><label>{t('offsetY')}<input type="number" step="0.5" value={gridPreviewOffsetY ?? 0} onChange={(event) => setGridPreviewOffsetY(Number(event.target.value))} /></label></div><div className="dialog-actions"><button className="button secondary" onClick={() => { setCalibrationDialog(false); setCalibrationDistance(null); setGridPreviewSize(null); setGridPreviewOffsetX(null); setGridPreviewOffsetY(null); }}>{t('cancel')}</button><button className="button primary" disabled={gridPreviewSize === null} onClick={() => void saveCalibratedGrid()}>{t('saveSettings')}</button></div></div></div>}
      {confirmAction && <div className="modal-backdrop"><div className="dialog-card"><p className="eyebrow">{t('confirmChange')}</p><h2>{confirmText}</h2><div className="dialog-actions"><button className="button secondary" onClick={() => setConfirmAction(null)}>{t('cancel')}</button><button className="button primary" onClick={() => confirmAction()}>{t('confirm')}</button></div></div></div>}
      {sceneMenu && <div className="scene-context-backdrop" onClick={() => setSceneMenu(null)} onContextMenu={(event) => { event.preventDefault(); setSceneMenu(null); }}><div className="scene-context-menu" style={{ left: Math.min(sceneMenu.x, window.innerWidth - 190), top: Math.min(sceneMenu.y, window.innerHeight - 250) }} onClick={(event) => event.stopPropagation()}><button onClick={() => { setSceneTitle(sceneMenu.scene.title); setSceneDialog('rename'); setSceneMenu(null); }}>{t('renameScene')}</button><button onClick={() => { void duplicateScene(sceneMenu.scene); setSceneMenu(null); }}>{t('duplicateAsDraft')}</button><button onClick={() => { const target = sceneMenu.scene; setSceneMenu(null); if (scene?.id === target.id) setSceneDialog('grid'); else void openScene(target).then(() => setSceneDialog('grid')); }}>{t('gridSettings')}</button><button disabled={sceneMenu.scene.isActive} onClick={() => { activateScene(sceneMenu.scene); setSceneMenu(null); }}>{t('makeActive')}</button><button onClick={() => { void archiveScene(sceneMenu.scene); setSceneMenu(null); }}>{t('archive')}</button></div></div>}
    </section>}
  </main>;
}
