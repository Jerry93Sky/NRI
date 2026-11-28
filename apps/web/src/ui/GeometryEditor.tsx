import { useTranslation } from 'react-i18next';
import type { SceneObstacle } from '@nri/contracts/geometry';
import type { useSceneGeometry } from '../features/tabletop/useSceneGeometry';

export function GeometryEditor({ editor, onOpen }: { editor: ReturnType<typeof useSceneGeometry>; onOpen: () => void }) {
  const { t } = useTranslation();
  const { mode, selected, editable } = editor;
  return <div className="geometry-tools">
    <button type="button" className="quiet-button" aria-pressed={Boolean(mode)} onClick={() => mode ? editor.setMode(null) : onOpen()}>
      {t('geometryEditor')}
    </button>
    {mode && <div className="geometry-editor" aria-label={t('geometryEditor')}>
      <div className="geometry-actions">
        {(['select', 'WALL', 'DOOR', 'WINDOW'] as const).map((tool) =>
          <button key={tool} type="button" className="quiet-button" aria-pressed={mode === tool}
            onClick={() => editor.setMode(tool)}>{t(`geometryTool_${tool}`)}</button>)}
      </div>
      <div className="geometry-properties">
        <label><input type="checkbox" checked={editor.movementPolicy ?? false} disabled={!editable}
          onChange={(event) => editor.setMovementPolicy(event.target.checked)} />{t('geometryMovementPolicy')}</label>
      </div>
      <span className="geometry-hint">{t(mode === 'select' ? 'geometrySelectHint' : 'geometryDrawHint')}</span>
      {selected && <div className="geometry-properties">
        {selected.kind === 'DOOR' && <label>{t('geometryDoorState')} <select disabled={!editable} value={selected.doorState ?? ''}
          onChange={(event) => editor.update(selected, { doorState: event.target.value as SceneObstacle['doorState'] })}>
          {(['OPEN', 'CLOSED', 'LOCKED'] as const).map((value) => <option value={value} key={value}>{t(`geometryDoor_${value}`)}</option>)}
        </select></label>}
        <label><input type="checkbox" checked={selected.visibility === 'SECRET'} disabled={!editable}
          onChange={(event) => editor.update(selected, { visibility: event.target.checked ? 'SECRET' : 'STANDARD' })} />{t('geometrySecret')}</label>
        <label><input type="checkbox" checked={selected.blocksMovement} disabled={!editable}
          onChange={(event) => editor.update(selected, { blocksMovement: event.target.checked })} />{t('geometryBlocksMovement')}</label>
        <label><input type="checkbox" checked={selected.blocksVision} disabled={!editable}
          onChange={(event) => editor.update(selected, { blocksVision: event.target.checked })} />{t('geometryBlocksVision')}</label>
        <button type="button" className="quiet-button" disabled={!editable} onClick={() => editor.remove(selected)}>{t('geometryDelete')}</button>
      </div>}
      {editor.loading && <small role="status">{t('loading')}</small>}
      {editor.error && <small role="status">{t(`geometryError_${editor.error}`, { defaultValue: editor.error })}</small>}
      {editor.retry && <button type="button" className="quiet-button" onClick={editor.retry}>{t('geometryRetry')}</button>}
    </div>}
  </div>;
}
