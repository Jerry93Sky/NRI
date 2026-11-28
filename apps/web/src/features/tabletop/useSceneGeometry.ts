import { useCallback, useEffect, useRef, useState } from 'react';
import type { Socket } from 'socket.io-client';
import type { GeometryInvalidation, ObstacleFields, SceneGeometry, SceneObstacle, SceneSegment } from '@nri/contracts/geometry';
import { api } from '../../services/api';

export type GeometryMode = 'select' | ObstacleFields['kind'];
export type GeometryCanvasControls = {
  mode: GeometryMode;
  obstacles: SceneObstacle[];
  selectedId: string;
  editable: boolean;
  select: (id: string) => void;
  create: (kind: ObstacleFields['kind'], segment: SceneSegment) => void;
  move: (obstacle: SceneObstacle, segment: SceneSegment) => void;
};

type Intent = { path: string; method: 'POST' | 'PATCH' | 'DELETE'; body: string };
const emptyObstacles: SceneObstacle[] = [];
const fieldsOf = ({ start, end, kind, doorState, visibility, blocksMovement, blocksVision }: SceneObstacle): ObstacleFields =>
  ({ start, end, kind, doorState, visibility, blocksMovement, blocksVision });

export function useSceneGeometry(socket: Socket, scope: string, campaignId: string, sceneId: string, connected: boolean) {
  const [editor, setEditor] = useState<{ scope: string; mode: GeometryMode } | null>(null);
  const mode = scope && editor?.scope === scope ? editor.mode : null;
  const [selection, setSelection] = useState({ scope: '', id: '' });
  const [snapshot, setSnapshot] = useState<{ scope: string; value: SceneGeometry } | null>(null);
  const [error, setError] = useState({ scope: '', code: '' });
  const [pending, setPending] = useState<{ scope: string; intent: Intent; sending: boolean } | null>(null);
  const request = useRef(0);
  const generation = useRef(0);
  const deniedAt = useRef(0);
  const sending = useRef<Intent | null>(null);
  const current = useRef({ scope, connected, mode });
  current.current = { scope, connected, mode };
  const base = `/api/scenes/${sceneId}/geometry`;
  const isCurrent = useCallback(() => current.current.scope === scope && Boolean(current.current.mode), [scope]);
  const updateMode = useCallback((next: GeometryMode | null) => setEditor(scope && next ? { scope, mode: next } : null), [scope]);
  const select = (id: string) => setSelection({ scope, id });

  const reload = useCallback(async () => {
    if (!scope || !isCurrent() || !current.current.connected) return;
    const sequence = ++request.current;
    const startedIn = generation.current;
    const relevant = () => startedIn === generation.current && isCurrent() && current.current.connected;
    try {
      const value = await api<SceneGeometry>(base);
      if (relevant() && sequence > deniedAt.current) {
        setSnapshot((item) => item?.scope === scope && item.value.revision > value.revision ? item : { scope, value });
      }
    } catch (cause) {
      if (sequence !== request.current || !relevant()) return;
      deniedAt.current = sequence;
      setSnapshot(null);
      setError({ scope, code: (cause as Error).message });
    }
  }, [base, isCurrent, scope]);

  const open = Boolean(mode);
  useEffect(() => {
    setEditor((item) => item?.scope === scope ? item : null);
    setPending((item) => item?.scope === scope ? item : null);
    setSelection({ scope, id: '' });
    setError({ scope: '', code: '' });
  }, [scope]);
  useEffect(() => {
    setSnapshot(null);
    if (!open || !scope || !connected) return;
    const onChange = (event: GeometryInvalidation) => {
      if (event.campaignId === campaignId && event.sceneId === sceneId) void reload();
    };
    socket.on('geometry:changed', onChange);
    void reload();
    return () => { generation.current++; socket.off('geometry:changed', onChange); };
  }, [campaignId, connected, open, reload, sceneId, scope, socket]);

  const waiting = pending?.scope === scope ? pending : null;
  const obstacles = connected && snapshot?.scope === scope && open ? snapshot.value.obstacles : emptyObstacles;
  const selected = selection.scope === scope ? obstacles.find(({ id }) => id === selection.id) : undefined;
  const editable = connected && snapshot?.scope === scope && !waiting;
  async function send(intent: Intent) {
    if (!isCurrent() || !current.current.connected || sending.current) return;
    sending.current = intent;
    setPending({ scope, intent, sending: true });
    setError({ scope, code: '' });
    let code = '';
    try {
      const result = await api<{ obstacle?: SceneObstacle } | null>(intent.path, {
        method: intent.method, body: intent.body, recoverable: 'scene',
      });
      if (!isCurrent()) return;
      if (result?.obstacle) select(result.obstacle.id);
      await reload();
    } catch (cause) {
      code = (cause as Error).message;
      if (!isCurrent()) return;
      setError({ scope, code });
      await reload();
    } finally {
      if (sending.current === intent) sending.current = null;
      setPending((item) => {
        if (item?.intent !== intent) return item;
        return code === 'OUTCOME_UNKNOWN' ? { scope, intent, sending: false } : null;
      });
    }
  }
  function update(obstacle: SceneObstacle, fields: Partial<ObstacleFields>) {
    if (!editable) return;
    void send({ path: `${base}/${obstacle.id}`, method: 'PATCH',
      body: JSON.stringify({ ...fieldsOf(obstacle), ...fields, expectedVersion: obstacle.version }) });
  }
  function remove(obstacle: SceneObstacle) {
    if (editable) void send({ path: `${base}/${obstacle.id}`, method: 'DELETE', body: JSON.stringify({ expectedVersion: obstacle.version }) });
  }
  function setMovementPolicy(enabled: boolean) {
    if (!editable || snapshot?.scope !== scope) return;
    void send({ path: `${base}/movement-policy`, method: 'PATCH',
      body: JSON.stringify({ enabled, expectedRevision: snapshot.value.revision }) });
  }
  const canvas: GeometryCanvasControls | null = mode ? { mode, obstacles, selectedId: selected?.id ?? '', editable, select,
    create(kind, segment) {
      if (!editable) return;
      void send({ path: base, method: 'POST', body: JSON.stringify({ ...segment, kind, doorState: kind === 'DOOR' ? 'CLOSED' : null,
        visibility: 'STANDARD', blocksMovement: true, blocksVision: kind !== 'WINDOW' }) });
    },
    move: update,
  } : null;
  return { mode, setMode: updateMode, canvas, selected, editable, update, remove, setMovementPolicy,
    movementPolicy: snapshot?.scope === scope && connected ? snapshot.value.obstacleMovementEnabled : undefined,
    error: error.scope === scope ? error.code : '', retry: waiting && !waiting.sending ? () => void send(waiting.intent) : null,
    loading: open && connected && snapshot?.scope !== scope && error.scope !== scope,
  };
}
