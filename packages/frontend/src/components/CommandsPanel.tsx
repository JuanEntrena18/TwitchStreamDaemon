import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from '../i18n/context';
import { apiGet, apiPost, apiPut } from '../utils/api';
import { useSocket } from '../hooks/useSocket';
import { ConfirmModal } from './ConfirmModal';
import { EmptyState } from './EmptyState';
import { IconCommands } from './icons/icons';
import { TimersTab } from './TimersTab';
import styles from './CommandsPanel.module.css';

interface Props {
  channel: string;
}

interface Command {
  id: string;
  name: string;
  response: string;
  enabled: boolean;
  aliases: string[];
  cooldown: number;
  modOnly: boolean;
  count: number;
}

const TWITCH_VARS = [
  { var: '{user}', descKey: 'varUser' },
  { var: '{channel}', descKey: 'varChannel' },
  { var: '{streamer}', descKey: 'varStreamer' },
  { var: '{game}', descKey: 'varGame' },
  { var: '{title}', descKey: 'varTitle' },
  { var: '{uptime}', descKey: 'varUptime' },
  { var: '{viewers}', descKey: 'varViewers' },
  { var: '{followers}', descKey: 'varFollowers' },
  { var: '{subs}', descKey: 'varSubs' },
  { var: '{subscribers}', descKey: 'varSubs' },
  { var: '{lastfollower}', descKey: 'varLastFollower' },
  { var: '{lastsub}', descKey: 'varLastSub' },
  { var: '{lastsubscriber}', descKey: 'varLastSub' },
  { var: '{platform}', descKey: 'varPlatform' },
  { var: '{count}', descKey: 'varUses' },
  { var: '{random:1-100}', descKey: 'varRandom' },
  { var: '{args}', descKey: 'varArgs' },
];

const EXAMPLE_COMMANDS = [
  { cmd: '!redes', resp: 'Sígueme en {channel}: https://twitch.tv/{channel}', descKey: 'exampleSocials' },
  { cmd: '!edad', resp: 'Llevamos {uptime} de directo hoy', descKey: 'exampleUptime' },
  { cmd: '!dado', resp: '{user} sacó un {random:1-6} 🎲', descKey: 'exampleDice' },
  { cmd: '!info', resp: '🎮 {game} · {title} · {viewers} viewers', descKey: 'exampleStreamInfo' },
  { cmd: '!seguidores', resp: '¡Ya somos {followers} en el canal! ❤️', descKey: 'exampleFollowers' },
  { cmd: '!subs', resp: '¡{subs} suscriptores y sumando! 💜', descKey: 'exampleSubs' },
];

const RESERVED_COMMANDS = new Set(['sorteo', 'predict', 'votar']);

function previewResponse(response: string, channel: string): string {
  return response
    .replace(/\{user\}/g, '@UsuarioEjemplo')
    .replace(/\{channel\}/g, channel)
    .replace(/\{streamer\}/g, channel)
    .replace(/\{game\}/g, 'Elden Ring')
    .replace(/\{title\}/g, 'Run no-hit | Día 3')
    .replace(/\{uptime\}/g, '2h 15m')
    .replace(/\{viewers\}/g, '1.247')
    .replace(/\{followers\}/g, '12.4K')
    .replace(/\{subs\}/g, '1.8K')
    .replace(/\{subscribers\}/g, '1.8K')
    .replace(/\{lastfollower\}/g, 'NuevoSeguidor')
    .replace(/\{lastsub\}/g, 'MegaSubscriber')
    .replace(/\{lastsubscriber\}/g, 'MegaSubscriber')
    .replace(/\{platform\}/g, 'multi')
    .replace(/\{count\}/g, '42')
    .replace(/\{random:\d+-\d+\}/g, (m) => {
      const nums = m.match(/\d+/g);
      if (!nums) return m;
      const min = parseInt(nums[0], 10);
      const max = parseInt(nums[1], 10);
      return String(Math.floor((min + max) / 2));
    })
    .replace(/\{args\}/g, 'argumento ejemplo');
}

function VarPicker({ onSelect, onClose }: { onSelect: (v: string) => void; onClose: () => void }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onClose(); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [onClose]);
  return (
    <div ref={ref} className={styles.varPicker}>
      <div className={styles.varPickerHeader}>
        {t('commands.variables')}
      </div>
      {TWITCH_VARS.map((v) => (
        <div key={v.var} onClick={() => onSelect(v.var)} className={styles.varPickerItem}>
          <span className={styles.varName}>{v.var}</span>
          <span className={styles.varDesc}>{t('commands.' + v.descKey)}</span>
        </div>
      ))}
    </div>
  );
}

export function CommandsPanel({ channel }: Props) {
  const { t } = useTranslation();
  const [commands, setCommands] = useState<Command[]>([]);
  const [editing, setEditing] = useState<Command | null>(null);
  const [newName, setNewName] = useState('');
  const [newResponse, setNewResponse] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [importResult, setImportResult] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showVarPicker, setShowVarPicker] = useState<'new' | 'edit' | null>(null);
  const [activeTab, setActiveTab] = useState<'commands' | 'timers'>('commands');
  const [confirmDeleteCmd, setConfirmDeleteCmd] = useState<Command | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const editInputRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const { socket: sock } = useSocket();

  useEffect(() => {
    if (!channel) return;
    sock.emit('join:channel', channel);
  }, [sock, channel]);

  useEffect(() => {
    if (!channel) return;
    apiGet(`/commands/${channel}`)
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setCommands(data); })
      .catch(() => {});
  }, [channel]);

  const cleanCommandName = (name: string) => name.trim().toLowerCase().replace(/^!/, '');

  const addCommand = async () => {
    if (!newName.trim() || !newResponse.trim()) return;
    const name = cleanCommandName(newName);
    if (RESERVED_COMMANDS.has(name)) {
      setError(t('commands.reservedError', { cmd: name }));
      return;
    }
    setSaving(true);
    setError('');
    try {
      const r = await apiPost('/commands/add', { channel, name, response: newResponse.trim() });
      if (r.ok) {
        const cmd = await r.json();
        setCommands((prev) => [...prev, cmd]);
        setNewName('');
        setNewResponse('');
      } else {
        const data = await r.json();
        setError(data.error || t('commands.errorCrear'));
      }
    } catch {
      setError(t('commands.errorConexion'));
    } finally {
      setSaving(false);
    }
  };

  const useExample = (cmd: string, resp: string) => {
    setNewName(cmd.replace(/^!/, ''));
    setNewResponse(resp);
    setShowHelp(false);
    inputRef.current?.focus();
  };

  const toggleCommand = async (cmd: Command) => {
    await apiPut('/commands/toggle', { channel, commandId: cmd.id, enabled: !cmd.enabled });
    setCommands((prev) => prev.map((c) => c.id === cmd.id ? { ...c, enabled: !c.enabled } : c));
  };

  const deleteCommand = async (cmd: Command) => {
    await apiPost('/commands/delete', { channel, commandId: cmd.id });
    setCommands((prev) => prev.filter((c) => c.id !== cmd.id));
  };

  const updateCommand = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      await apiPut('/commands/update', { channel, commandId: editing.id, response: editing.response, aliases: editing.aliases, cooldown: editing.cooldown, modOnly: editing.modOnly });
      setCommands((prev) => prev.map((c) => c.id === editing.id ? editing : c));
      setEditing(null);
    } catch {
      setError(t('commands.errorActualizar'));
    } finally {
      setSaving(false);
    }
  };

  const exportCommands = () => {
    if (commands.length === 0) return;
    const data = { channel, commands, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comandos-${channel}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const importCommands = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportResult(null);
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const cmds = data.commands ?? data;
      if (!Array.isArray(cmds)) throw new Error('Formato inválido');
      const r = await apiPost(`/commands/${channel}/import`, { commands: cmds });
      if (r.ok) {
        const result = await r.json();
        setImportResult(`✅ ${result.imported} importados, ${result.skipped} omitidos`);
        const r2 = await apiGet(`/commands/${channel}`);
        const updated = await r2.json();
        if (Array.isArray(updated)) setCommands(updated);
      } else {
        const err = await r.json();
        setImportResult(`❌ ${err.error || 'Error al importar'}`);
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Error al leer archivo';
      setImportResult(`❌ ${message}`);
    }
    e.target.value = '';
  };

  const handleVarInsert = useCallback((target: 'new' | 'edit', v: string) => {
    if (target === 'new') {
      setNewResponse((prev) => prev + v + ' ');
      setShowVarPicker(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    } else if (target === 'edit' && editing) {
      setEditing({ ...editing, response: editing.response + v + ' ' });
      setShowVarPicker(null);
      setTimeout(() => editInputRef.current?.focus(), 0);
    }
  }, [editing]);

  const handleResponseKeyDown = useCallback((target: 'new' | 'edit', e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === '{') {
      setShowVarPicker(target);
    } else if (e.key === 'Escape') {
      setShowVarPicker(null);
    }
  }, []);

  return (
    <div className={styles.container}>
      <div className={styles.tabsWrap}>
        <button 
          className={`${styles.tab} ${activeTab === 'commands' ? styles['tab--active'] : styles['tab--inactive']}`}
          onClick={() => setActiveTab('commands')}
        >
          {t('commands.tabCommands')}
        </button>
        <button 
          className={`${styles.tab} ${activeTab === 'timers' ? styles['tab--active'] : styles['tab--inactive']}`}
          onClick={() => setActiveTab('timers')}
        >
          {t('commands.tabTimers')}
        </button>
      </div>

      {activeTab === 'commands' ? (
        <>
          <div className="mb-5">
            <h2 className="sf-heading flex-row flex-row--gap-md">
              {t('commands.title')}
              <button onClick={() => setShowHelp(!showHelp)} className="sf-btn sf-btn-ghost" style={{ fontSize: '0.7rem', padding: '0.2rem 0.5rem', marginLeft: 'auto' }}>
                {showHelp ? t('commands.cerrarAyuda') : t('commands.ayuda')}
              </button>
            </h2>
            <p className="text-sm text-muted">
              {t('commands.subtitle')}
            </p>
          </div>

      {/* Help section */}
      {showHelp && (
        <div className="glass-card sf-card--tight mb-4">
          <p className="sf-section-title text-sm mb-3">{t('commands.ejemplos')}</p>
          <div className="flex-col flex-col--gap-sm mb-4">
            {EXAMPLE_COMMANDS.map((ex) => (
              <div key={ex.cmd} className={styles.exampleRow}>
                <span className={styles.exampleCmd}>{ex.cmd}</span>
                <span className={styles.exampleResp}>{ex.resp}</span>
                <span className={styles.exampleDesc}>{t('commands.' + ex.descKey)}</span>
                <button
                  type="button"
                  onClick={() => useExample(ex.cmd, ex.resp)}
                  className={`sf-btn ${styles.exampleUseBtn}`}
                  title={t('commands.useExample')}
                >
                  {t('commands.useExample')}
                </button>
              </div>
            ))}
          </div>
          <p className="sf-section-title text-sm mb-2">{t('commands.variablesDisponibles')}</p>
          <p className="text-dim mb-2" style={{ fontSize: '0.72rem' }}>
            {t('commands.variablesHelp')}
          </p>
          <p className="text-dim mb-2" style={{ fontSize: '0.72rem' }}>
            {t('commands.youtubeNote') || 'Los comandos funcionan tanto en Twitch como en YouTube Live. En YouTube, las respuestas automáticas requieren conexión OAuth 2.0 (la API Key solo permite lectura).'}
          </p>
          <div className="grid-2" style={{ gap: '0.25rem 1rem' }}>
            {TWITCH_VARS.map((v) => (
              <div key={v.var} className={styles.varGridItem}>
                <span className={styles.varGridName}>{v.var}</span>
                <span className={styles.varGridDesc}>{t('commands.' + v.descKey)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Add new command */}
      <div className="glass-card sf-card--tight mb-4">
        <div className="flex-between mb-3">
          <p className="sf-section-title" style={{ margin: 0 }}>{t('commands.nuevoComando')}</p>
          <div className={styles.headerActions}>
            <button onClick={exportCommands} disabled={commands.length === 0}
              className={`sf-btn ${styles.pillActionBtn}`}>
              {t('commands.exportar')}
            </button>
            <button onClick={() => fileRef.current?.click()}
              className={`sf-btn ${styles.pillActionBtn}`}>
              {t('commands.importar')}
            </button>
            <input ref={fileRef} type="file" accept=".json" onChange={importCommands} style={{ display: 'none' }} />
          </div>
        </div>
        <div className="flex-col flex-col--gap-sm">
          <div style={{ position: 'relative' }}>
            <input
              type="text" value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t('commands.comandoPlaceholder')}
              className={`sf-input ${styles.inputFull}`}
            />
          </div>
          <div style={{ position: 'relative' }}>
            <input
              ref={inputRef}
              type="text" value={newResponse}
              onChange={(e) => setNewResponse(e.target.value)}
              onKeyDown={(e) => handleResponseKeyDown('new', e)}
              placeholder={t('commands.respuestaPlaceholder')}
              className={`sf-input ${styles.inputFull}`}
            />
            {showVarPicker === 'new' && (
              <VarPicker onSelect={(v) => handleVarInsert('new', v)} onClose={() => setShowVarPicker(null)} />
            )}
          </div>
          {newResponse.trim() && (
            <div className={styles.previewBox}>
              <span className={styles.previewLabel}>{t('commands.preview') || 'Vista previa'}:</span>
              <span className={styles.previewText}>{previewResponse(newResponse, channel)}</span>
            </div>
          )}
        </div>
        <div className="flex-row flex-row--gap-sm">
          <button onClick={addCommand} disabled={saving || !newName.trim() || !newResponse.trim()}
            className="sf-btn sf-btn-primary" style={{ fontSize: '0.8rem', padding: '0.4rem 0.875rem' }}>
            {saving ? '...' : t('commands.crearComando')}
          </button>
          {error && <span className={styles.errorText}>{error}</span>}
          {importResult && <span className={importResult.startsWith('✅') ? styles.resultMsgSuccess : styles.resultMsgError}>{importResult}</span>}
        </div>
      </div>

      {/* Command list */}
      <div className="glass-card" style={{ padding: '1rem' }}>
        {commands.length === 0 ? (
          <EmptyState
            icon={<IconCommands size={18} />}
            title={t('commands.emptyTitle') || 'Sin comandos'}
            description={channel ? (t('commands.empty') || 'Crea tu primer comando personalizado arriba para interactuar con tu chat.') : (t('commands.emptyChannel') || 'Conecta tu cuenta de Twitch para crear comandos.')}
            actionLabel={!channel ? (t('commands.emptyAction') || 'Ir a Configuración') : undefined}
            onAction={!channel ? () => window.dispatchEvent(new CustomEvent('navigateTab', { detail: 'config' })) : undefined}
          />
        ) : (
          <div className="flex-col flex-col--gap-sm">
            {commands.map((cmd) => (
              editing?.id === cmd.id ? (
                /* Edit mode */
                <div key={cmd.id} className={styles.editCard}>
                  <div className={styles.editFormRow}>
                    <div style={{ position: 'relative', flex: 1, minWidth: 200 }}>
                      <input
                        ref={editInputRef}
                        value={editing.response} onChange={(e) => setEditing({ ...editing, response: e.target.value })}
                        onKeyDown={(e) => handleResponseKeyDown('edit', e)}
                        className="sf-input w-full text-sm"
                      />
                      {showVarPicker === 'edit' && (
                        <VarPicker onSelect={(v) => handleVarInsert('edit', v)} onClose={() => setShowVarPicker(null)} />
                      )}
                      {editing.response.trim() && (
                        <div className={styles.previewBox}>
                          <span className={styles.previewLabel}>{t('commands.preview') || 'Vista previa'}:</span>
                          <span className={styles.previewText}>{previewResponse(editing.response, channel)}</span>
                        </div>
                      )}
                    </div>
                    <input value={editing.aliases.join(',')} onChange={(e) => setEditing({ ...editing, aliases: e.target.value.split(',').map((a) => a.trim()) })} placeholder={t('commands.aliasPlaceholder')} className="sf-input" style={{ width: 180, fontSize: '0.8rem' }} />
                  </div>
                  <div className={styles.editActions}>
                    <label className={styles.checkboxLabel}>
                      <input type="checkbox" checked={editing.modOnly} onChange={(e) => setEditing({ ...editing, modOnly: e.target.checked })} />
                      {t('commands.soloMods')}
                    </label>
                    <label className={styles.checkboxLabel}>
                      Cooldown:
                      <input type="number" value={editing.cooldown} onChange={(e) => setEditing({ ...editing, cooldown: parseInt(e.target.value) || 0 })} className={styles.cooldownInput} />
                      s
                    </label>
                    <button onClick={updateCommand} disabled={saving} className="sf-btn sf-btn-primary" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }}>{t('commands.guardar')}</button>
                    <button onClick={() => setEditing(null)} className="sf-btn sf-btn-ghost" style={{ fontSize: '0.72rem', padding: '0.3rem 0.6rem' }}>{t('commands.cancelar')}</button>
                  </div>
                </div>
              ) : (
                /* View mode */
                <div key={cmd.id} className={styles.commandRow} style={{ opacity: cmd.enabled ? 1 : 0.4 }}>
                  <span className={cmd.enabled ? styles.commandDotEnabled : styles.commandDotDisabled} />
                  <strong className={styles.commandName}>!{cmd.name}</strong>
                  <span className={styles.commandResponse}>
                    {cmd.response}
                  </span>
                  <span className={styles.commandMeta}>
                    {cmd.aliases.length > 0 && (
                      <span className={styles.metaBadge}>{cmd.aliases.map(a => `!${a}`).join(', ')}</span>
                    )}
                    {cmd.modOnly && <span className={styles.metaBadge}>{t('commands.soloMods')}</span>}
                    {cmd.cooldown > 0 && <span className={styles.metaBadge}>{cmd.cooldown}s</span>}
                    {cmd.count > 0 && <span className={styles.metaBadge}>{cmd.count}×</span>}
                  </span>
                  <button onClick={() => { setEditing(cmd); setShowVarPicker(null); }} className={`sf-btn sf-btn-ghost ${styles.pillActionBtnSm}`} title={t('commands.editar')}>✏️</button>
                  <button onClick={() => toggleCommand(cmd)} className={`sf-btn sf-btn-ghost ${styles.pillActionBtnSm}`} title={cmd.enabled ? t('commands.deshabilitar') : t('commands.habilitar')}>
                    {cmd.enabled ? '🔕' : '🔔'}
                  </button>
                  <button onClick={() => setConfirmDeleteCmd(cmd)} className={`sf-btn sf-btn-ghost ${styles.ghostBtnDanger}`} title={t('commands.eliminar')}>🗑️</button>
                </div>
              )
            ))}
          </div>
        )}
      </div>

      <ConfirmModal
        open={confirmDeleteCmd !== null}
        title={t('commands.confirmDeleteTitle')}
        message={t('commands.confirmDeleteMsg', { cmd: confirmDeleteCmd?.name || '' })}
        confirmLabel={t('commands.eliminar')}
        onConfirm={() => { if (confirmDeleteCmd) deleteCommand(confirmDeleteCmd); setConfirmDeleteCmd(null); }}
        onCancel={() => setConfirmDeleteCmd(null)}
      />
        </>
      ) : (
        <TimersTab channel={channel} />
      )}
    </div>
  );
}
