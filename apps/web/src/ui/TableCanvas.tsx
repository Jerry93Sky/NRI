import { useEffect, useRef } from 'react';
import { Application, Assets, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { PublicToken } from '@nri/contracts';
import { zoomToPointer } from './canvasMath';

type Props = {
  tokens: PublicToken[]; objects: Array<{ id: string; kind: string; x: number; y: number; width: number; height: number; rotation: number; opacity: number; zIndex: number; color: string | null; strokeWidth: number | null; points: Array<{ x: number; y: number }> | null; text: string | null; visible: boolean; locked: boolean }>; canManage: boolean; gridSize: number; gridColor: string; gridOpacity: number; gridOffsetX: number; gridOffsetY: number; gridEnabled: boolean; snapToGrid: boolean;
  backgroundUrl?: string | undefined; sceneId: string; sceneWidth: number; sceneHeight: number; cameraX: number; cameraY: number; cameraZoom: number;
  onMove: (token: PublicToken, x: number, y: number) => void; canEdit: (token: PublicToken) => boolean; fitLabel: string;
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
    const objectsDisplay = new Container();
    const pieces = new Container();
    world.addChild(base, mapLayer, grid, objectsDisplay, pieces);
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
      for (const item of latest.current.objects.toSorted((a, b) => a.zIndex - b.zIndex || a.y - b.y || a.x - b.x)) {
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
        } else if (item.kind === 'TEXT' && item.text) shape.rect(-item.width / 2, -item.height / 2, item.width, item.height).fill({ color, alpha: 0.18 }).stroke({ color, alpha: 1, width: 1 });
        else continue;
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
      latest.current.tokens.forEach((token) => {
        const size = latest.current.gridSize;
        const node = new Container(); node.position.set(token.x * size, token.y * size);
        const disc = new Graphics().circle(0, 0, size * 0.42).fill(token.color).stroke({ color: 0xe8d7c3, alpha: 0.9, width: 2 });
        const label = new Text({ text: token.name, style: { fontFamily: 'Arial', fontSize: Math.max(10, size * 0.25), fill: 0xf5eadc, align: 'center' } });
        label.anchor.set(0.5, -2); label.y = size * 0.45;
        node.addChild(disc, label); node.eventMode = 'static'; node.cursor = latest.current.canEdit(token) ? 'grab' : 'default';
        node.on('pointerdown', (event) => {
          if (!latest.current.canEdit(token)) return;
          event.stopPropagation(); node.cursor = 'grabbing';
          const start = event.global.clone(); const origin = node.position.clone();
          const move = (moveEvent: typeof event) => { const point = moveEvent.global; node.position.set(origin.x + point.x - start.x, origin.y + point.y - start.y); };
          const up = () => {
            app.stage.off('globalpointermove', move); app.stage.off('pointerup', up); app.stage.off('pointerupoutside', up); node.cursor = 'grab';
            const { gridSize: cellSize, snapToGrid: snap } = latest.current;
            const x = node.x / cellSize; const y = node.y / cellSize;
            const nextX = snap ? Math.round(x) : Number(x.toFixed(2)); const nextY = snap ? Math.round(y) : Number(y.toFixed(2));
            if (nextX !== token.x || nextY !== token.y) latest.current.onMove(token, nextX, nextY);
          };
          app.stage.on('globalpointermove', move); app.stage.on('pointerup', up); app.stage.on('pointerupoutside', up);
        });
        pieces.addChild(node);
      });
    };
    const refresh = () => {
      if (latest.current.sceneId !== previousSceneId) { previousSceneId = latest.current.sceneId; restoreCamera(); }
      redrawGrid(); redrawObjects(); redrawTokens(); void redrawMap();
    };
    const fit = () => fitScene();
    const calibrationPoints: Array<{ x: number; y: number }> = [];
    const onCalibrationClick = (event: { global: { x: number; y: number } }) => {
      if (!latest.current.calibrationActive) { calibrationPoints.length = 0; return; }
      const point = world.toLocal(event.global);
      calibrationPoints.push({ x: point.x, y: point.y });
      if (calibrationPoints.length === 2) {
        latest.current.onCalibrationComplete(calibrationPoints[0]!, calibrationPoints[1]!);
        calibrationPoints.length = 0;
      }
    };
    const start = async () => {
      await app.init({ resizeTo: host.current!, background: '#222421', backgroundAlpha: 0, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
      initialized = true;
      if (cancelled || !host.current) { if (!destroyed) { destroyed = true; app.destroy(true, { children: true }); } return; }
      app.stage.hitArea = app.screen;
      app.stage.on('pointerdown', onCalibrationClick);
      host.current.appendChild(app.canvas); refresh();
      app.canvas.addEventListener('nri-refresh', refresh);
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
    return () => { cancelled = true; window.removeEventListener('nri-fit-scene', fit); if (initialized && !destroyed) { destroyed = true; app.destroy(true, { children: true }); } };
  }, []);

  useEffect(() => {
    const canvas = host.current?.querySelector('canvas');
    if (canvas) canvas.dispatchEvent(new Event('nri-refresh'));
  }, [tokens, props.objects, props.canManage, gridSize, gridColor, gridOpacity, gridOffsetX, gridOffsetY, gridEnabled, snapToGrid, backgroundUrl, sceneId, sceneWidth, sceneHeight, cameraX, cameraY, cameraZoom, props.calibrationActive, props.gridPreviewSize, props.gridPreviewOffsetX, props.gridPreviewOffsetY]);

  return <div className="table-canvas" ref={host}><div className="canvas-controls"><button aria-label={props.fitLabel} title={props.fitLabel} onClick={() => window.dispatchEvent(new Event('nri-fit-scene'))}>{props.fitLabel}</button></div></div>;
}
