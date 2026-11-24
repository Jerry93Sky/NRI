import { useEffect, useRef } from 'react';
import { Application, Assets, Container, Graphics, Sprite, Text } from 'pixi.js';
import type { PublicToken } from '@nri/contracts';

type Props = { tokens: PublicToken[]; gridSize: number; backgroundUrl?: string | undefined; sceneWidth: number; sceneHeight: number; onMove: (token: PublicToken, x: number, y: number) => void; canEdit: (token: PublicToken) => boolean };

export function TableCanvas({ tokens, gridSize, backgroundUrl, sceneWidth, sceneHeight, onMove, canEdit }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef({ tokens, onMove, canEdit, gridSize, backgroundUrl, sceneWidth, sceneHeight });
  latest.current = { tokens, onMove, canEdit, gridSize, backgroundUrl, sceneWidth, sceneHeight };

  useEffect(() => {
    let cancelled = false;
    let initialized = false;
    let destroyed = false;
    const destroyApp = () => {
      if (initialized && !destroyed) { destroyed = true; app.destroy(true, { children: true }); }
    };
    const app = new Application();
    const world = new Container();
    const base = new Graphics().rect(-4000, -4000, 8000, 8000).fill({ color: 0x222421 });
    const mapLayer = new Container();
    const grid = new Graphics();
    const pieces = new Container();
    world.addChild(base, mapLayer, grid, pieces);
    app.stage.addChild(world);
    app.stage.eventMode = 'static';
    const redrawGrid = () => {
      grid.clear();
      for (let x = -4000; x <= 4000; x += latest.current.gridSize) grid.moveTo(x, -4000).lineTo(x, 4000);
      for (let y = -4000; y <= 4000; y += latest.current.gridSize) grid.moveTo(-4000, y).lineTo(4000, y);
      grid.stroke({ color: 0x44453e, alpha: 0.38, width: 1 });
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
        const node = new Container(); node.position.set(token.x * latest.current.gridSize, token.y * latest.current.gridSize);
        const disc = new Graphics().circle(0, 0, 20).fill(token.color).stroke({ color: 0xe8d7c3, alpha: 0.9, width: 2 });
        const label = new Text({ text: token.name, style: { fontFamily: 'Arial', fontSize: 12, fill: 0xf5eadc, align: 'center' } });
        label.anchor.set(0.5, -2); label.y = 25;
        node.addChild(disc, label); node.eventMode = 'static'; node.cursor = latest.current.canEdit(token) ? 'grab' : 'default';
        node.on('pointerdown', (event) => {
          if (!latest.current.canEdit(token)) return;
          event.stopPropagation(); node.cursor = 'grabbing';
          const start = event.global.clone(); const origin = node.position.clone();
          const move = (moveEvent: typeof event) => { const point = moveEvent.global; node.position.set(origin.x + point.x - start.x, origin.y + point.y - start.y); };
          const up = () => {
            app.stage.off('globalpointermove', move); app.stage.off('pointerup', up); app.stage.off('pointerupoutside', up); node.cursor = 'grab';
            const size = latest.current.gridSize; const x = Math.round(node.x / size); const y = Math.round(node.y / size);
            if (x !== token.x || y !== token.y) latest.current.onMove(token, x, y);
          };
          app.stage.on('globalpointermove', move); app.stage.on('pointerup', up); app.stage.on('pointerupoutside', up);
        });
        pieces.addChild(node);
      });
    };
    const start = async () => {
      await app.init({ resizeTo: host.current!, background: '#222421', backgroundAlpha: 0, antialias: true, resolution: Math.min(window.devicePixelRatio || 1, 2), autoDensity: true });
      initialized = true;
      if (cancelled || !host.current) { destroyApp(); return; }
      app.stage.hitArea = app.screen;
      host.current.appendChild(app.canvas); redrawGrid(); redrawTokens(); void redrawMap();
      app.canvas.addEventListener('nri-refresh', () => { redrawGrid(); redrawTokens(); void redrawMap(); });
      app.stage.on('pointerdown', (event) => { if (event.button === 1 || event.nativeEvent instanceof PointerEvent && event.nativeEvent.button === 1) { app.canvas.style.cursor = 'grabbing'; } });
      app.stage.on('pointerup', () => { app.canvas.style.cursor = 'default'; });
      app.canvas.addEventListener('wheel', (event) => {
        event.preventDefault(); const bounds = app.canvas.getBoundingClientRect();
        const px = event.clientX - bounds.left; const py = event.clientY - bounds.top;
        const beforeX = (px - world.x) / world.scale.x; const beforeY = (py - world.y) / world.scale.y;
        const scale = Math.max(0.25, Math.min(2.2, world.scale.x * Math.exp(-event.deltaY * 0.001)));
        world.scale.set(scale); world.position.set(px - beforeX * scale, py - beforeY * scale);
      }, { passive: false });
      app.canvas.addEventListener('pointerdown', (event) => { if (event.button === 1 || event.button === 2) { const ox = event.clientX - world.x; const oy = event.clientY - world.y; const move = (e: PointerEvent) => world.position.set(e.clientX - ox, e.clientY - oy); const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }; window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); } });
      app.canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    };
    void start();
    return () => { cancelled = true; destroyApp(); };
  }, []);

  useEffect(() => {
    const canvas = host.current?.querySelector('canvas');
    if (canvas) canvas.dispatchEvent(new Event('nri-refresh'));
  }, [tokens, gridSize, backgroundUrl, sceneWidth, sceneHeight]);

  return <div className="table-canvas" ref={host} aria-label="Virtual tabletop canvas" />;
}
