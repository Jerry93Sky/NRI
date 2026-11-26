import { useEffect, useRef } from 'react';
import { Application, Assets, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { Texture } from 'pixi.js';
import type { PublicToken } from '@nri/contracts';
import { measureSceneDistance, selectTokenIdsInRect, zoomToPointer } from './canvasMath';

type Props = {
  tokens: PublicToken[]; objects: Array<{ id: string; layerId: string; kind: string; x: number; y: number; width: number; height: number; rotation: number; opacity: number; zIndex: number; assetId: string | null; color: string | null; strokeWidth: number | null; points: Array<{ x: number; y: number }> | null; text: string | null; visible: boolean; locked: boolean }>; canManage: boolean; activeLayerId: string; layerSortOrder: Record<string, number>; canEditObject: (object: Props['objects'][number]) => boolean; onEditObject: (id: string, patch: { x?: number; y?: number; width?: number; height?: number }) => void; gridSize: number; gridColor: string; gridOpacity: number; gridOffsetX: number; gridOffsetY: number; gridEnabled: boolean; snapToGrid: boolean;
  backgroundUrl?: string | undefined; sceneId: string; sceneWidth: number; sceneHeight: number; cameraX: number; cameraY: number; cameraZoom: number; unitsPerCell: number; unitLabel: string;
  onMove: (token: PublicToken, x: number, y: number) => void; onMoveGroup: (tokenIds: string[], deltaX: number, deltaY: number) => void; selectedTokenIds: string[]; canEdit: (token: PublicToken) => boolean; onDropTokenAsset: (assetId: string, x: number, y: number) => void; fitLabel: string; rulerActive: boolean; rulerLabel: string; selectionMode: boolean; selectionLabel: string; onSelectTokens: (ids: string[]) => void; pointerActive: boolean; pointerLabel: string; onSharePointer: (x: number, y: number) => void; drawMode: boolean; onCreateDrawing: (points: Array<{ x: number; y: number }>) => void;
  calibrationActive: boolean; gridPreviewSize: number | null; gridPreviewOffsetX: number | null; gridPreviewOffsetY: number | null; onCalibrationComplete: (start: { x: number; y: number }, end: { x: number; y: number }) => void;
};

export function TableCanvas(props: Props) {
  const { tokens, gridSize, gridColor, gridOpacity, gridOffsetX, gridOffsetY, gridEnabled, snapToGrid, backgroundUrl, sceneId, sceneWidth, sceneHeight, cameraX, cameraY, cameraZoom, onMove, canEdit } = props;
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;

  useEffect(() => {
    let cancelled = false;
    let initialized = false;
    let destroyed = false;
    let previousSceneId = '';
    const app = new Application();
    const world = new Container();
    const base = new Graphics().rect(-20000, -20000, 40000, 40000).fill({ color: 0x222421 });
    const mapLayer = new Container();
    const grid = new Graphics();
    const rulerDisplay = new Container();
    const selectionDisplay = new Graphics();
    const objectsDisplay = new Container();
    const pieces = new Container();
    const pointerDisplay = new Container();
    const tokenTextures = new Map<string, Texture>();
    const pendingTokenTextures = new Set<string>();
    const objectTextures = new Map<string, Texture>();
    const pendingObjectTextures = new Set<string>();
    let refresh = () => {};
    world.addChild(base, mapLayer, grid, rulerDisplay, objectsDisplay, pieces, selectionDisplay, pointerDisplay);
    app.stage.addChild(world);
    app.stage.eventMode = 'static';

    const fitScene = () => {
      const { sceneWidth: width, sceneHeight: height } = latest.current;
      const scale = Math.max(0.1, Math.min(4, Math.min(app.screen.width / width, app.screen.height / height) * 0.9));
      world.scale.set(scale);
      world.position.set((app.screen.width - width * scale) / 2, (app.screen.height - height * scale) / 2);
    };
    const restoreCamera = () => {
      const { cameraX: x, cameraY: y, cameraZoom: zoom, sceneWidth: width, sceneHeight: height } = latest.current;
      if (x === 0 && y === 0) { fitScene(); return; }
      const scale = Math.max(0.25, Math.min(2.2, zoom));
      world.scale.set(scale);
      world.position.set(app.screen.width / 2 - x * scale, app.screen.height / 2 - y * scale);
      if (!Number.isFinite(width + height)) fitScene();
    };
    const redrawGrid = () => {
      grid.clear();
      const { gridSize: size, gridColor: color, gridOpacity: opacity, gridOffsetX: offsetX, gridOffsetY: offsetY, gridEnabled: enabled } = latest.current;
      if (!enabled) return;
      const gridCellSize = latest.current.gridPreviewSize ?? size;
      const gridX = latest.current.gridPreviewOffsetX ?? offsetX;
      const gridY = latest.current.gridPreviewOffsetY ?? offsetY;
      const { sceneWidth: width, sceneHeight: height } = latest.current;
      const ox = ((gridX % gridCellSize) + gridCellSize) % gridCellSize;
      const oy = ((gridY % gridCellSize) + gridCellSize) % gridCellSize;
      const startX = ox === 0 ? 0 : ox - gridCellSize; const startY = oy === 0 ? 0 : oy - gridCellSize;
      for (let x = startX; x <= width; x += gridCellSize) grid.moveTo(x, 0).lineTo(x, height);
      for (let y = startY; y <= height; y += gridCellSize) grid.moveTo(0, y).lineTo(width, y);
      grid.stroke({ color: Number.parseInt(color.slice(1), 16) || 0x44453e, alpha: opacity, width: 1 });
    };
    const redrawObjects = () => {
      objectsDisplay.removeChildren().forEach((child) => child.destroy({ children: true }));
      const colorOf = (value: string | null) => Number.parseInt((value ?? '#c8794a').slice(1), 16) || 0xc8794a;
      for (const item of latest.current.objects.toSorted((a, b) => (latest.current.layerSortOrder[a.layerId] ?? 0) - (latest.current.layerSortOrder[b.layerId] ?? 0) || a.zIndex - b.zIndex || a.y - b.y || a.x - b.x)) {
        if (!item.visible && !latest.current.canManage) continue;
        const alpha = item.opacity * (item.visible ? 1 : 0.35);
        const color = colorOf(item.color);
        const shape = new Graphics(); shape.position.set(item.x + item.width / 2, item.y + item.height / 2); shape.rotation = item.rotation * Math.PI / 180; shape.alpha = alpha;
        if (item.kind === 'RECTANGLE') shape.rect(-item.width / 2, -item.height / 2, item.width, item.height).fill({ color }).stroke({ color, alpha: Math.min(alpha + 0.2, 1), width: item.strokeWidth ?? 1 });
        else if (item.kind === 'ELLIPSE') shape.ellipse(0, 0, item.width / 2, item.height / 2).fill({ color }).stroke({ color, alpha: Math.min(alpha + 0.2, 1), width: item.strokeWidth ?? 1 });
        else if ((item.kind === 'LINE' || item.kind === 'FREEHAND') && item.points?.length) {
          shape.moveTo(item.points[0]!.x - item.width / 2, item.points[0]!.y - item.height / 2);
          for (const point of item.points.slice(1)) shape.lineTo(point.x - item.width / 2, point.y - item.height / 2);
          shape.stroke({ color, alpha: 1, width: item.strokeWidth ?? 2 });
        } else if (item.kind === 'IMAGE' && item.assetId) {
          const texture = objectTextures.get(item.assetId);
          if (texture) {
            const image = new Sprite(texture); image.anchor.set(0.5); image.width = item.width; image.height = item.height; shape.addChild(image);
          } else {
            shape.rect(-item.width / 2, -item.height / 2, item.width, item.height).fill({ color, alpha: 0.22 }).stroke({ color, alpha: 1, width: 1 });
            if (!pendingObjectTextures.has(item.assetId)) {
              pendingObjectTextures.add(item.assetId);
              const assetId = item.assetId;
              void Assets.load(`/api/assets/${assetId}`).then((texture) => {
                objectTextures.set(assetId, texture);
                pendingObjectTextures.delete(assetId);
                if (!cancelled && latest.current.objects.some((current) => current.id === item.id && current.assetId === assetId && (current.visible || latest.current.canManage))) refresh();
              }).catch(() => pendingObjectTextures.delete(assetId));
            }
          }
        } else if (item.kind === 'TEXT' && item.text) {
          const label = new Text({ text: item.text, style: { fontFamily: 'Arial', fontSize: Math.min(48, Math.max(12, item.height * 0.42)), fill: color, align: 'center', wordWrap: true, wordWrapWidth: Math.max(8, item.width - 12) } });
          label.anchor.set(0.5); shape.addChild(label);
        }
        else continue;
        if (latest.current.canEditObject(item)) {
          shape.eventMode = 'static'; shape.cursor = 'grab';
          shape.on('pointerdown', (event) => {
            if (latest.current.pointerActive) { event.stopPropagation(); return; }
            event.stopPropagation();
            const start = world.toLocal(event.global); const originalX = item.x; const originalY = item.y;
            const move = (moveEvent: typeof event) => { const point = world.toLocal(moveEvent.global); shape.position.set(originalX + point.x - start.x + item.width / 2, originalY + point.y - start.y + item.height / 2); };
            const finish = () => {
              app.stage.off('globalpointermove', move); app.stage.off('pointerup', finish); app.stage.off('pointerupoutside', finish); shape.cursor = 'grab';
              const nextX = Math.round(shape.x - item.width / 2); const nextY = Math.round(shape.y - item.height / 2);
              if (nextX !== originalX || nextY !== originalY) latest.current.onEditObject(item.id, { x: nextX, y: nextY });
            };
            shape.cursor = 'grabbing'; app.stage.on('globalpointermove', move); app.stage.on('pointerup', finish); app.stage.on('pointerupoutside', finish);
          });
          const resizeHandle = new Graphics().rect(-6, -6, 12, 12).fill({ color: 0xf3c78b }).stroke({ color: 0x342a24, width: 1 });
          resizeHandle.position.set(item.width / 2, item.height / 2); resizeHandle.eventMode = 'static'; resizeHandle.cursor = 'nwse-resize';
          resizeHandle.on('pointerdown', (event) => {
            if (latest.current.pointerActive) { event.stopPropagation(); return; }
            event.stopPropagation();
            const move = (moveEvent: typeof event) => { const point = shape.toLocal(moveEvent.global); resizeHandle.position.set(Math.max(4, point.x), Math.max(4, point.y)); };
            const finish = (finishEvent: typeof event) => {
              app.stage.off('globalpointermove', move); app.stage.off('pointerup', finish); app.stage.off('pointerupoutside', finish);
              const point = shape.toLocal(finishEvent.global); const width = Math.max(8, Math.round(point.x * 2)); const height = Math.max(8, Math.round(point.y * 2));
              const x = Math.round(shape.x - width / 2); const y = Math.round(shape.y - height / 2);
              if (width !== item.width || height !== item.height) latest.current.onEditObject(item.id, { x, y, width, height });
            };
            app.stage.on('globalpointermove', move); app.stage.on('pointerup', finish); app.stage.on('pointerupoutside', finish);
          });
          shape.addChild(resizeHandle);
        }
        objectsDisplay.addChild(shape);
      }
    };
    const redrawMap = async () => {
      mapLayer.removeChildren().forEach((child) => child.destroy({ children: true }));
      const sourceUrl = latest.current.backgroundUrl;
      if (!sourceUrl) return;
      try {
        const texture = await Assets.load(sourceUrl);
        if (cancelled || latest.current.backgroundUrl !== sourceUrl) return;
        const image = new Sprite(texture); image.width = latest.current.sceneWidth; image.height = latest.current.sceneHeight;
        mapLayer.addChild(image);
      } catch { /* A missing or revoked asset leaves the neutral canvas visible. */ }
    };
    const redrawTokens = () => {
      pieces.removeChildren().forEach((child) => child.destroy({ children: true }));
      latest.current.tokens.toSorted((a, b) => a.zIndex - b.zIndex || a.y - b.y || a.x - b.x).forEach((token) => {
        const size = latest.current.gridSize;
        const node = new Container(); node.position.set(token.x * size, token.y * size); node.rotation = token.rotation * Math.PI / 180; node.alpha = token.opacity;
        const width = size * token.width; const height = size * token.height;
        const disc = new Graphics().ellipse(0, 0, width * 0.42, height * 0.42).fill(token.color).stroke({ color: Number.parseInt(token.borderColor.slice(1), 16), alpha: 0.9, width: Math.max(1, size * 0.04) });
        node.addChild(disc);
        if (token.imageAssetId) {
          const imageUrl = `/api/assets/${token.imageAssetId}`;
          const texture = tokenTextures.get(token.imageAssetId);
          if (texture) {
            const mask = new Graphics().ellipse(0, 0, width * 0.42, height * 0.42).fill({ color: 0xffffff });
            const portrait = new Sprite(texture); portrait.anchor.set(0.5); portrait.width = width * 0.84; portrait.height = height * 0.84; portrait.mask = mask; node.addChild(portrait, mask);
          } else if (!pendingTokenTextures.has(token.imageAssetId)) {
            pendingTokenTextures.add(token.imageAssetId);
            void Assets.load(imageUrl).then((loaded) => {
              tokenTextures.set(token.imageAssetId!, loaded);
              pendingTokenTextures.delete(token.imageAssetId!);
              if (!cancelled && latest.current.tokens.some((current) => current.imageAssetId === token.imageAssetId)) refresh();
            }).catch(() => pendingTokenTextures.delete(token.imageAssetId!));
          }
        }
        const border = new Graphics().ellipse(0, 0, width * 0.42, height * 0.42).stroke({ color: Number.parseInt(token.borderColor.slice(1), 16), alpha: 0.9, width: Math.max(1, size * 0.04) }); node.addChild(border);
        if (token.showName) { const label = new Text({ text: token.name, style: { fontFamily: 'Arial', fontSize: Math.max(10, size * 0.25), fill: 0xf5eadc, align: 'center' } }); label.anchor.set(0.5, -2); label.y = height * 0.45; node.addChild(label); }
        const resourceText = token.resources.filter((resource) => resource !== null).map((resource) => `${resource.label} ${resource.current}/${resource.maximum}`).join(' · ');
        if (resourceText) { const resourceLabel = new Text({ text: resourceText, style: { fontFamily: 'Arial', fontSize: Math.max(8, size * 0.16), fill: 0xd8c6a9, align: 'center' } }); resourceLabel.anchor.set(0.5, 0); resourceLabel.y = height * 0.45 + Math.max(10, size * 0.24); node.addChild(resourceLabel); }
        node.eventMode = 'static'; node.cursor = latest.current.canEdit(token) && !token.locked ? 'grab' : 'default';
        node.on('pointerdown', (event) => {
          if (latest.current.pointerActive) { event.stopPropagation(); return; }
          if (!latest.current.canEdit(token) || token.locked) return;
          event.stopPropagation(); node.cursor = 'grabbing';
          if (latest.current.canManage && latest.current.selectionMode) { node.cursor = 'default'; return; }
          const start = event.global.clone(); const origin = node.position.clone();
          const groupTokens = latest.current.canManage && latest.current.selectedTokenIds.includes(token.id) ? latest.current.tokens.filter((item) => latest.current.selectedTokenIds.includes(item.id) && latest.current.canEdit(item) && !item.locked) : [];
          const groupNodes = groupTokens.length > 1 ? [...pieces.children].filter((child) => groupTokens.some((item) => item.id === (child as Container).label)) as Container[] : [];
          const groupOrigins = groupNodes.map((child) => child.position.clone());
          const move = (moveEvent: typeof event) => { const point = moveEvent.global; const dx = point.x - start.x; const dy = point.y - start.y; node.position.set(origin.x + dx, origin.y + dy); groupNodes.forEach((child, index) => child.position.set(groupOrigins[index]!.x + dx, groupOrigins[index]!.y + dy)); };
          const up = () => {
            app.stage.off('globalpointermove', move); app.stage.off('pointerup', up); app.stage.off('pointerupoutside', up); node.cursor = 'grab';
            const { gridSize: cellSize, snapToGrid: snap } = latest.current;
            const x = node.x / cellSize; const y = node.y / cellSize;
            const nextX = snap ? Math.round(x) : Number(x.toFixed(2)); const nextY = snap ? Math.round(y) : Number(y.toFixed(2));
            if (groupTokens.length > 1) { const deltaX = (snap ? Math.round(nextX - token.x) : Number((nextX - token.x).toFixed(2))); const deltaY = (snap ? Math.round(nextY - token.y) : Number((nextY - token.y).toFixed(2))); if (deltaX || deltaY) latest.current.onMoveGroup(groupTokens.map((item) => item.id), deltaX, deltaY); }
            else if (nextX !== token.x || nextY !== token.y) latest.current.onMove(token, nextX, nextY);
          };
          app.stage.on('globalpointermove', move); app.stage.on('pointerup', up); app.stage.on('pointerupoutside', up);
        });
        node.label = token.id; pieces.addChild(node);
      });
    };
    const rulerPoints: Array<{ x: number; y: number }> = [];
    type SharedPointer = { pointerId: string; sceneId: string; displayName: string; x: number; y: number };
    const remotePointers = new Map<string, SharedPointer>();
    const pointerTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const clearRemotePointers = () => {
      for (const timer of pointerTimers.values()) clearTimeout(timer);
      pointerTimers.clear(); remotePointers.clear(); pointerDisplay.removeChildren().forEach((child) => child.destroy({ children: true }));
    };
    const redrawPointers = () => {
      pointerDisplay.removeChildren().forEach((child) => child.destroy({ children: true }));
      for (const pointer of remotePointers.values()) {
        const marker = new Container(); marker.position.set(pointer.x, pointer.y);
        const crosshair = new Graphics().circle(0, 0, 9).stroke({ color: 0xf3c78b, width: 2 }).moveTo(-13, 0).lineTo(13, 0).moveTo(0, -13).lineTo(0, 13).stroke({ color: 0xf3c78b, width: 2 });
        const label = new Text({ text: pointer.displayName, style: { fontFamily: 'Arial', fontSize: 12, fill: 0xf3c78b, stroke: { color: 0x222421, width: 3 } } });
        label.position.set(12, -8); marker.addChild(crosshair, label); pointerDisplay.addChild(marker);
      }
    };
    const receiveSharedPointer = (event: Event) => {
      const pointer = (event as CustomEvent<SharedPointer>).detail;
      if (!pointer || pointer.sceneId !== latest.current.sceneId) return;
      remotePointers.set(pointer.pointerId, pointer);
      const previous = pointerTimers.get(pointer.pointerId); if (previous) clearTimeout(previous);
      pointerTimers.set(pointer.pointerId, setTimeout(() => { pointerTimers.delete(pointer.pointerId); remotePointers.delete(pointer.pointerId); redrawPointers(); }, 1600));
      redrawPointers();
    };
    const clearSelectionBox = () => { selectionDisplay.clear(); };
    const redrawRuler = () => {
      rulerDisplay.removeChildren().forEach((child) => child.destroy({ children: true }));
      if (!latest.current.rulerActive || rulerPoints.length === 0) return;
      const line = new Graphics().moveTo(rulerPoints[0]!.x, rulerPoints[0]!.y);
      for (const point of rulerPoints.slice(1)) line.lineTo(point.x, point.y);
      line.stroke({ color: 0xf3c78b, width: 2 / world.scale.x });
      rulerDisplay.addChild(line);
      const last = rulerPoints[rulerPoints.length - 1]!;
      const distance = measureSceneDistance(rulerPoints, latest.current.gridSize, latest.current.unitsPerCell);
      const label = new Text({ text: `${distance.toFixed(1)} ${latest.current.unitLabel}`, style: { fontFamily: 'Arial', fontSize: 16 / world.scale.x, fill: 0xf3c78b, stroke: { color: 0x222421, width: 4 / world.scale.x } } });
      label.anchor.set(0.5, 1);
      label.position.set(last.x, last.y - 8 / world.scale.x);
      rulerDisplay.addChild(label);
    };
    refresh = () => {
      if (latest.current.sceneId !== previousSceneId) { previousSceneId = latest.current.sceneId; rulerPoints.length = 0; clearSelectionBox(); clearRemotePointers(); restoreCamera(); }
      if (!latest.current.rulerActive) rulerPoints.length = 0;
      if (!latest.current.selectionMode) clearSelectionBox();
      redrawGrid(); redrawRuler(); redrawObjects(); redrawTokens(); redrawPointers(); void redrawMap();
    };
    const fit = () => fitScene();
    const calibrationPoints: Array<{ x: number; y: number }> = [];
    const onCalibrationClick = (event: { global: { x: number; y: number } }) => {
      if (!latest.current.calibrationActive || latest.current.pointerActive) { calibrationPoints.length = 0; return; }
      const point = world.toLocal(event.global);
      calibrationPoints.push({ x: point.x, y: point.y });
      if (calibrationPoints.length === 2) {
        latest.current.onCalibrationComplete(calibrationPoints[0]!, calibrationPoints[1]!);
        calibrationPoints.length = 0;
      }
    };
    const onRulerClick = (event: { global: { x: number; y: number } }) => {
      if (!latest.current.rulerActive || latest.current.calibrationActive || latest.current.pointerActive) return;
      rulerPoints.push(world.toLocal(event.global));
      redrawRuler();
    };
    const onSelectionStart = (event: { global: { x: number; y: number }; stopPropagation: () => void }) => {
      if (!latest.current.canManage || !latest.current.selectionMode || latest.current.calibrationActive || latest.current.pointerActive) return;
      event.stopPropagation();
      const start = world.toLocal(event.global);
      let current = start;
      const redraw = () => {
        const x = Math.min(start.x, current.x); const y = Math.min(start.y, current.y);
        const width = Math.abs(current.x - start.x); const height = Math.abs(current.y - start.y);
        selectionDisplay.clear().rect(x, y, width, height).fill({ color: 0xf3c78b, alpha: 0.14 }).stroke({ color: 0xf3c78b, alpha: 0.9, width: 1.5 / world.scale.x });
      };
      const move = (moveEvent: { global: { x: number; y: number } }) => { current = world.toLocal(moveEvent.global); redraw(); };
      const finish = () => {
        app.stage.off('globalpointermove', move); app.stage.off('pointerup', finish); app.stage.off('pointerupoutside', finish);
        const rect = { x: start.x, y: start.y, width: current.x - start.x, height: current.y - start.y };
        clearSelectionBox();
        if (Math.abs(rect.width) + Math.abs(rect.height) > 4) latest.current.onSelectTokens(selectTokenIdsInRect(latest.current.tokens, latest.current.gridSize, rect));
      };
      app.stage.on('globalpointermove', move); app.stage.on('pointerup', finish); app.stage.on('pointerupoutside', finish);
    };
    const onDrawStart = (event: { global: { x: number; y: number }; stopPropagation: () => void }) => {
      if (!latest.current.drawMode || latest.current.calibrationActive || latest.current.pointerActive) return;
      event.stopPropagation();
      const points = [world.toLocal(event.global)];
      const preview = new Graphics(); world.addChild(preview);
      const redraw = () => { preview.clear().moveTo(points[0]!.x, points[0]!.y); for (const point of points.slice(1)) preview.lineTo(point.x, point.y); preview.stroke({ color: 0xf3c78b, width: 3 }); };
      const move = (moveEvent: { global: { x: number; y: number } }) => { const point = world.toLocal(moveEvent.global); const previous = points[points.length - 1]!; if (Math.hypot(point.x - previous.x, point.y - previous.y) >= 2) { points.push(point); redraw(); } };
      const finish = () => {
        app.stage.off('globalpointermove', move); app.stage.off('pointerup', finish); app.stage.off('pointerupoutside', finish); preview.destroy();
        if (points.length > 1) latest.current.onCreateDrawing(points.map(({ x, y }) => ({ x, y })));
      };
      app.stage.on('globalpointermove', move); app.stage.on('pointerup', finish); app.stage.on('pointerupoutside', finish);
    };
    let lastPointerSent = 0;
    const onPointerMove = (event: PointerEvent) => {
      if (!latest.current.pointerActive) return;
      const now = performance.now(); if (now - lastPointerSent < 80) return;
      const bounds = app.canvas.getBoundingClientRect();
      const point = world.toLocal({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      if (point.x < 0 || point.y < 0 || point.x > latest.current.sceneWidth || point.y > latest.current.sceneHeight) return;
      lastPointerSent = now; latest.current.onSharePointer(point.x, point.y);
    };
    const onDropTokenAsset = (event: Event) => {
      const detail = (event as CustomEvent<{ assetId: string; clientX: number; clientY: number }>).detail;
      const bounds = host.current?.getBoundingClientRect();
      if (!detail || !bounds || detail.clientX < bounds.left || detail.clientX > bounds.right || detail.clientY < bounds.top || detail.clientY > bounds.bottom) return;
      const canvasBounds = app.canvas.getBoundingClientRect();
      const point = world.toLocal({ x: detail.clientX - canvasBounds.left, y: detail.clientY - canvasBounds.top });
      if (point.x >= 0 && point.y >= 0 && point.x <= latest.current.sceneWidth && point.y <= latest.current.sceneHeight) latest.current.onDropTokenAsset(detail.assetId, point.x, point.y);
    };
    const start = async () => {
      await app.init({ resizeTo: host.current!, background: '#222421', backgroundAlpha: 0, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
      initialized = true;
      if (cancelled || !host.current) { if (!destroyed) { destroyed = true; app.destroy(true, { children: true }); } return; }
      app.stage.hitArea = app.screen;
      app.stage.on('pointerdown', onCalibrationClick);
      app.stage.on('pointerdown', onRulerClick);
      app.stage.on('pointerdown', onDrawStart);
      app.stage.on('pointerdown', onSelectionStart);
      host.current.appendChild(app.canvas); refresh();
      app.canvas.addEventListener('nri-refresh', refresh);
      app.canvas.addEventListener('pointermove', onPointerMove);
      window.addEventListener('nri-shared-pointer', receiveSharedPointer);
      window.addEventListener('nri-drop-token-asset', onDropTokenAsset);
      window.addEventListener('nri-fit-scene', fit);
      app.canvas.addEventListener('wheel', (event) => {
        event.preventDefault(); const bounds = app.canvas.getBoundingClientRect();
        const px = event.clientX - bounds.left; const py = event.clientY - bounds.top;
        const camera = zoomToPointer({ scale: world.scale.x, x: world.x, y: world.y }, { x: px, y: py }, Math.exp(-event.deltaY * 0.001));
        world.scale.set(camera.scale); world.position.set(camera.x, camera.y);
      }, { passive: false });
      app.canvas.addEventListener('pointerdown', (event) => {
        if (event.button !== 1 && event.button !== 2) return;
        const ox = event.clientX - world.x; const oy = event.clientY - world.y;
        const move = (e: PointerEvent) => world.position.set(e.clientX - ox, e.clientY - oy);
        const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
      });
      app.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    };
    void start();
    return () => { cancelled = true; window.removeEventListener('nri-fit-scene', fit); window.removeEventListener('nri-shared-pointer', receiveSharedPointer); window.removeEventListener('nri-drop-token-asset', onDropTokenAsset); clearRemotePointers(); if (initialized && !destroyed) { destroyed = true; app.destroy(true, { children: true }); } };
  }, []);

  useEffect(() => {
    const canvas = host.current?.querySelector('canvas');
    if (canvas) canvas.dispatchEvent(new Event('nri-refresh'));
  }, [tokens, props.objects, props.canManage, props.activeLayerId, props.layerSortOrder, gridSize, gridColor, gridOpacity, gridOffsetX, gridOffsetY, gridEnabled, snapToGrid, backgroundUrl, sceneId, sceneWidth, sceneHeight, cameraX, cameraY, cameraZoom, props.calibrationActive, props.gridPreviewSize, props.gridPreviewOffsetX, props.gridPreviewOffsetY, props.rulerActive, props.unitsPerCell, props.unitLabel, props.selectionMode, props.pointerActive]);

  return <div className={`table-canvas ${props.pointerActive ? 'pointer-active' : ''}`} ref={host}><div className="canvas-controls">{props.canManage && <button aria-label={props.selectionLabel} aria-pressed={props.selectionMode} onClick={() => window.dispatchEvent(new Event('nri-toggle-selection'))}>{props.selectionLabel}</button>}<button aria-label={props.pointerLabel} aria-pressed={props.pointerActive} onClick={() => window.dispatchEvent(new Event('nri-toggle-pointer'))}>{props.pointerLabel}</button><button aria-label={props.rulerLabel} aria-pressed={props.rulerActive} onClick={() => window.dispatchEvent(new Event('nri-toggle-ruler'))}>{props.rulerLabel}</button><button aria-label={props.fitLabel} title={props.fitLabel} onClick={() => window.dispatchEvent(new Event('nri-fit-scene'))}>{props.fitLabel}</button></div>{(props.rulerActive || props.selectionMode || props.pointerActive) && <span className="ruler-hint">{props.pointerActive ? props.pointerLabel : props.selectionMode ? props.selectionLabel : props.rulerLabel}</span>}</div>;
}
