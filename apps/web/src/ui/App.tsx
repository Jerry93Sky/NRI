import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import { io, type Socket } from 'socket.io-client';
import { useTranslation } from 'react-i18next';
import type { PublicToken } from '@nri/contracts';
import { TableCanvas } from './TableCanvas';

type User = { id: string; email: string; displayName: string };
type Campaign = { campaign: { id: string; title: string; description: string }; role: string };
type Scene = { id: string; campaignId: string; title: string; gridSize: number; width: number; height: number; backgroundAssetId: string | null; version: number };
type Member = { userId: string; displayName: string; role: string };
type ChatItem = { id: string; senderId: string; displayName: string; body: string; createdAt?: string; private?: boolean; recipientId?: string | null };
type RollItem = { id?: string; displayName: string; expression: string; rolls: number[]; modifier: number; result: number };
type InitiativeView = { tracker: { id: string; active: boolean; round: number; version: number; activeIndex?: number; currentEntryId: string | null } | null; entries: Array<{ id: string; tokenId: string | null; label: string; score: number }> };

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
  const [messages, setMessages] = useState<ChatItem[]>([]);
  const [rolls, setRolls] = useState<RollItem[]>([]);
  const [initiative, setInitiative] = useState<InitiativeView>({ tracker: null, entries: [] });
  const [initiativeScores, setInitiativeScores] = useState<Record<string, string>>({});
  const [connected, setConnected] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [chatText, setChatText] = useState('');
  const [messageRecipient, setMessageRecipient] = useState('');
  const [sceneDialog, setSceneDialog] = useState(false);
  const [sceneTitle, setSceneTitle] = useState('');
  const mapInput = useRef<HTMLInputElement>(null);
  const socket = useMemo<Socket>(() => io({ autoConnect: false, withCredentials: true, transports: ['websocket', 'polling'] }), []);
  const role = campaign?.role ?? 'PLAYER';
  const canManage = role === 'OWNER' || role === 'GM';

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
    return () => { active = false; setScene(null); setTokens([]); socket.emit('campaign:leave', campaign.campaign.id); };
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
    try { setTokens(await api<PublicToken[]>(`/api/scenes/${next.id}/tokens`)); } catch (e) { setError((e as Error).message); }
  }
  useEffect(() => {
    const onConnect = () => {
      setConnected(true);
      if (scene) socket.emit('campaign:join', scene.campaignId, async (result: { error?: string }) => {
        if (result?.error) { setError(result.error); return; }
        try { setTokens(await api<PublicToken[]>(`/api/scenes/${scene.id}/tokens`)); } catch (e) { setError((e as Error).message); }
      });
    };
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect); socket.on('disconnect', onDisconnect);
    socket.on('token:moved', (token: PublicToken) => setTokens((items) => items.map((item) => item.id === token.id ? token : item)));
    socket.on('token:created', (token: PublicToken) => setTokens((items) => items.some((item) => item.id === token.id) ? items : [...items, token]));
    socket.on('token:updated', (token: PublicToken) => setTokens((items) => items.map((item) => item.id === token.id ? token : item)));
    socket.on('chat:message', (message: ChatItem) => setMessages((items) => items.some((item) => item.id === message.id) ? items : [...items.slice(-99), message]));
    socket.on('chat:private', (message: ChatItem) => setMessages((items) => items.some((item) => item.id === message.id) ? items : [...items.slice(-99), { ...message, private: true }]));
    socket.on('dice:result', (roll: RollItem) => setRolls((items) => roll.id && items.some((item) => item.id === roll.id) ? items : [...items.slice(-19), roll]));
    socket.on('initiative:updated', (view: InitiativeView) => setInitiative(view));
    socket.on('initiative:gm_updated', (view: InitiativeView) => setInitiative(view));
    return () => { socket.off('connect', onConnect); socket.off('disconnect', onDisconnect); socket.off('token:moved'); socket.off('token:created'); socket.off('token:updated'); socket.off('chat:message'); socket.off('chat:private'); socket.off('dice:result'); socket.off('initiative:updated'); socket.off('initiative:gm_updated'); };
  }, [socket, scene?.id]);
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
    try { const data = await api<{ scene: Scene }>('/api/scenes', { method: 'POST', body: JSON.stringify({ campaignId: campaign.campaign.id, title: sceneTitle.trim() }) }); setScenes((items) => [...items, data.scene]); setSceneTitle(''); setSceneDialog(false); await openScene(data.scene); }
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
      <header className="table-heading"><div><button className="back-link" onClick={() => setCampaign(null)}>← {t('back')}</button><h1>{campaign.campaign.title}</h1><p>{campaign.campaign.description}</p></div><div className="table-actions">{canManage && <><button className="button secondary" onClick={() => void invite()}>{t('invite')} <span>↗</span></button><button className="button secondary" onClick={() => setSceneDialog(true)}>＋ {t('addScene')}</button><button className="button secondary" onClick={() => mapInput.current?.click()} disabled={!scene}>⇧ {t('uploadMap')}</button><input ref={mapInput} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={uploadBackground} /><button className="button primary" onClick={() => void addToken()} disabled={!scene}>＋ {t('addToken')}</button></>}</div></header>
      <div className="scene-tabs">{scenes.map((item) => <button key={item.id} className={scene?.id === item.id ? 'active' : ''} onClick={() => void openScene(item)}>{item.title}</button>)}{!scenes.length && <span className="muted">Create a scene to set up the table.</span>}</div>
      <div className="table-content"><section className="table-main">{scene ? <TableCanvas tokens={tokens} gridSize={scene.gridSize} backgroundUrl={scene.backgroundAssetId ? `/api/assets/${scene.backgroundAssetId}` : undefined} sceneWidth={scene.width} sceneHeight={scene.height} onMove={moveToken} canEdit={(token) => canManage || token.ownerUserId === user.id} /> : <div className="empty-table"><div className="brand-mark">✳</div><h2>{t('guide')}</h2><p>{t('guideText')}</p>{canManage && <button className="button primary" onClick={() => setSceneDialog(true)}>{t('addScene')}</button>}</div>}<div className="canvas-toolbar"><span>{scene?.title ?? t('mapLabel')}</span><span className="zoom-hint">Drag tokens to move · Scroll to zoom · Right-drag to pan</span></div></section><aside className="right-rail"><div className="rail-header"><span className="online-dot" /> {t('players')} <span className="role-badge">{role}</span></div><section className="rail-section"><div className="section-title"><span>✦</span> {t('guide')}</div><p className="guide-copy">{t('guideText')}</p></section>{canManage && <section className="rail-section token-owners"><div className="section-title">♙ Player tokens</div>{tokens.map((token) => <label key={token.id}>{token.name}<select aria-label={`Owner for ${token.name}`} value={token.ownerUserId ?? ''} onChange={(event) => void assignToken(token, event.target.value)}><option value="">GM controlled</option>{members.filter((member) => member.role === 'PLAYER').map((member) => <option value={member.userId} key={member.userId}>{member.displayName}</option>)}</select></label>)}</section>}{scene && <section className="rail-section initiative-section"><div className="section-title">⚑ Initiative</div>{initiative.tracker?.active ? <><p className="guide-copy">Round {initiative.tracker.round}</p><div className="initiative-list">{initiative.entries.map((entry) => <div className={initiative.tracker?.currentEntryId === entry.id ? "initiative-row active" : "initiative-row"} key={entry.id}><span>{entry.label}</span><strong>{entry.score}</strong></div>)}</div>{canManage && <div className="initiative-actions"><button className="button secondary" onClick={() => void advanceInitiative()}>Next turn ↗</button><button className="quiet-button" onClick={() => void stopInitiative()}>Stop</button></div>}</> : canManage ? <><p className="guide-copy">Set each token's initiative score, then start the tracker.</p>{tokens.map((token) => <label className="initiative-score" key={token.id}>{token.name}<input type="number" min="-9999" max="9999" value={initiativeScores[token.id] ?? "0"} onChange={(event) => setInitiativeScores((scores) => ({ ...scores, [token.id]: event.target.value }))} /></label>)}<button className="button secondary" disabled={!tokens.length} onClick={() => void startInitiative()}>Start initiative</button></> : <p className="guide-copy">Initiative is not active.</p>}</section>}<section className="rail-section roll-section"><div className="section-title">◉ Dice</div><button className="roll-button" onClick={rollDice}>d20 <span>{t('roll')} ↗</span></button>{rolls.slice(-4).reverse().map((roll, i) => <div className="roll-row" key={`${roll.id ?? i}-${i}`}><span>{roll.displayName} rolled {roll.expression}</span><strong>{roll.result}</strong></div>)}</section><section className="rail-section chat-section"><div className="section-title">◌ {t('chat')}</div><select className="message-recipient" aria-label="Message recipient" value={messageRecipient} onChange={(event) => setMessageRecipient(event.target.value)}><option value="">Everyone</option>{members.filter((member) => member.userId !== user.id && (canManage || member.role === 'OWNER' || member.role === 'GM')).map((member) => <option key={member.userId} value={member.userId}>Private · {member.displayName}</option>)}</select><div className="chat-messages">{messages.map((message) => <div className={`chat-message ${message.private ? 'private' : ''}`} key={message.id}><strong>{message.private ? '🔒 ' : ''}{message.displayName}</strong><p>{message.body}</p></div>)}</div><form className="chat-compose" onSubmit={sendChat}><input value={chatText} onChange={(e) => setChatText(e.target.value)} maxLength={2000} placeholder="Write a message…" /><button aria-label={t('send')}>↗</button></form></section></aside></div>
      {error && <button className="toast-error" onClick={() => setError('')}>{error} ×</button>}
      {notice && <button className="toast-notice" onClick={() => setNotice('')}>{notice} ×</button>}
      {sceneDialog && <div className="modal-backdrop"><form className="dialog-card" onSubmit={(event) => { event.preventDefault(); void addScene(); }}><p className="eyebrow">NEW LOCATION</p><h2>{t('addScene')}</h2><label>{t('sceneName')}<input autoFocus value={sceneTitle} onChange={(event) => setSceneTitle(event.target.value)} maxLength={80} required /></label><div className="dialog-actions"><button type="button" className="button secondary" onClick={() => { setSceneTitle(''); setSceneDialog(false); }}>{t('cancel')}</button><button className="button primary">{t('create')}</button></div></form></div>}
    </section>}
  </main>;
}
