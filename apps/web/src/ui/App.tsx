Warning: truncated output (original token count: 25329)
Total output lines: 827

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { io, type Socket } from 'socket.io-client';
import { useTranslation } from 'react-i18next';
import type { PublicToken, TokenResource } from '@nri/contracts';
import { calculateCellSize } from './canvasMath';
import { api, clearRecoverableRequests } from '../services/api';
import { useTabletopSync } from '../features/tabletop/useTabletopSync';
import { pickChanged, useCommandHistory, versionsOf, type Versions } from '../features/tabletop/useCommandHistory';
import type { AssetFolder, Campaign, CampaignAsset, ChatItem, DeletedToken, InitiativeView, RollItem, Scene, User } from '../features/tabletop/models';
import type { PublicSceneObject as SceneObject, PublicSceneLayer as SceneLayer } from '@nri/contracts';

type GroupPatch = Partial<Pick<PublicToken, 'x' | 'y' | 'color' | 'hidden' | 'locked' | 'showName' | 'opacity' | 'zIndex'>>;
const TableCanvas = lazy(() => import('./TableCanvas').then(({ TableCanvas: component }) => ({ default: component })));


export function App() {
  const { t, i18n } = useTranslation();
  const [user, setUser] = useState<User | null>(null);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [selectedTokenIds, setSelectedTokenIds] = useState<string[]>([]);
  const [tokenClipboard, setTokenClipboard] = useState<PublicToken[]>([]);
  const [assets, setAssets] = useState<CampaignAsset[]>([]);
  const [assetFolders, setAssetFolders] = useState<AssetFolder[]>([]);
  const [deletedTokens, setDeletedTokens] = useState<DeletedToken[]>([]);
  const [assetStorageBytes, setAssetStorageBytes] = useState(0);
  const [assetLibraryOpen, setAssetLibraryOpen] = useState(false);
  const [assetDropActive, setAssetDropActive] = useState(false);
  const [tokenTrashOpen, setTokenTrashOpen] = useState(false);
  const [assetSearch, setAssetSearch] = useState('');
  const [assetCategoryFilter, setAssetCategoryFilter] = useState('ALL');
  const [assetFolderFilter, setAssetFolderFilter] = useState('ALL');
  const [newAssetFolderName, setNewAssetFolderName] = useState('');
  const [assetSort, setAssetSort] = useState<'NAME' | 'SIZE'>('NAME');
  const [assetUploadCategory, setAssetUploadCategory] = useState<CampaignAsset['category']>('OTHER');
  const [selectedObjectId, setSelectedObjectId] = useState('');
  const [selectedObjectIds, setSelectedObjectIds] = useState<string[]>([]);
  const [objectClipboard, setObjectClipboard] = useState<SceneObject[]>([]);
  const [drawMode, setDrawMode] = useState(false);
  const [rulerActive, setRulerActive] = useState(false);
  const [pointerActive, setPointerActive] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [drawingColor, setDrawingColor] = useState('#c8794a');
  const [drawingWidth, setDrawingWidth] = useState(3);
  const [hiddenRoll, setHiddenRoll] = useState(false);
  const [initiativeScores, setInitiativeScores] = useState<Record<string, string>>({});
  const [initiativePending, setInitiativePending] = useState(false);
  const initiativeRequest = useRef(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  useEffect(() => setHiddenRoll(false), [campaign?.campaign.id, campaign?.role]);

  const [busy, setBusy] = useState(false);
  const [rightRailWidth, setRightRailWidth] = useState(() => {
    const value = Number(window.localStorage.getItem('nri:table-rail-width'));
    return Number.isFinite(value) && value >= 220 && value <= 480 ? value : 280;
  });
  const [rightRailCollapsed, setRightRailCollapsed] = useState(() => window.localStorage.getItem('nri:table-rail-collapsed') === 'true');
  const [theme, setTheme] = useState<'dark' | 'light'>(() => window.localStorage.getItem('nri:theme') === 'light' ? 'light' : 'dark');
  const [fullscreen, setFullscreen] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [chatText, setChatText] = useState('');
  const [messageRecipient, setMessageRecipient] = useState('');
  const [pendingChat, setPendingChat] = useState<{ campaignId: string; clientMessageId: string; body: string; recipientId: string | null; state: 'sending' | 'unknown' } | null>(null);
  const [pendingRoll, setPendingRoll] = useState<{ campaignId: string; requestId: string; expression: string; hidden: boolean; state: 'sending' | 'unknown' } | null>(null);
  useEffect(() => { setPendingChat(null); setPendingRoll(null); setChatText(''); }, [user?.id, campaign?.campaign.id]);
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
  useEffect(() => { window.localStorage.setItem('nri:table-rail-width', String(rightRailWidth)); }, [rightRailWidth]);
  useEffect(() => { window.localStorage.setItem('nri:table-rail-collapsed', String(rightRailCollapsed)); }, [rightRailCollapsed]);
  useEffect(() => { window.localStorage.setItem('nri:theme', theme); }, [theme]);
  useEffect(() => {
    const updateFullscreen = () => setFullscreen(document.fullscreenElement !== null);
    document.addEventListener('fullscreenchange', updateFullscreen);
    return () => document.removeEventListener('fullscreenchange', updateFullscreen);
  }, []);
  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.querySelector('.app-shell')?.requestFullscreen();
    } catch (e) { setError((e as Error).message); }
  }
  const [sceneMenu, setSceneMenu] = useState<{ x: number; y: number; scene: Scene } | null>(null);
  const mapInput = useRef<HTMLInputElement>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const socket = useMemo<Socket>(() => io({ autoConnect: false, withCredentials: true, transports: ['websocket', 'polling'] }), []);
  const { scene, setScene, scenes, setScenes, openScene, reloadSceneContent, tokens, setTokens,
    layers, setLayers, objects, setObjects, activeLayerId, setActiveLayerId, members, messages, setMessages,
    rolls, setRolls, initiative, setInitiative, connected, campaignIdRef, isCurrentScope } = useTabletopSync({
    user, campaign, socket, setCampaign, setCampaigns, setError, setUser,
  });
  useEffect(() => { clearRecoverableRequests(); }, [user?.id, campaign?.campaign.id, scene?.id]);
  useEffect(() => {
    setSelectedTokenIds([]); setSelectedObjectId(''); setSelectedObjectIds([]); setObjectClipboard([]); setPointerActive(false);
  }, [scene?.id, campaign?.role]);
  useEffect(() => {
    setTokenClipboard([]); setAssets([]); setAssetFolders([]); setDeletedTokens([]); setArchivedScenes([]); setAssetLibraryOpen(false); setTokenTrashOpen(false); setShowArchivedScenes(false);
  }, [campaign?.campaign.id, campaign?.role]);
  const role = campaign?.role ?? 'PLAYER';
  const canManage = role === 'OWNER' || role === 'GM';
  const commandHistory = useCommandHistory([user?.id, campaign?.campaign.id, role, scene?.id].join(':'), (reason) => {
    setError(t('historyFailed', { reason: reason === 'CONFLICT' ? t('historyConflict') : reason }));
  });
  const canDraw = canManage || (campaign?.campaign.playersCanDraw === true && scene?.isActive === true);
  useEffect(() => { if (!canDraw) setDrawMode(false); }, [canDraw]);
  const drawingLayer = layers.find((layer) => layer.id === activeLayerId);
  const layerSortOrder = useMemo(() => Object.fromEntries(layers.map((layer) => [layer.id, layer.sortOrder])), [layers]);
  const canEditObject = useCallback((object: SceneObject) => object.layerId === activeLayerId && !object.locked && !drawingLayer?.locked && (canManage || (canDraw && object.ownedByMe === true)), [activeLayerId, drawingLayer?.locked, canManage, canDraw]);
  const visibleAssets = useMemo(() => assets.filter((asset) => (assetCategoryFilter === 'ALL' || asset.category === assetCategoryFilter) && (assetFolderFilter === 'ALL' || (assetFolderFilter === 'ROOT' ? asset.folderId === null : asset.folderId === assetFolderFilter)) && asset.name.toLocaleLowerCase().includes(assetSearch.trim().toLocaleLowerCase())).sort((a, b) => assetSort === 'SIZE' ? b.size - a.size : a.name.localeCompare(b.name)), [assets, assetCategoryFilter, assetFolderFilter, assetSearch, assetSort]);

  useEffect(() => {
    if (calibrationDistance === null) { setGridPreviewSize(null); return; }
    setGridPreviewSize(calculateCellSize(calibrationDistance, Number(calibrationCellCount)));
  }, [calibrationDistance, calibrationCellCount]);

  useEffect(() => {
    const toggleRuler = () => { setRulerActive((active) => !active); setSelectionMode(false); setDrawMode(false); setPointerActive(false); };
    window.addEventListener('nri-toggle-ruler', toggleRuler);
    return () => window.removeEventListener('nri-toggle-ruler', toggleRuler);
  }, []);

  useEffect(() => {
    const toggleSelection = () => { setSelectionMode((active) => !active); setRulerActive(false); setDrawMode(false); setPointerActive(false); };
    window.addEventListener('nri-toggle-selection', toggleSelection);
    return () => window.removeEventListener('nri-toggle-selection', toggleSelection);
  }, []);

  useEffect(() => {
    const togglePointer = () => { setPointerActive((active) => !active); setRulerActive(false); setSelectionMode(false); setDrawMode(false); };
    window.addEventListener('nri-toggle-pointer', togglePointer);
    return () => window.removeEventListener('nri-toggle-pointer', togglePointer);
  }, []);

  useEffect(() => {
    const onTableKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      const isFormTarget = target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (isFormTarget || event.altKey || event.isComposing) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && scene) {
        const available = event.shiftKey ? commandHistory.canRedo : commandHistory.canUndo;
        if (available) {
          event.preventDefault();
          if (!event.repeat) void commandHistory.apply(event.shiftKey ? 'redo' : 'undo');
        }
        return;
      }
      if ((event.ctrlKey || event.metaKey) && scene && (role === 'OWNER' || role === 'GM')) {
        const key = event.key.toLowerCase();
        if (key === 'c') {
          const selected = tokens.filter((token) => selectedTokenIds.includes(token.id));
          if (selected.length > 0) { event.preventDefault(); setTokenClipboard(selected); setObjectClipboard([]); return; }
        }
        if (key === 'c' && selectedObjectIds.length > 0) {
          const selected = objects.filter((object) => selectedObjectIds.includes(object.id));
          if (selected.length > 0) { event.preventDefault(); setObjectClipboard(selected); return; }
        }
        if (key === 'v' && tokenClipboard.length > 0) { event.preventDefault(); void pasteToken(); return; }
        if (key === 'v' && objectClipboard.length > 0) { event.preventDefault(); void pasteSceneObject(); return; }
      }
      if (event.ctrlKey || event.metaKey) return;
      if (event.key.toLowerCase() === 'r') { event.preventDefault(); setRulerActive(true); setSelectionMode(false); setDrawMode(false); setPointerActive(false); }
      else if (event.key.toLowerCase() === 's' && (role === 'OWNER' || role === 'GM')) { event.preventDefault(); setSelectionMode(true); setRulerActive(false); setDrawMode(false); setPointerActive(false); }
      else if (event.key.toLowerCase() === 'p') { event.preventDefault(); setPointerActive(true); setRulerActive(false); setSelectionMode(false); setDrawMode(false); }
      else if (event.key.toLowerCase() === 'f') { event.preventDefault(); window.dispatchEvent(new Event('nri-fit-scene')); }
      else if (event.key === 'Escape') { setRulerActive(false); setSelectionMode(false); setDrawMode(false); setPointerActive(false); }
    };
    window.addEventListener('keydown', onTableKeyDown);
    return () => window.removeEventListener('keydown', onTableKeyDown);
  }, [role, selectedObjectIds, objects, objectClipboard, scene, activeLayerId, layers, selectedTokenIds, tokens, tokenClipboard, commandHistory]);

  useEffect(() => { void api<{ user: User }>('/api/auth/me').then((result) => setUser(result.user)).catch(() => {}); return () => { socket.disconnect(); }; }, [socket]);
  useEffect(() => {
    if (!user) return;
    const invite = new URLSearchParams(location.search).get('invite');
    if (invite) {
      void api<{ campaignId: string }>(`/api/invitations/${encodeURIComponent(invite)}/accept`, { method: 'POST' }).then(async ({ campaignId }) => {
        history.replaceState(null, '', location.pathname);
        const list = await api<Campaign[]>('/api/campaigns'); setCampaigns(list);
        const joined = list.find((entry) => entry.campaign.id === campaignId); if (joined) { clearRecoverableRequests(); setCampaign(joined); }
      }).catch((e) => { history.replaceState(null, '', location.pathname); setError((e as Error).message); });
    } else void api<Campaign[]>('/api/campaigns').then(setCampaigns).catch((e) => setError(e.message));
  }, [user]);
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
    try { const created = await api<{ campaign: Campaign['campaign'] }>('/api/campaigns', { method: 'POST', body: JSON.stringify({ title: data.get('title'), description: data.get('description') }), recoverable: true }); const entry = { campaign: created.campaign, role: 'OWNER' }; setCampaigns((items) => [...items, entry]); setCampaign(entry); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function duplicateCampaign(entry: Campaign) {
    setBusy(true); setError('');
    try {
      const copied = await api<{ campaign: Campaign['campaign'] }>(`/api/campaigns/${entry.campaign.id}/duplicate`, { method: 'POST', recoverable: true });
      const next = { campaign: copied.campaign, role: 'OWNER' };
      setCampaigns((items) => [...items, next]); setCampaign(next);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function addScene() {
    if (!campaign || !sceneTitle.trim()) return;
    try { const data = await api<{ scene: Scene }>('/api/scenes', { method: 'POST', body: JSON.stringify({ campaignId: campaign.campaign.id, title: sceneTitle.trim() }), recoverable: true }); setScenes((items) => [...items, data.scene].sort((a, b) => a.sortOrder - b.sortOrder)); setSceneTitle(''); setSceneDialog(null); await openScene(data.scene); }
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
    try { const { scene: duplicate } = await api<{ scene: Scene }>(`/api/scenes/${target.id}/duplicate`, { method: 'POST', recoverable: true }); setScenes((items) => [...items, duplicate].sort((a, b) => a.sortOrder - b.sortOrder)); setNotice(t('duplicateDraft')); }
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
  async function addSceneObject(kind: 'RECTANGLE' | 'ELLIPSE' | 'LINE' | 'IMAGE' | 'TEXT', assetId: string | null = null, text?: string) {
    if (!scene || !activeLayerId) return;
    try {
      const width = scene.gridSize * 2; const height = scene.gridSize * 2;
      const points = kind === 'LINE' ? [{ x: 0, y: height / 2 }, { x: width, y: height / 2 }] : undefined;
      const { object } = await api<{ object: SceneObject }>(`/api/scenes/${scene.id}/objects`, { method: 'POST', body: JSON.stringify({ layerId: activeLayerId, kind, assetId, text, x: Math.round(scene.width / 2 - scene.gridSize), y: Math.round(scene.height / 2 - scene.gridSize), width, height, color: drawingColor, strokeWidth: drawingWidth, points }), recoverable: true });
      applyObjectUpdates([object]);
      recordObjectCreation([object]);
      if (assetId) setAssets((items) => items.map((asset) => asset.id === assetId ? { ...asset, usageCount: asset.usageCount + 1 } : asset));
    } catch (e) { setError((e as Error).message); }
  }
  function addTextObject() {
    const draft = window.prompt(t('textPrompt'));
    if (!draft?.trim()) return;
    const text = draft.trim();
    if (text.length > 500) { setError(t('textTooLong')); return; }
    void addSceneObject('TEXT', null, text);
  }
  function editTextObject(object: SceneObject) {
    const draft = window.prompt(t('textPrompt'), object.text ?? '');
    if (draft === null || !draft.trim()) return;
    const text = draft.trim();
    if (text.length > 500) { setError(t('textTooLong')); return; }
    void updateSceneObject(object, { text });
  }
  async function addFreehandDrawing(points: Array<{ x: number; y: number }>) {
    if (!scene || !activeLayerId || points.length < 2) return;
    const xs = points.map((point) => point.x); const ys = points.map((point) => point.y);
    const x = Math.min(...xs); const y = Math.min(...ys); const width = Math.max(8, Math.max(...xs) - x); const height = Math.max(8, Math.max(...ys) - y);
    try {
      const { object } = await api<{ object: SceneObject }>(`/api/scenes/${scene.id}/objects`, { method: 'POST', body: JSON.stringify({ layerId: activeLayerId, kind: 'FREEHAND', x, y, width, height, color: drawingColor, strokeWidth: drawingWidth, points: points.map((point) => ({ x: point.x - x, y: point.y - y })) }), recoverable: true });
      applyObjectUpdates([object]);
      if (canManage) recordObjectCreation([object]);
    } catch (e) { setError((e as Error).message); }
  }
  async function setPlayerDrawingPermission(enabled: boolean) {
    if (!campaign || !canManage) return;
    const campaignId = campaign.campaign.id;
    const update = (item: Campaign, playersCanDraw: boolean) => item.campaign.id === campaignId ? { ...item, campaign: { ...item.campaign, playersCanDraw } } : item;
    setCampaign((item) => item ? update(item, enabled) : item); setCampaigns((items) => items.map((item) => update(item, enabled)));
    try {
      const result = await api<{ playersCanDraw: boolean }>(`/api/campaigns/${campaignId}/player-drawing`, { method: 'PUT', body: JSON.stringify({ enabled }) });
      setCampaign((item) => item ? update(item, result.playersCanDraw) : item); setCampaigns((items) => items.map((item) => update(item, result.playersCanDraw)));
    } catch (e) { setCampaign((item) => item ? update(item, !enabled) : item); setCampaigns((items) => items.map((item) => update(item, !enabled))); setError((e as Error).message); }
  }
  function applyObjectUpdates(updated: SceneObject[]) {
    if (!commandHistory.isCurrent()) return;
    setObjects((items) => {
      const byId = new Map(items.map((item) => [item.id, item]));
      for (const object of updated) if ((byId.get(object.id)?.version ?? 0) <= object.version) byId.set(object.id, object);
      return [...byId.values()];
    });
  }

  function applyObjectLifecycle(sceneId: string, ids: string[], action: 'delete' | 'restore') {
    return async (versions: Versions) => {
      const result = await api<{ objects: SceneObject[] }>(`/api/scenes/${sceneId}/object-lifecycle`, {
        method: 'PATCH',
        body: JSON.stringify({ action, objects: ids.map((objectId) => ({ objectId, expectedVersion: versions[objectId] })) }),
      });
      if (commandHistory.isCurrent()) {
        if (action === 'restore') applyObjectUpdates(result.objects);
        else {
          setObjects((items) => items.filter((item) => !ids.includes(item.id)));
          setSelectedObjectId((id) => ids.includes(id) ? '' : id);
          setSelectedObjectIds((items) => items.filter((id) => !ids.includes(id)));
        }
      }
      return versionsOf(result.objects);
    };
  }

  function recordObjectCreation(created: SceneObject[]) {
    if (!created.length) return;
    const sceneId = created[0]!.sceneId;
    const ids = created.map(({ id }) => id);
    commandHistory.record({
      before: {}, after: versionsOf(created),
      undo: applyObjectLifecycle(sceneId, ids, 'delete'), redo: applyObjectLifecycle(sceneId, ids, 'restore'),
    });
  }

  async function updateSceneObject(object: SceneObject, patch: Partial<SceneObject>) {
    const apply = (changes: Partial<SceneObject>) => async (versions: Versions) => {
      const { object: updated } = await api<{ object: SceneObject }>(`/api/objects/${object.id}`, {
        method: 'PATCH', body: JSON.stringify({ ...changes, expectedVersion: versions[object.id] }),
      });
      applyObjectUpdates([updated]);
      return updated;
    };
    try {
      const before = versionsOf([object]);
      const updated = await apply(patch)(before);
      const changed = canManage && object.visible !== updated.visible ? { ...patch, visible: updated.visible } : patch;
      commandHistory.record({ before, after: versionsOf([updated]),
        undo: async (versions) => versionsOf([await apply(pickChanged(object, changed))(versions)]),
        redo: async (versions) => versionsOf([await apply(pickChanged(updated, changed))(versions)]),
      });
    } catch (e) { setError((e as Error).message); }
  }
  async function duplicateSceneObject(object: SceneObject) {
    if (!scene) return;
    try {
      const copy = await createSceneObjectCopy(object, object.layerId);
      setSelectedObjectId(copy.id);
    } catch (e) { setError((e as Error).message); }
  }
  async function createSceneObjectCopy(source: SceneObject, layerId: string) {
    if (!scene) throw new Error('SCENE_REQUIRED');
    const { objects: [copy] } = await api<{ objects: SceneObject[] }>(`/api/scenes/${scene.id}/objects/duplicate`, {
      method: 'POST',
      body: JSON.stringify({ layerId, objects: [{ objectId: source.id, expectedVersion: source.version,
        x: source.x + scene.gridSize / 2, y: source.y + scene.gridSize / 2 }] }),
      recoverable: true,
    });
    if (!copy) throw new Error('NOT_FOUND');
    applyObjectUpdates([copy]);
    recordObjectCreation([copy]);
    if (copy.assetId) setAssets((items) => items.map((asset) => asset.id === copy.assetId ? { ...asset, usageCount: asset.usageCount + 1 } : asset));
    return copy;
  }
  async function pasteSceneObject() {
    const targetLayer = layers.find((layer) => layer.id === activeLayerId);
    if (!canManage || objectClipboard.length === 0 || !targetLayer || targetLayer.locked || targetLayer.kind === 'BACKGROUND') return;
    try {
      if (objectClipboard.length === 1) {
        const copy = await createSceneObjectCopy(objectClipboard[0]!, targetLayer.id);
        setSelectedObjectId(copy.id); setSelectedObjectIds([copy.id]); setObjectClipboard([copy]);
        return;
      }
      if (!scene) return;
      const { objects: copies } = await api<{ objects: SceneObject[] }>(`/api/scenes/${scene.id}/objects/duplicate`, {
        method: 'POST',
        body: JSON.stringify({ layerId: targetLayer.id, objects: objectClipboard.map((object) => ({ objectId: object.id, expectedVersion: object.version, x: object.x + scene.gridSize / 2, y: object.y + scene.gridSize / 2 })) }), recoverable: true,
      });
      applyObjectUpdates(copies);
      recordObjectCreation(copies);
      setSelectedObjectId(copies.at(-1)?.id ?? ''); setSelectedObjectIds(copies.map((object) => object.id)); setObjectClipboard(copies);
      const assetCounts = new Map<string, number>();
      for (const copy of copies) if (copy.assetId) assetCounts.set(copy.assetId, (assetCounts.get(copy.assetId) ?? 0) + 1);
      setAssets((items) => items.map((asset) => assetCounts.has(asset.id) ? { ...asset, usageCount: asset.usageCount + assetCounts.get(asset.id)! } : asset));
    }
    catch (e) { setError((e as Error).message); }
  }
  async function deleteSceneObject(object: SceneObject) {
    try {
      if (canManage) {
        const redo = applyObjectLifecycle(object.sceneId, [object.id], 'delete');
        const before = versionsOf([object]);
        commandHistory.record({ before, after: await redo(before),
          undo: applyObjectLifecycle(object.sceneId, [object.id], 'restore'), redo,
        });
        return;
      }
      await api(`/api/objects/${object.id}`, { method: 'DELETE', body: JSON.stringify({ expectedVersion: object.version }) });
      setObjects((items) => items.filter((item) => item.id !== object.id));
      setSelectedObjectId((id) => id === object.id ? '' : id);
      setSelectedObjectIds((items) => items.filter((id) => id !== object.id));
    }
    catch (e) { setError((e as Error).message); }
  }
  async function clearMyDrawings() {
    if (!scene || !window.confirm(t('clearMyDrawingsConfirm'))) return;
    try {
      const result = await api<{ deletedCount: number }>(`/api/scenes/${scene.id}/my-drawings`, { method: 'DELETE' });
      setObjects((items) => items.filter((object) => !(object.kind === 'FREEHAND' && object.ownedByMe)));
      if (result.deletedCount) setNotice(t('myDrawingsCleared', { count: result.deletedCount }));
    } catch (e) { setError((e as Error).message); }
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
    try { const data = await api<{ token: PublicToken }>('/api/tokens', { method: 'POST', body: JSON.stringify({ sceneId: scene.id, name: `Token ${tokens.length + 1}`, x: 3 + tokens.length % 5, y: 3, color: ['#c8794a', '#668d7b', '#b2a26a', '#9b738d'][tokens.length % 4] }), recoverable: true }); if (commandHistory.isCurrent()) setTokens((items) => items.some((item) => item.id === data.token.id) ? items : [...items, data.token]); }
    catch (e) { setError((e as Error).message); }
  }
  async function dropTokenAsset(assetId: string, worldX: number, worldY: number) {
    if (!scene || !canManage) return;
    const asset = assets.find((item) => item.id === assetId && item.category === 'TOKEN');
    if (!asset) return;
    const maxX = Math.max(0, scene.width / scene.gridSize - 0.25);
    const maxY = Math.max(0, scene.height / scene.gridSize - 0.25);
    const rawX = worldX / scene.gridSize; const rawY = worldY / scene.gridSize;
    const x = Math.max(0, Math.min(maxX, scene.snapToGrid ? Math.round(rawX) : rawX));
    const y = Math.max(0, Math.min(maxY, scene.snapToGrid ? Math.round(rawY) : rawY));
    try {
      const result = await api<{ token: PublicToken }>('/api/tokens', { method: 'POST', body: JSON.stringify({ sceneId: scene.id, name: asset.name.slice(0, 48), x, y, imageAssetId: asset.id }), recoverable: true });
      if (!commandHistory.isCurrent()) return;
      setTokens((items) => items.some((item) => item.id === result.token.id) ? items : [...items, result.token]);
      setAssets((items) => items.map((item) => item.id === asset.id ? { ...item, usageCount: item.usageCount + 1 } : item));
    } catch (e) { setError((e as Error).message); }
  }
  async function pasteToken() {
    if (!scene || tokenClipboard.length === 0) return;
    try {
      const duplicates = tokenClipboard.map((source) => {
        const maxX = Math.max(0, scene.width - source.width * scene.gridSize);
        const maxY = Math.max(0, scene.height - source.height * scene.gridSize);
        return { tokenId: source.id, expectedVersion: source.version, x: Math.min(maxX, Math.max(0, source.x + scene.gridSize / 2)), y: Math.min(maxY, Math.max(0, source.y + scene.gridSize / 2)) };
      });
      const created = tokenClipboard.length === 1
        ? [await api<{ token: PublicToken }>(`/api/tokens/${tokenClipboard[0]!.id}/duplicate`, { method: 'POST', body: JSON.stringify({ sceneId: scene.id, ...duplicates[0] }), recoverable: true }).then((result) => result.token)]
        : (await api<{ tokens: PublicToken[] }>(`/api/scenes/${scene.id}/tokens/duplicate`, { method: 'POST', body: JSON.stringify({ sceneId: scene.id, tokens: duplicates }), recoverable: true })).tokens;
      if (!commandHistory.isCurrent()) return;
      setTokens((items) => [...items, ...created.filter((token) => !items.some((item) => item.id === token.id))]);
      setSelectedTokenIds(created.map((token) => token.id));
      const copiedAssetCounts = new Map<string, number>();
      for (const token of created) if (token.imageAssetId) copiedAssetCounts.set(token.imageAssetId, (copiedAssetCounts.get(token.imageAssetId) ?? 0) + 1);
      setAssets((items) => items.map((asset) => ({ ...asset, usageCount: asset.usageCount + (copiedAssetCounts.get(asset.id) ?? 0) })));
    } catch (e) { setError((e as Error).message); }
  }
  async function invite() {
    if (!campaign) return;
    try { const data = await api<{ invitation: string }>('/api/invitations', { method: 'POST', body: JSON.stringify({ campaignId: campaign.campaign.id }) }); const link = `${location.origin}/?invite=${data.invitation}`; await navigator.clipboard.writeText(link); setNotice(t('inviteCreated')); }
    catch (e) { setError((e as Error).message); }
  }
  async function assignToken(token: PublicToken, ownerUserId: string) {
    try { const result = await api<{ token: PublicToken }>(`/api/tokens/${token.id}/owner`, { method: 'POST', body: JSON.stringify({ ownerUserId: ownerUserId || null }) }); if (commandHistory.isCurrent()) setTokens((items) => items.map((item) => item.id === token.id && result.token.version >= item.version ? result.token : item)); }
    catch (e) { setError((e as Error).message); }
  }
  function applyTokenUpdates(updates: PublicToken[]) {
    if (!commandHistory.isCurrent()) return;
    const byId = new Map(updates.map((token) => [token.id, token]));
    setTokens((items) => items.map((item) => {
      const next = byId.get(item.id);
      return next && next.version >= item.version ? { ...item, ...next } : item;
    }));
  }

  async function updateToken(token: PublicToken, patch: Partial<PublicToken>) {
    const apply = (changes: Partial<PublicToken>) => async (versions: Versions) => {
      const { token: updated } = await api<{ token: PublicToken }>("/api/tokens/" + token.id, {
        method: 'PATCH', body: JSON.stringify({ ...changes, expectedVersion: versions[token.id] }),
      });
      applyTokenUpdates([updated]);
      return updated;
    };
    try {
      const before = versionsOf([token]);
      const updated = await apply(patch)(before);
      commandHistory.record({ before, after: versionsOf([updated]),
        undo: async (versions) => versionsOf([await apply(pickChanged(token, patch))(versions)]),
        redo: async (versions) => versionsOf([await apply(pickChanged(updated, patch))(versions)]),
      });
    } catch (error) { setError((error as Error).message); }
  }

  async function applyGroupChanges(selected: PublicToken[], changes: (token: PublicToken) => GroupPatch) {
    if (!scene || selected.length < 2 || selected.length > 50) return;
    const sceneId = scene.id;
    const patches = selected.map((token) => ({ tokenId: token.id, patch: changes(token) }));
    const inverse = selected.map((token, index) => ({ tokenId: token.id, patch: pickChanged(token, patches[index]!.patch) }));
    const apply = (items: typeof patches) => async (versions: Versions) => {
      const result = await api<{ tokens: PublicToken[] }>("/api/scenes/" + sceneId + "/tokens/group", {
        method: 'PATCH',
        body: JSON.stringify({ updates: items.map((item) => ({ ...item, expectedVersion: versions[item.tokenId] })) }),
      });
      applyTokenUpdates(result.tokens);
      return versionsOf(result.tokens);
    };
    try {
      const before = versionsOf(selected);
      const redo = apply(patches);
      const after = await redo(before);
      commandHistory.record({ before, after, undo: apply(inverse), redo });
    } catch (error) { setError((error as Error).message); }
  }

  function updateTokenGroup(patch: GroupPatch) {
    return applyGroupChanges(tokens.filter((token) => selectedTokenIds.includes(token.id)), () => patch);
  }

  function moveTokenGroup(tokenIds: string[], deltaX: number, deltaY: number) {
    return applyGroupChanges(tokens.filter((token) => tokenIds.includes(token.id)), (token) => ({ x: token.x + deltaX, y: token.y + deltaY }));
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
      if (commandHistory.isCurrent()) setTokens((items) => items.map((item) => item.id === token.id && result.token.version >= item.version
        ? { ...result.token, ...(item.ownerUserId === result.token.ownerUserId && item.ownerNote !== undefined ? { ownerNote: item.ownerNote } : {}) } : item));
    } catch (e) {
      if (!commandHistory.isCurrent()) return;
      const detail = (e as Error).message;
      setError(`${i18n.language === 'ru' ? 'Изменение не подтверждено. Текущее значение будет загружено; если ответ потерялся, сервер мог применить действие. Проверьте значение перед следующим изменением.' : 'The change was not confirmed. The current value will be reloaded; if the response was lost, the server may have applied it. Review before another adjustment.'} (${detail})`);
      if (scene) try {
        const snapshot = await api<PublicToken[]>(`/api/scenes/${scene.id}/tokens`);
        if (commandHistory.isCurrent()) setTokens(snapshot);
      } catch { /* Keep the outcome-unknown message visible. */ }
    }
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
    try { const library = await api<{ assets: CampaignAsset[]; folders: AssetFolder[]; storageBytes: number }>(`/api/campaigns/${campaign.campaign.id}/assets`); setAssets(library.assets); setAssetFolders(library.folders); setAssetStorageBytes(library.storageBytes); setAssetLibraryOpen(true); }
    catch (e) { setError((e as Error).message); }
  }
  async function uploadAssetFiles(files: File[]) {
    if (!files.length || !campaign) return;
    const form = new FormData(); for (const file of files) form.append('files', file);
    try {
      const result = await api<{ assets: CampaignAsset[]; failures?: Array<{ filename: string; error: string }> }>(`/api/campaigns/${campaign.campaign.id}/assets?category=${assetUploadCategory}`, { method: 'POST', body: form, recoverable: true });
      setAssets((items) => [...result.assets.map((item: CampaignAsset) => ({ ...item, folderId: null, usageCount: 0 })), ...items]); setAssetStorageBytes((bytes) => bytes + result.assets.reduce((total: number, item: CampaignAsset) => total + item.size, 0));
      if (result.failures?.length) setError(`${result.failures.length} ${t('assetUploadFailed')}`);
      else setNotice(t('assetsUploaded', { count: result.assets.length }));
    } catch (e) { setError((e as Error).message); }
  }
  function uploadAssets(event: React.ChangeEvent<HTMLInputElement>) {
    const files = [...(event.target.files ?? [])]; event.target.value = '';
    void uploadAssetFiles(files);
  }
  function dropAssets(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault(); event.stopPropagation(); setAssetDropActive(false);
    const tokenAssetId = event.dataTransfer.getData('application/x-nri-token-asset');
    if (tokenAssetId) { window.dispatchEvent(new CustomEvent('nri-drop-token-asset', { detail: { assetId: tokenAssetId, clientX: event.clientX, clientY: event.clientY } })); return; }
    const files = [...event.dataTransfer.files].filter((file) => file.type.startsWith('image/'));
    void uploadAssetFiles(files);
  }
  async function updateAsset(asset: CampaignAsset, patch: Partial<Pick<CampaignAsset, 'name' | 'category' | 'folderId'>>) {
    try {
      const result = await api<{ asset: CampaignAsset }>(`/api/assets/${asset.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
      setAssets((items) => items.map((item) => item.id === asset.id ? { ...item, ...result.asset } : item));
    } catch (e) { setError((e as Error).message); }
  }
  async function createAssetFolder() {
    if (!campaign || !newAssetFolderName.trim()) return;
    try {
      const result = await api<{ folder: AssetFolder }>(`/api/campaigns/${campaign.campaign.id}/asset-folders`, { method: 'POST', body: JSON.stringify({ name: newAssetFolderName }) });
      setAssetFolders((items) => [...items, result.folder].sort((a, b) => a.name.localeCompare(b.name)));
      setNewAssetFolderName('');
    } catch (e) { setError((e as Error).message); }
  }
  async function renameAssetFolder(folder: AssetFolder) {
    const name = window.prompt(t('renameAssetFolder'), folder.name)?.trim();
    if (!name || name === folder.name) return;
    try {
      const result = await api<{ folder: AssetFolder }>(`/api/asset-folders/${folder.id}`, { method: 'PATCH', body: JSON.stringify({ name }) });
      setAssetFolders((items) => items.map((item) => item.id === folder.id ? result.folder : item).sort((a, b) => a.name.localeCompare(b.name)));
    } catch (e) { setError((e as Error).message); }
  }
  async function deleteAssetFolder(folder: AssetFolder) {
    if (!window.confirm(t('confirmDeleteAssetFolder', { name: folder.name }))) return;
    try {
      await api(`/api/asset-folders/${folder.id}`, { method: 'DELETE' });
      setAssetFolders((items) => items.filter((item) => item.id !== folder.id));
      setAssets((items) => items.map((item) => item.folderId === folder.id ? { ...item, folderId: null } : item));
      setAssetFolderFilter('ALL');
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
      if (commandHistory.isCurrent() && scene?.id === item.sceneId) setTokens((items) => items.some((token) => token.id === result.token.id) ? items : [...items, result.token]);
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
  async function submitInitiative(action: 'start' | 'advance' | 'stop', body: object) {
    if (!campaign || initiativeRequest.current) return;
    const campaignId = campaign.campaign.id;
    initiativeRequest.current = true;
    setInitiativePending(true);
    try {
      const view = await api<InitiativeView>(`/api/campaigns/${campaignId}/initiative/${action}`, { method: 'POST', body: JSON.stringify(body) });
      if (isCurrentScope()) setInitiative(view);
    } catch (error) {
      if (campaignIdRef.current === campaignId) setError((error as Error).message);
    } finally {
      initiativeRequest.current = false;
      setInitiativePending(false);
    }
  }
  function startInitiative() {
   …329 tokens truncated…ew Error(t('offline'));
      if (x === token.x && y === token.y) return;
      const before = versionsOf([token]);
      const redo = move(x, y);
      const after = await redo(before);
      commandHistory.record({ before, after, undo: move(token.x, token.y), redo });
    } catch (error) { setError((error as Error).message); }
  }

  function transmitChat(pending: NonNullable<typeof pendingChat>) {
    if (!connected || campaign?.campaign.id !== pending.campaignId) { setPendingChat({ ...pending, state: 'unknown' }); return; }
    setPendingChat({ ...pending, state: 'sending' });
    socket.timeout(5000).emit('chat:send', pending, (timeout: Error | null, result: { error?: string; message?: ChatItem }) => {
      if (timeout) {
        if (campaignIdRef.current === pending.campaignId) setPendingChat((current) => current?.clientMessageId === pending.clientMessageId ? { ...pending, state: 'unknown' } : current);
        return;
      }
      if (result.message && isCurrentScope() && result.message.campaignId === campaignIdRef.current) {
        setMessages((items) => items.some((item) => item.id === result.message!.id) ? items : [...items.slice(-99), result.message!]);
        setChatText(''); setPendingChat((current) => current?.clientMessageId === pending.clientMessageId ? null : current);
      } else if (campaignIdRef.current === pending.campaignId) {
        setPendingChat((current) => current?.clientMessageId === pending.clientMessageId ? null : current);
        if (result.error) setError(result.error);
      }
    });
  }
  function sendChat(event: React.FormEvent) {
    event.preventDefault(); if (!campaign) return;
    if (pendingChat?.state === 'unknown' && pendingChat.campaignId === campaign.campaign.id) { transmitChat(pendingChat); return; }
    if (pendingChat || !chatText.trim()) return;
    transmitChat({ campaignId: campaign.campaign.id, clientMessageId: crypto.randomUUID(), body: chatText.trim(), recipientId: messageRecipient || null, state: 'sending' });
  }
  function transmitRoll(pending: NonNullable<typeof pendingRoll>) {
    if (!connected || campaign?.campaign.id !== pending.campaignId) { setPendingRoll({ ...pending, state: 'unknown' }); return; }
    setPendingRoll({ ...pending, state: 'sending' });
    socket.timeout(5000).emit('dice:roll', pending, (timeout: Error | null, result: { error?: string; roll?: RollItem }) => {
      if (timeout) {
        if (campaignIdRef.current === pending.campaignId) setPendingRoll((current) => current?.requestId === pending.requestId ? { ...pending, state: 'unknown' } : current);
        return;
      }
      if (result.roll && isCurrentScope() && result.roll.campaignId === campaignIdRef.current) {
        setRolls((items) => result.roll!.id && items.some((item) => item.id === result.roll!.id) ? items : [...items.slice(-19), result.roll!]);
        setPendingRoll((current) => current?.requestId === pending.requestId ? null : current);
      } else if (campaignIdRef.current === pending.campaignId) {
        setPendingRoll((current) => current?.requestId === pending.requestId ? null : current);
        if (result.error) setError(result.error);
      }
    });
  }
  function rollDice() {
    if (!campaign) return;
    if (pendingRoll?.state === 'unknown' && pendingRoll.campaignId === campaign.campaign.id) { transmitRoll(pendingRoll); return; }
    if (pendingRoll) return;
    transmitRoll({ campaignId: campaign.campaign.id, requestId: crypto.randomUUID(), expression: '1d20', hidden: hiddenRoll, state: 'sending' });
  }
  if (!user) return <main className="auth-shell"><div className="auth-card"><div className="brand-mark">N</div><p className="eyebrow">TABLETOP, REIMAGINED</p><h1>{t('subtitle')}</h1><p className="muted">A calm, flexible space for stories shared around a table.</p><form onSubmit={submitAuth} className="form-stack">
    {authMode === 'register' && <label>{t('displayName')}<input name="displayName" minLength={1} maxLength={48} required /></label>}
    <label>{t('email')}<input type="email" name="email" autoComplete="email" required /></label><label>{t('password')}<input type="password" name="password" autoComplete={authMode === 'login' ? 'current-password' : 'new-password'} minLength={authMode === 'register' ? 12 : 1} required /></label>
    {error && <p className="form-error">{error === 'OUTCOME_UNKNOWN' ? t('outcomeUnknown') : error}</p>}<button className="button primary" disabled={busy}>{t(authMode === 'login' ? 'signIn' : 'signUp')}</button></form><button className="link-button" onClick={() => setAuthMode(authMode === 'login' ? 'register' : 'login')}>{t(authMode === 'login' ? 'signUp' : 'signIn')}</button>
    <div className="language"><button onClick={() => void i18n.changeLanguage('en')}>EN</button><span>·</span><button onClick={() => void i18n.changeLanguage('ru')}>RU</button></div></div></main>;

  return <main className="app-shell" data-theme={theme}><header className="topbar"><button className="brand" onClick={() => { clearRecoverableRequests(); setCampaign(null); }}><span className="brand-mark small">N</span><span>NRI</span></button><div className="topbar-right">{campaign && <span className={`live-status ${connected ? 'online' : ''}`}><i />{t(connected ? 'connection' : 'offline')}</span>}<span className="user-chip">{user.displayName}</span><button className="icon-button" aria-label={t(theme === 'dark' ? 'switchToLight' : 'switchToDark')} onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>{t(theme === 'dark' ? 'lightTheme' : 'darkTheme')}</button><button className="icon-button" title="Language" onClick={() => void i18n.changeLanguage(i18n.language === 'en' ? 'ru' : 'en')}>{i18n.language.toUpperCase()}</button><button className="quiet-button" onClick={() => void api('/api/auth/logout', { method: 'POST' }).finally(() => { setUser(null); clearRecoverableRequests(); setCampaign(null); socket.disconnect(); })}>{t('signOut')}</button></div></header>
    {!campaign ? <section className="campaign-home"><div className="welcome"><p className="eyebrow">YOUR ADVENTURE STARTS HERE</p><h1>{t('campaigns')}</h1><p className="muted">Gather your group and make a little room for the unexpected.</p></div><div className="campaign-layout"><div className="campaign-list">{campaigns.map((item) => <div key={item.campaign.id} className="campaign-entry"><button className="campaign-card" onClick={() => { clearRecoverableRequests(); setCampaign(item); }}><span className="campaign-art"><span>✳</span></span><span><strong>{item.campaign.title}</strong><small>{item.campaign.description || item.role}</small></span><span className="card-arrow">↗</span></button>{['OWNER', 'GM'].includes(item.role) && <button className="quiet-button campaign-copy" disabled={busy} onClick={() => void duplicateCampaign(item)}>{t('duplicateCampaign')}</button>}</div>)}{campaigns.length === 0 && <p className="empty-state">{t('noCampaigns')}</p>}</div><form className="create-card" onSubmit={createCampaign}><p className="eyebrow">START SOMETHING NEW</p><h2>{t('newCampaign')}</h2><label>{t('title')}<input name="title" maxLength={80} required /></label><label>{t('description')}<textarea name="description" maxLength={500} rows={3} /></label><button className="button primary" disabled={busy}>{t('create')} <span>↗</span></button></form></div></section> : <section className="table-layout">
      <header className="table-heading"><div><button className="back-link" onClick={() => { clearRecoverableRequests(); setCampaign(null); }}>← {t('back')}</button><h1>{campaign.campaign.title}</h1><p>{campaign.campaign.description}</p></div><div className="table-actions"><button className="button secondary" onClick={() => void toggleFullscreen()}>{t(fullscreen ? 'exitFullscreen' : 'enterFullscreen')}</button><button className="quiet-button" disabled={!commandHistory.canUndo} onClick={() => void commandHistory.apply('undo')}>{t('undoMove')}</button><button className="quiet-button" disabled={!commandHistory.canRedo} onClick={() => void commandHistory.apply('redo')}>{t('redoMove')}</button>{canManage && <><button className="button secondary" onClick={() => void invite()}>{t('invite')} <span>↗</span></button><button className="button secondary" onClick={() => { setSceneTitle(''); setSceneDialog('create'); }}>＋ {t('addScene')}</button><button className="button secondary" onClick={() => void openAssetLibrary()}>{t('assetLibrary')}</button><button className="button secondary" onClick={() => void openTokenTrash()}>{t('tokenTrash')}</button><button className="button secondary" onClick={() => mapInput.current?.click()} disabled={!scene}>⇧ {t('uploadMap')}</button><input ref={mapInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={uploadBackground} /><button className="button primary" onClick={() => void addToken()} disabled={!scene}>＋ {t('addToken')}</button></>}</div></header>
      {canManage && <label className="quiet-button"><input type="checkbox" checked={Boolean(campaign.campaign.playersCanDraw)} onChange={(event) => void setPlayerDrawingPermission(event.target.checked)} />{t('playersCanDraw')}</label>}
      {!canManage && scene && <div className="player-drawing-tools">{canDraw && <><label>{t('drawingColor')} <input aria-label={t('drawingColor')} type="color" value={drawingColor} onChange={(event) => setDrawingColor(event.target.value)} /></label><label>{t('drawingWidth')} <input aria-label={t('drawingWidth')} type="range" min="1" max="16" value={drawingWidth} onChange={(event) => setDrawingWidth(Number(event.target.value))} /></label><button className={drawMode ? 'button primary' : 'button secondary'} aria-pressed={drawMode} disabled={!drawingLayer || drawingLayer.kind !== 'OBJECTS' || drawingLayer.locked || !drawingLayer.visibleToPlayers} onClick={() => { setDrawMode((enabled) => !enabled); setRulerActive(false); setPointerActive(false); }}>{t(drawMode ? 'finishDrawing' : 'drawFreehand')}</button></>}{objects.filter((object) => object.kind === 'FREEHAND' && object.ownedByMe).map((object) => <button className="quiet-button" key={object.id} onClick={() => void deleteSceneObject(object)}>{t('deleteMyDrawing')}</button>)}<button className="quiet-button" disabled={!objects.some((object) => object.kind === 'FREEHAND' && object.ownedByMe)} onClick={() => void clearMyDrawings()}>{t('clearMyDrawings')}</button></div>}      <div className="scene-workbench"><div className="scene-tabs">{scenes.map((item) => <div className={`scene-tab-wrap ${scene?.id === item.id ? 'selected' : ''}`} key={item.id} onContextMenu={(event) => { event.preventDefault(); if (canManage) setSceneMenu({ x: event.clientX, y: event.clientY, scene: item }); }}><button className="scene-tab" onClick={() => void openScene(item)}><span className="scene-thumbnail" style={item.backgroundAssetId ? { backgroundImage: `url(/api/assets/${item.backgroundAssetId})` } : undefined} /><span className="scene-tab-copy">{item.title}<small className={item.isActive ? 'scene-live' : 'scene-draft'}>{canManage ? t(item.isActive ? 'live' : 'draft') : t('scene')}</small></span></button>{canManage && <button className="scene-menu-trigger" aria-label={`Actions for ${item.title}`} onClick={(event) => setSceneMenu({ x: event.currentTarget.getBoundingClientRect().left, y: event.currentTarget.getBoundingClientRect().bottom, scene: item })}>•••</button>}</div>)}{!scenes.length && <span className="muted">Create a scene to set up the table.</span>}</div>{canManage && scene && <div className="scene-actions"><button className="quiet-button" onClick={() => { setSceneTitle(scene.title); setSceneDialog('rename'); }}>{t('renameScene')}</button><button className="quiet-button" onClick={() => void duplicateScene(scene)}>{t('duplicateScene')}</button><button className="quiet-button" onClick={() => setSceneDialog('grid')}>{t('gridSettings')}</button><button className="quiet-button" disabled={scene.isActive} onClick={() => activateScene(scene)}>{scene.isActive ? t('activeForPlayers') : t('setActive')}</button><button className="quiet-button" onClick={() => void reorderScene(scene, -1)}>←</button><button className="quiet-button" onClick={() => void reorderScene(scene, 1)}>→</button><button className="quiet-button" onClick={() => void archiveScene(scene)}>{t('archive')}</button><button className="quiet-button" onClick={() => void loadArchivedScenes()}>{showArchivedScenes ? t('hideArchived') : t('archived')}</button></div>}{canManage && showArchivedScenes && archivedScenes.length > 0 && <div className="archived-scenes">{archivedScenes.map((item) => <span key={item.id}>{item.title}<button className="quiet-button" onClick={() => void restoreScene(item)}>{t('restore')}</button></span>)}</div>}</div>
      {canManage && scene && <details className="layer-tools"><summary>{t('layers')} · {objects.length} {t('sceneObjects')}</summary><div className="layer-tools-body"><div className="layer-list">{layers.map((layer) => <div className={`layer-row ${activeLayerId === layer.id ? 'selected' : ''}`} key={layer.id}><button className="layer-select" onClick={() => { setActiveLayerId(layer.id); setSelectedObjectId(''); setSelectedObjectIds([]); }}>{layer.name}<small>{layer.kind}</small></button><label><input type="checkbox" checked={layer.visibleToPlayers} disabled={layer.kind === 'GM'} onChange={(event) => void updateSceneLayer(layer, { visibleToPlayers: event.target.checked })} />{t('visibleForPlayers')}</label><button className="quiet-button" title={t('raiseLayer')} onClick={() => void updateSceneLayer(layer, { sortOrder: layer.sortOrder + 1 })}>↑</button><button className="quiet-button" title={t('lowerLayer')} onClick={() => void updateSceneLayer(layer, { sortOrder: layer.sortOrder - 1 })}>↓</button><button className="quiet-button" onClick={() => void updateSceneLayer(layer, { locked: !layer.locked })}>{t(layer.locked ? 'unlock' : 'lock')}</button>{layer.kind === 'CUSTOM' && <button className="quiet-button" onClick={() => void deleteCustomLayer(layer)}>×</button>}</div>)}<button className="quiet-button add-layer" onClick={() => void addCustomLayer()}>＋ {t('addCustomLayer')}</button></div><div className="layer-object-tools"><div className="draw-style-controls"><label>{t('drawingColor')} <input type="color" value={drawingColor} onChange={(event) => setDrawingColor(event.target.value)} /></label><label>{t('drawingWidth')} <input type="range" min="1" max="16" step="1" value={drawingWidth} onChange={(event) => setDrawingWidth(Number(event.target.value))} /></label></div><div className="object-tool-actions"><button className="button secondary" disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => void addSceneObject('RECTANGLE')}>{t('addRectangle')}</button><button className="button secondary" disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => void addSceneObject('ELLIPSE')}>{t('addEllipse')}</button><button className="button secondary" disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => void addSceneObject('LINE')}>{t('addLine')}</button><button className="button secondary" disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={addTextObject}>{t('addText')}</button><button className={drawMode ? 'button primary' : 'button secondary'} aria-pressed={drawMode} disabled={!activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => { setDrawMode((enabled) => !enabled); setRulerActive(false); setSelectionMode(false); setPointerActive(false); }}>{t(drawMode ? 'finishDrawing' : 'drawFreehand')}</button></div><div className="object-clipboard-actions"><button className="quiet-button" disabled={selectedObjectIds.length === 0} onClick={() => { const selected = objects.filter((object) => selectedObjectIds.includes(object.id)); if (selected.length) setObjectClipboard(selected); }}>{t('copyObject')}</button><button className="quiet-button" disabled={objectClipboard.length === 0 || !activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => void pasteSceneObject()}>{t('pasteObject')}</button></div><div className="scene-object-list">{objects.filter((object) => object.layerId === activeLayerId).map((object) => <div className={`scene-object-row ${selectedObjectIds.includes(object.id) ? 'selected' : ''}`} key={object.id} data-object-id={object.id}><button className="quiet-button object-select" aria-label={t('multiSelectObjects')} aria-pressed={selectedObjectIds.includes(object.id)} onClick={(event) => { const multi = event.shiftKey || event.ctrlKey || event.metaKey; setSelectedObjectId(object.id); setSelectedObjectIds((current) => { if (!multi) return [object.id]; if (current.includes(object.id)) return current.filter((id) => id !== object.id); return [...current, object.id].slice(-50); }); }}>{t(object.kind.toLowerCase())}</button>{object.kind === 'TEXT' && <button className="quiet-button" title={t('editText')} onClick={() => editTextObject(object)}>✎</button>}<button className="quiet-button" title={t(object.visible ? 'hideObject' : 'showObject')} onClick={() => void updateSceneObject(object, { visible: !object.visible })}>{object.visible ? '◉' : '◎'}</button><button className="quiet-button" title={t('rotateObject')} onClick={() => void updateSceneObject(object, { rotation: (object.rotation + 15) % 360 })}>↻</button><input aria-label={t('objectColor')} type="color" value={object.color ?? '#c8794a'} onChange={(event) => void updateSceneObject(object, { color: event.target.value })} /><input aria-label={t('objectOpacity')} type="range" min="0" max="1" step="0.05" value={object.opacity} onChange={(event) => void updateSceneObject(object, { opacity: Number(event.target.value) })} /><button className="quiet-button" title={t('raiseObject')} onClick={() => void updateSceneObject(object, { zIndex: object.zIndex + 1 })}>↑</button><button className="quiet-button" title={t('lowerObject')} onClick={() => void updateSceneObject(object, { zIndex: object.zIndex - 1 })}>↓</button><select aria-label={t('moveToLayer')} value={object.layerId} onChange={(event) => void updateSceneObject(object, { layerId: event.target.value })}>{layers.map((layer) => <option key={layer.id} value={layer.id} disabled={layer.locked}>{layer.name}</option>)}</select><button className="quiet-button" title={t('duplicateObject')} onClick={() => void duplicateSceneObject(object)}>⧉</button><button className="quiet-button" onClick={() => void updateSceneObject(object, { locked: !object.locked })}>{t(object.locked ? 'unlock' : 'lock')}</button><button className="quiet-button" onClick={() => void deleteSceneObject(object)}>{t('deleteObject')}</button></div>)}{objects.every((object) => object.layerId !== activeLayerId) && <span className="muted">{t('noObjects')}</span>}</div></div></div></details>}
      <div className={`table-content ${rightRailCollapsed ? 'rail-collapsed' : ''}`} style={{ '--rail-width': `${rightRailWidth}px` } as React.CSSProperties}>
        <section className="table-main">
          {scene ? (
            <Suspense fallback={<div className="canvas-loading">Loading tabletop…</div>}>
              <TableCanvas tokens={tokens} objects={objects} canManage={canManage} selectedTokenIds={selectedTokenIds} onMoveGroup={moveTokenGroup} activeLayerId={activeLayerId} layerSortOrder={layerSortOrder} canEditObject={canEditObject} onEditObject={(id, patch) => { const object = objects.find((item) => item.id === id); if (object) void updateSceneObject(object, patch); }} gridSize={scene.gridSize} gridColor={scene.gridColor} gridOpacity={scene.gridOpacity} gridOffsetX={scene.gridOffsetX} gridOffsetY={scene.gridOffsetY} gridEnabled={scene.gridEnabled} snapToGrid={scene.snapToGrid} backgroundUrl={scene.backgroundAssetId ? '/api/assets/' + scene.backgroundAssetId : undefined} sceneId={scene.id} sceneWidth={scene.width} sceneHeight={scene.height} cameraX={scene.cameraX} cameraY={scene.cameraY} cameraZoom={scene.cameraZoom} unitsPerCell={scene.unitsPerCell} unitLabel={scene.unitLabel} onMove={moveToken} fitLabel={t('fitScene')} rulerActive={rulerActive} rulerLabel={t(rulerActive ? 'finishRuler' : 'measureDistance')} selectionMode={canManage && selectionMode} selectionLabel={t(selectionMode ? 'finishSelection' : 'selectArea')} onSelectTokens={setSelectedTokenIds} pointerActive={pointerActive} pointerLabel={t(pointerActive ? 'stopPointer' : 'sharePointer')} onSharePointer={(x, y) => { if (scene) socket.emit('scene:pointer', { campaignId: scene.campaignId, sceneId: scene.id, x, y }); }} calibrationActive={calibrationActive} gridPreviewSize={gridPreviewSize} gridPreviewOffsetX={gridPreviewOffsetX} gridPreviewOffsetY={gridPreviewOffsetY} onCalibrationComplete={finishGridCalibration} onRendererError={() => setError(t('rendererFailed'))} drawMode={canDraw && drawMode && drawingLayer?.kind === 'OBJECTS' && !drawingLayer.locked && drawingLayer.visibleToPlayers} onCreateDrawing={(points) => void addFreehandDrawing(points)} canEdit={(token) => canManage || token.ownerUserId === user.id} onDropTokenAsset={dropTokenAsset} />
            </Suspense>
          ) : (
            <div className="empty-table"><div className="brand-mark">✳</div><h2>{t('guide')}</h2><p>{t('guideText')}</p>{canManage && <button className="button primary" onClick={() => setSceneDialog('create')}>{t('addScene')}</button>}</div>
          )}
          <div className="canvas-toolbar"><span>{scene?.title ?? t('mapLabel')}</span><span className="zoom-hint">{calibrationActive ? t('calibrationPrompt') : t('canvasHelp')}</span>{calibrationActive && <button className="quiet-button calibration-cancel" onClick={() => setCalibrationActive(false)}>{t('cancel')}</button>}</div>
        </section><aside className={`right-rail ${rightRailCollapsed ? 'collapsed' : ''}`}><div className="rail-header"><span className="online-dot" /><span className="rail-title">{t('players')}</span>{!rightRailCollapsed && <span className="role-badge">{role}</span>}<button className="quiet-button rail-toggle" aria-label={t(rightRailCollapsed ? 'expandPanel' : 'collapsePanel')} title={t(rightRailCollapsed ? 'expandPanel' : 'collapsePanel')} onClick={() => setRightRailCollapsed((value) => !value)}>{rightRailCollapsed ? '‹' : '›'}</button></div>{!rightRailCollapsed && <><label className="rail-width-control">{t('panelWidth')}<input type="range" min="220" max="480" step="10" value={rightRailWidth} onChange={(event) => setRightRailWidth(Number(event.target.value))} /></label><section className="rail-section"><div className="section-title"><span>✦</span> {t('guide')}</div><p className="guide-copy">{t('guideText')}</p></section>{canManage && <section className="rail-section token-owners"><div className="section-title">♙ {t('tokenProperties')}</div><div className="token-group-tools"><span>{t('selectedTokens', { count: selectedTokenIds.length })}</span><button className="quiet-button" onClick={() => setSelectedTokenIds(tokens.slice(0, 50).map((token) => token.id))}>{t('selectAllTokens')}</button><button className="quiet-button" onClick={() => setSelectedTokenIds([])}>{t('clearTokenSelection')}</button><button className="quiet-button" disabled={selectedTokenIds.length === 0} onClick={() => { const selected = tokens.filter((item) => selectedTokenIds.includes(item.id)); if (selected.length) { setTokenClipboard(selected); setObjectClipboard([]); } }}>{t('copyToken')}</button><button className="quiet-button" disabled={tokenClipboard.length === 0} onClick={() => void pasteToken()}>{t('pasteToken')}</button><button className="quiet-button" disabled={selectedTokenIds.length < 2} onClick={() => void updateTokenGroup({ locked: true })}>{t('groupLock')}</button><button className="quiet-button" disabled={selectedTokenIds.length < 2} onClick={() => void updateTokenGroup({ locked: false })}>{t('groupUnlock')}</button><button className="quiet-button" disabled={selectedTokenIds.length < 2} onClick={() => void updateTokenGroup({ hidden: true })}>{t('groupHide')}</button><button className="quiet-button" disabled={selectedTokenIds.length < 2} onClick={() => void updateTokenGroup({ hidden: false })}>{t('groupShow')}</button></div>{tokens.map((token) => <details className="token-property-card" key={`${token.id}-${token.version}`}><summary><input type="checkbox" checked={selectedTokenIds.includes(token.id)} aria-label={t('selectToken', { name: token.name })} onClick={(event) => event.stopPropagation()} onChange={(event) => setSelectedTokenIds((ids) => event.target.checked ? ids.length >= 50 ? ids : [...ids, token.id] : ids.filter((id) => id !== token.id))} /><span>{token.name}</span></summary><label>{t('tokenName')}<input defaultValue={token.name} maxLength={48} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== token.name) void updateToken(token, { name: event.target.value }); }} /></label><label>{t('tokenColor')}<input type="color" defaultValue={token.color} onBlur={(event) => { if (event.target.value !== token.color) void updateToken(token, { color: event.target.value }); }} /></label><label>{t('tokenImage')}<select value={token.imageAssetId ?? ''} onChange={(event) => void updateToken(token, { imageAssetId: event.target.value || null })}><option value="">{t('noTokenImage')}</option>{assets.filter((asset) => asset.category === 'TOKEN').map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label><label>{t('tokenBorder')}<input type="color" defaultValue={token.borderColor} onBlur={(event) => { if (event.target.value !== token.borderColor) void updateToken(token, { borderColor: event.target.value }); }} /></label><div className="token-size-fields"><label>{t('tokenWidth')}<input type="number" min="0.25" max="100" step="0.25" defaultValue={token.width} onBlur={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value !== token.width) void updateToken(token, { width: value }); }} /></label><label>{t('tokenHeight')}<input type="number" min="0.25" max="100" step="0.25" defaultValue={token.height} onBlur={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value !== token.height) void updateToken(token, { height: value }); }} /></label></div><label>{t('tokenRotation')}<input type="number" min="-360000" max="360000" step="15" defaultValue={token.rotation} onBlur={(event) => { const value = Number(event.target.value); if (Number.isFinite(value) && value !== token.rotation) void updateToken(token, { rotation: value }); }} /></label><label>{t('tokenOpacity')}<input type="range" min="0" max="1" step="0.05" defaultValue={token.opacity} onBlur={(event) => { const value = Number(event.target.value); if (value !== token.opacity) void updateToken(token, { opacity: value }); }} /></label><label>{t('tokenOrder')}<input type="number" min="-100000" max="100000" defaultValue={token.zIndex} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value !== token.zIndex) void updateToken(token, { zIndex: value }); }} /></label><label><input type="checkbox" checked={token.showName} onChange={(event) => void updateToken(token, { showName: event.target.checked })} />{t('showTokenName')}</label><label><input type="checkbox" checked={token.locked} onChange={(event) => void updateToken(token, { locked: event.target.checked })} />{t(token.locked ? 'unlock' : 'lock')}</label><label><input type="checkbox" checked={Boolean(token.hidden)} onChange={(event) => void updateToken(token, { hidden: event.target.checked })} />{t('hideToken')}</label><label>{t('tokenOwner')}<select aria-label={`${t('tokenOwner')} ${token.name}`} value={token.ownerUserId ?? ''} onChange={(event) => void assignToken(token, event.target.value)}><option value="">GM controlled</option>{members.filter((member) => member.role === 'PLAYER').map((member) => <option value={member.userId} key={member.userId}>{member.displayName}</option>)}</select></label><button className="quiet-button token-delete-button" onClick={() => requestDeleteToken(token)}>{t('deleteToken')}</button><label>{t('gmNote')}<textarea maxLength={4000} defaultValue={token.gmNote ?? ''} onBlur={(event) => { if (event.target.value !== token.gmNote) void updateToken(token, { gmNote: event.target.value }); }} /></label><label>{t('ownerNote')}<textarea maxLength={4000} defaultValue={token.ownerNote ?? ''} onBlur={(event) => { if (event.target.value !== token.ownerNote) void updateToken(token, { ownerNote: event.target.value }); }} /></label>{token.resources.map((resource, index) => <fieldset className="token-resource-editor" key={index}><legend>{t('resource')} {index + 1}</legend><label>{t('resourceName')}<input defaultValue={resource?.label ?? `${t('resource')} ${index + 1}`} maxLength={24} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== resource?.label) void updateTokenResource(token, index as 0 | 1, { label: event.target.value }); }} /></label><div className="token-size-fields"><label>{t('currentValue')}<input type="number" min="0" max="9999" step="1" defaultValue={resource?.current ?? 0} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value !== resource?.current) void updateTokenResource(token, index as 0 | 1, { current: value }); }} /></label><label>{t('maximumValue')}<input type="number" min="0" max="9999" step="1" defaultValue={resource?.maximum ?? 0} onBlur={(event) => { const value = Number(event.target.value); if (Number.isInteger(value) && value !== resource?.maximum) void updateTokenResource(token, index as 0 | 1, { maximum: value }); }} /></label></div><label><input type="checkbox" checked={Boolean(resource?.visible)} onChange={(event) => void updateTokenResource(token, index as 0 | 1, { visible: event.target.checked })} />{t('visibleForPlayers')}</label><div className="token-resource-quick"><button className="quiet-button" disabled={!resource || resource.current <= 0} onClick={() => void adjustTokenResource(token, index as 0 | 1, -1)}>−</button><span>{resource?.current ?? 0} / {resource?.maximum ?? 0}</span><button className="quiet-button" disabled={!resource || resource.current >= resource.maximum} onClick={() => void adjustTokenResource(token, index as 0 | 1, 1)}>＋</button></div></fieldset>)}</details>)}</section>}{!canManage && tokens.some((token) => token.ownerUserId === user.id && token.ownerNote) && <section className="rail-section token-owner-notes"><div className="section-title">{t('tokenNotes')}</div>{tokens.filter((token) => token.ownerUserId === user.id && token.ownerNote).map((token) => <article key={token.id}><strong>{token.name}</strong><p>{token.ownerNote}</p></article>)}</section>}{tokens.some((token) => canManage || token.ownerUserId === user.id) && <section className="rail-section token-resource-controls"><div className="section-title">{t('resourceTracks')}</div>{tokens.filter((token) => canManage || token.ownerUserId === user.id).map((token) => <div className="owned-token-resources" key={token.id}><strong>{token.name}</strong>{token.resources.map((resource, index) => resource && <div className="token-resource-quick" key={index}><span>{resource.label}</span><button className="quiet-button" disabled={resource.current <= 0} onClick={() => void adjustTokenResource(token, index as 0 | 1, -1)}>−</button><span>{resource.current} / {resource.maximum}</span><button className="quiet-button" disabled={resource.current >= resource.maximum} onClick={() => void adjustTokenResource(token, index as 0 | 1, 1)}>＋</button></div>)}</div>)}</section>}{scene && <section className="rail-section initiative-section"><div className="section-title">⚑ {t('initiative')}</div>{initiative.tracker?.active ? <><p className="guide-copy">{t('initiativeRound', { round: initiative.tracker.round })}</p><div className="initiative-list">{initiative.entries.map((entry) => <div className={initiative.tracker?.currentEntryId === entry.id ? "initiative-row active" : "initiative-row"} key={entry.id}><span>{entry.label}</span><strong>{entry.score}</strong></div>)}</div>{canManage && <div className="initiative-actions"><button className="button secondary" disabled={initiativePending} onClick={() => void advanceInitiative()}>{t('initiativeNext')} ↗</button><button className="quiet-button" disabled={initiativePending} onClick={() => void stopInitiative()}>{t('initiativeStop')}</button></div>}</> : canManage ? <><p className="guide-copy">{t('initiativeHint')}</p>{tokens.map((token) => <label className="initiative-score" key={token.id}>{token.name}<input type="number" min="-9999" max="9999" value={initiativeScores[token.id] ?? "0"} onChange={(event) => setInitiativeScores((scores) => ({ ...scores, [token.id]: event.target.value }))} /></label>)}<button className="button secondary" disabled={initiativePending || !tokens.length} onClick={() => void startInitiative()}>{t('initiativeStart')}</button></> : <p className="guide-copy">{t('initiativeInactive')}</p>}</section>}<section className="rail-section roll-section"><div className="section-title">◉ Dice</div>{canManage && <label className="secret-roll-toggle"><input type="checkbox" aria-label={t('secretRoll')} checked={hiddenRoll} onChange={(event) => setHiddenRoll(event.target.checked)} />{t('secretRoll')}</label>}<button className="roll-button" onClick={rollDice} disabled={pendingRoll?.state === 'sending'} title={pendingRoll?.state === 'unknown' ? (i18n.language === 'ru' ? 'Повторить тот же запрос' : 'Retry the same request') : undefined}>d20 <span>{pendingRoll?.state === 'unknown' ? (i18n.language === 'ru' ? 'Повторить' : 'Retry') : t('roll')} ↗</span></button>{rolls.slice(-4).reverse().map((roll, i) => <div className="roll-row" key={`${roll.id ?? i}-${i}`}><span>{roll.displayName} rolled {roll.expression}{roll.hidden && <small> · {t('secretRoll')}</small>}</span><strong>{roll.result}</strong></div>)}</section><section className="rail-section chat-section"><div className="section-title">◌ {t('chat')}</div><select className="message-recipient" aria-label={t('chatRecipient')} value={messageRecipient} onChange={(event) => setMessageRecipient(event.target.value)}><option value="">{t('chatEveryone')}</option>{members.filter((member) => member.userId !== user.id && (canManage || member.role === 'OWNER' || member.role === 'GM')).map((member) => <option key={member.userId} value={member.userId}>Private · {member.displayName}</option>)}</select><div className="chat-messages">{messages.map((message) => <div className={`chat-message ${message.private ? 'private' : ''}`} key={message.id}><strong>{message.private ? '🔒 ' : ''}{message.displayName}</strong><p>{message.body}</p></div>)}</div><form className="chat-compose" onSubmit={sendChat}><input value={chatText} disabled={Boolean(pendingChat)} onChange={(e) => setChatText(e.target.value)} maxLength={2000} placeholder={t('chatPlaceholder')} /><button aria-label={pendingChat?.state === 'unknown' ? (i18n.language === 'ru' ? 'Безопасно повторить' : 'Retry safely') : t('send')} disabled={pendingChat?.state === 'sending'}>{pendingChat?.state === 'unknown' ? (i18n.language === 'ru' ? 'Повторить' : 'Retry') : '↗'}</button></form>{pendingChat && <small role="status">{pendingChat.state === 'sending' ? (i18n.language === 'ru' ? 'Отправка…' : 'Sending…') : (i18n.language === 'ru' ? 'Исход неизвестен. Повтор использует тот же ID.' : 'Outcome unknown. Retry uses the same ID.')}</small>}</section></>}</aside></div>
      {error && <button className="toast-error" onClick={() => setError('')}>{error === 'OUTCOME_UNKNOWN' ? t('outcomeUnknown') : error} ×</button>}
      {notice && <button className="toast-notice" onClick={() => setNotice('')}>{notice} ×</button>}
      {tokenTrashOpen && <div className="modal-backdrop" onClick={() => setTokenTrashOpen(false)}><section className="dialog-card" onClick={(event) => event.stopPropagation()}><header><div><p className="eyebrow">{t('tokenTrash')}</p><h2>{campaign.campaign.title}</h2></div><button className="quiet-button" onClick={() => setTokenTrashOpen(false)}>×</button></header><div className="token-trash-list">{deletedTokens.map((item) => <article key={item.id}><div><strong>{item.name}</strong><small>{item.sceneTitle}</small></div><button className="button secondary" disabled={Boolean(item.sceneArchivedAt)} onClick={() => void restoreToken(item)}>{t('restoreToken')}</button></article>)}{deletedTokens.length === 0 && <p className="empty-state">{t('tokenTrashEmpty')}</p>}</div></section></div>}
      {assetLibraryOpen && <div className="modal-backdrop" onClick={() => setAssetLibraryOpen(false)} onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-nri-token-asset')) event.preventDefault(); }} onDrop={dropAssets}><section className="dialog-card asset-library-dialog" onClick={(event) => event.stopPropagation()}><header><div><p className="eyebrow">{t('assetLibrary')}</p><h2>{campaign.campaign.title}</h2></div><button className="quiet-button" onClick={() => setAssetLibraryOpen(false)}>×</button></header><div className="asset-library-tools"><p className="asset-storage-summary">{t('assetStorage')}: {(assetStorageBytes / 1024 / 1024).toFixed(2)} MB · {assets.length}</p><input aria-label={t('assetSearch')} placeholder={t('assetSearch')} value={assetSearch} onChange={(event) => setAssetSearch(event.target.value)} /><select aria-label={t('assetCategory')} value={assetCategoryFilter} onChange={(event) => setAssetCategoryFilter(event.target.value)}><option value="ALL">{t('allCategories')}</option><option value="MAP">{t('assetMap')}</option><option value="TOKEN">{t('assetToken')}</option><option value="DECORATION">{t('assetDecoration')}</option><option value="PORTRAIT">{t('assetPortrait')}</option><option value="OTHER">{t('assetOther')}</option></select><select aria-label={t('assetSort')} value={assetSort} onChange={(event) => setAssetSort(event.target.value as 'NAME' | 'SIZE')}><option value="NAME">{t('sortByName')}</option><option value="SIZE">{t('sortBySize')}</option></select><select aria-label={t('uploadCategory')} value={assetUploadCategory} onChange={(event) => setAssetUploadCategory(event.target.value as CampaignAsset['category'])}><option value="MAP">{t('assetMap')}</option><option value="TOKEN">{t('assetToken')}</option><option value="DECORATION">{t('assetDecoration')}</option><option value="PORTRAIT">{t('assetPortrait')}</option><option value="OTHER">{t('assetOther')}</option></select><input ref={assetInput} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={uploadAssets} /><button className="button primary" onClick={() => assetInput.current?.click()}>{t('uploadAssets')}</button></div><div className="asset-folder-toolbar"><select aria-label={t('assetFolderFilter')} value={assetFolderFilter} onChange={(event) => setAssetFolderFilter(event.target.value)}><option value="ALL">{t('allFolders')}</option><option value="ROOT">{t('folderRoot')}</option>{assetFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select><input aria-label={t('newAssetFolder')} placeholder={t('newAssetFolder')} value={newAssetFolderName} maxLength={48} onChange={(event) => setNewAssetFolderName(event.target.value)} /><button type="button" className="button secondary" disabled={!newAssetFolderName.trim()} onClick={() => void createAssetFolder()}>{t('createAssetFolder')}</button>{assetFolders.find((folder) => folder.id === assetFolderFilter) && <><button type="button" className="quiet-button" onClick={() => void renameAssetFolder(assetFolders.find((folder) => folder.id === assetFolderFilter)!)}>{t('renameAssetFolder')}</button><button type="button" className="quiet-button" onClick={() => void deleteAssetFolder(assetFolders.find((folder) => folder.id === assetFolderFilter)!)}>{t('deleteAssetFolder')}</button></>}</div><div className={`asset-drop-zone${assetDropActive ? ' active' : ''}`} data-testid="asset-drop-zone" onDragOver={(event) => { event.preventDefault(); setAssetDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setAssetDropActive(false); }} onDrop={dropAssets}><span>{t('uploadAssets')}</span></div><div className="asset-library-grid">{visibleAssets.map((asset) => <article className="asset-card" key={asset.id} draggable={canManage && asset.category === 'TOKEN'} onDragStart={(event) => { if (asset.category !== 'TOKEN') return; event.dataTransfer.setData('application/x-nri-token-asset', asset.id); event.dataTransfer.effectAllowed = 'copy'; }} title={asset.category === 'TOKEN' ? t('dragTokenToTable') : undefined}><a className="asset-preview-link" href={`/api/assets/${asset.id}`} target="_blank" rel="noreferrer"><img src={`/api/assets/${asset.id}?variant=thumbnail`} alt={asset.name} loading="lazy" /></a><label>{t('assetName')}<input defaultValue={asset.name} maxLength={120} onBlur={(event) => { if (event.target.value.trim() && event.target.value !== asset.name) void updateAsset(asset, { name: event.target.value }); }} /></label><label>{t('assetCategory')}<select value={asset.category} onChange={(event) => void updateAsset(asset, { category: event.target.value as CampaignAsset['category'] })}><option value="MAP">{t('assetMap')}</option><option value="TOKEN">{t('assetToken')}</option><option value="DECORATION">{t('assetDecoration')}</option><option value="PORTRAIT">{t('assetPortrait')}</option><option value="OTHER">{t('assetOther')}</option></select></label><label>{t('assetFolder')}<select aria-label={`${t('assetFolder')}: ${asset.name}`} value={asset.folderId ?? ''} onChange={(event) => void updateAsset(asset, { folderId: event.target.value || null })}><option value="">{t('folderRoot')}</option>{assetFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></label><small>{(asset.size / 1024 / 1024).toFixed(2)} MB · {t('assetUsage', { count: asset.usageCount })}</small>{canManage && <button className="quiet-button" disabled={!scene || !activeLayerId || layers.find((layer) => layer.id === activeLayerId)?.locked || layers.find((layer) => layer.id === activeLayerId)?.kind === 'BACKGROUND'} onClick={() => void addSceneObject('IMAGE', asset.id)}>{t('addToScene')}</button>}{asset.usageCount === 0 && <button className="quiet-button" onClick={() => void deleteAsset(asset)}>{t('deleteUnusedAsset')}</button>}</article>)}</div>{visibleAssets.length === 0 && <p className="empty-state">{t('noAssets')}</p>}</section></div>}
      {sceneDialog === 'create' && <div className="modal-backdrop"><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void addScene(); }}><p className="eyebrow">{t('newLocation')}</p><h2>{t('addScene')}</h2><label>{t('sceneName')}<input autoFocus value={sceneTitle} onChange={(event) => setSceneTitle(event.target.value)} maxLength={80} required /></label><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => { setSceneTitle(''); setSceneDialog(null); }}>{t('cancel')}</button><button className="button primary">{t('create')}</button></div></form></div>}
      {sceneDialog === 'rename' && <div className="modal-backdrop"><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void renameScene(); }}><p className="eyebrow">SCENE</p><h2>{t('renameScene')} {t('scene').toLowerCase()}</h2><label>{t('sceneName')}<input autoFocus value={sceneTitle} onChange={(event) => setSceneTitle(event.target.value)} maxLength={80} required /></label><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setSceneDialog(null)}>{t('cancel')}</button><button className="button primary">{t('save')}</button></div></form></div>}
      {sceneDialog === 'grid' && scene && <div className="modal-backdrop"><form className="dialog-card settings-dialog" onSubmit={(event) => void saveGridSettings(event)}><p className="eyebrow">{t('sceneSettings')}</p><h2>{t('gridSettings')}</h2><div className="settings-grid"><label>{t('cellSize')}<input name="gridSize" type="number" min="8" max="256" defaultValue={scene.gridSize} required /></label><label>{t('gridColor')}<input name="gridColor" type="color" defaultValue={scene.gridColor} /></label><label>{t('opacity')}<input name="gridOpacity" type="number" min="0" max="1" step="0.05" defaultValue={scene.gridOpacity} required /></label><label>{t('offsetX')}<input name="gridOffsetX" type="number" step="0.5" defaultValue={scene.gridOffsetX} required /></label><label>{t('offsetY')}<input name="gridOffsetY" type="number" step="0.5" defaultValue={scene.gridOffsetY} required /></label><label>{t('sceneWidth')}<input name="width" type="number" min="256" max="16384" step="128" defaultValue={scene.width} required /></label><label>{t('sceneHeight')}<input name="height" type="number" min="256" max="16384" step="128" defaultValue={scene.height} required /></label><label>{t('distancePerCell')}<input name="unitsPerCell" type="number" min="0.01" max="100000" step="0.5" defaultValue={scene.unitsPerCell} required /></label><label>{t('unitLabel')}<input name="unitLabel" maxLength={24} defaultValue={scene.unitLabel} required /></label><label>{t('cameraCenterX')}<input name="cameraX" type="number" min="-32768" max="32768" step="1" defaultValue={scene.cameraX} required /></label><label>{t('cameraCenterY')}<input name="cameraY" type="number" min="-32768" max="32768" step="1" defaultValue={scene.cameraY} required /></label><label>{t('cameraZoom')}<input name="cameraZoom" type="number" min="0.25" max="4" step="0.05" defaultValue={scene.cameraZoom} required /></label><label className="check-setting"><input name="gridEnabled" type="checkbox" defaultChecked={scene.gridEnabled} /> {t('showGrid')}</label><label className="check-setting"><input name="snapToGrid" type="checkbox" defaultChecked={scene.snapToGrid} /> {t('snapGrid')}</label></div><button type="button" className="button secondary calibration-start" disabled={!scene.backgroundAssetId} onClick={startGridCalibration}>{t('calibrateGrid')}</button><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => setSceneDialog(null)}>{t('cancel')}</button><button className="button primary">{t('saveSettings')}</button></div></form></div>}
      {calibrationDialog && calibrationDistance !== null && <div className="modal-backdrop"><div className="dialog-card calibration-dialog"><p className="eyebrow">{t('sceneSettings')}</p><h2>{t('calibrateGrid')}</h2><p>{t('calibrationMeasure')}</p><label>{t('calibrationDistance')}<output>{Math.round(calibrationDistance)} px</output></label><label>{t('calibrationCells')}<input type="number" min="1" max="100" step="1" value={calibrationCellCount} onChange={(event) => setCalibrationCellCount(event.target.value)} /></label><p className="calibration-preview">{gridPreviewSize === null ? t('calibrationOutOfRange') : `${t('previewCellSize')}: ${gridPreviewSize}px`}</p><div className="settings-grid calibration-offsets"><label>{t('offsetX')}<input type="number" step="0.5" value={gridPreviewOffsetX ?? 0} onChange={(event) => setGridPreviewOffsetX(Number(event.target.value))} /></label><label>{t('offsetY')}<input type="number" step="0.5" value={gridPreviewOffsetY ?? 0} onChange={(event) => setGridPreviewOffsetY(Number(event.target.value))} /></label></div><div className="dialog-actions"><button className="button secondary" onClick={() => { setCalibrationDialog(false); setCalibrationDistance(null); setGridPreviewSize(null); setGridPreviewOffsetX(null); setGridPreviewOffsetY(null); }}>{t('cancel')}</button><button className="button primary" disabled={gridPreviewSize === null} onClick={() => void saveCalibratedGrid()}>{t('saveSettings')}</button></div></div></div>}
      {confirmAction && <div className="modal-backdrop"><div className="dialog-card"><p className="eyebrow">{t('confirmChange')}</p><h2>{confirmText}</h2><div className="dialog-actions"><button className="button secondary" onClick={() => setConfirmAction(null)}>{t('cancel')}</button><button className="button primary" onClick={() => confirmAction()}>{t('confirm')}</button></div></div></div>}
      {sceneMenu && <div className="scene-context-backdrop" onClick={() => setSceneMenu(null)} onContextMenu={(event) => { event.preventDefault(); setSceneMenu(null); }}><div className="scene-context-menu" style={{ left: Math.min(sceneMenu.x, window.innerWidth - 190), top: Math.min(sceneMenu.y, window.innerHeight - 250) }} onClick={(event) => event.stopPropagation()}><button onClick={() => { setSceneTitle(sceneMenu.scene.title); setSceneDialog('rename'); setSceneMenu(null); }}>{t('renameScene')}</button><button onClick={() => { void duplicateScene(sceneMenu.scene); setSceneMenu(null); }}>{t('duplicateAsDraft')}</button><button onClick={() => { const target = sceneMenu.scene; setSceneMenu(null); if (scene?.id === target.id) setSceneDialog('grid'); else void openScene(target).then(() => setSceneDialog('grid')); }}>{t('gridSettings')}</button><button disabled={sceneMenu.scene.isActive} onClick={() => { activateScene(sceneMenu.scene); setSceneMenu(null); }}>{t('makeActive')}</button><button onClick={() => { void archiveScene(sceneMenu.scene); setSceneMenu(null); }}>{t('archive')}</button></div></div>}
    </section>}
  </main>;
}
