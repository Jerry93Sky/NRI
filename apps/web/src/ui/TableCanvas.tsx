import { useEffect, useRef } from 'react';
import { Application, Assets, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { PublicToken } from '@nri/contracts';
import { zoomToPointer } from './canvasMath';

type Props = {
  tokens: PublicToken[]; gridSize: number; gridColor: string; gridOpacity: number; gridOffsetX: number; gridOffsetY: number; gridEnabled: boolean; snapToGrid: boolean;
  backgroundUrl?: string | undefined; sceneId: string; sceneWidth: number; sceneHeight: number; cameraX: number; cameraY: number; cameraZoom: number;
  onMove: (token: PublicToken, x: number, y: number) => void; canEdit: (token: PublicToken) => boolean;
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
    const pieces = new Container();
    world.addChild(base, mapLayer, grid, pieces);
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
      const { sceneWidth: width, sceneHeight: height } = latest.current;
      const ox = ((offsetX % size) + size) % size;
      const oy = ((offsetY % size) + size) % size;
      const startX = ox === 0 ? 0 : ox - size; const startY = oy === 0 ? 0 : oy - size;
      for (let x = startX; x <= width; x += size) grid.moveTo(x, 0).lineTo(x, height);
      for (let y = startY; y <= height; y += size) grid.moveTo(0, y).lineTo(width, y);
      grid.stroke({ color: Number.parseInt(color.slice(1), 16) || 0x44453e, alpha: opacity, width: 1 });
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
      redrawGrid(); redrawTokens(); void redrawMap();
    };
    const fit = () => fitScene();
    const start = async () => {
      await app.init({ resizeTo: host.current!, background: '#222421', backgroundAlpha: 0, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
      initialized = true;
      if (cancelled || !host.current) { if (!destroyed) { destroyed = true; app.destroy(true, { children: true }); } return; }
      app.stage.hitArea = app.screen;
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
  }, [tokens, gridSize, gridColor, gridOpacity, gridOffsetX, gridOffsetY, gridEnabled, snapToGrid, backgroundUrl, sceneId, sceneWidth, sceneHeight, cameraX, cameraY, cameraZoom]);

  return <div className="table-canvas" ref={host}><div className="canvas-controls"><button aria-label="Fit scene" title="Fit scene" onClick={() => window.dispatchEvent(new Event('nri-fit-scene'))}>Fit</button></div></div>;
}
