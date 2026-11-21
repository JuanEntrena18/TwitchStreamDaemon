import { useState, useEffect, useCallback } from 'react';
import { Toggle } from './Toggle';
import type {
  VibeCvConfig,
  VibeCvStatus,
  VibeCvCaptureDebug,
  VibeCvRoi,
  VibeCvRatios,
} from '@streamdaemon/shared';
import styles from './VibeDaemonPanel.module.css';

const isDesktop = typeof window !== 'undefined' && !!window.streamforger?.isDesktop;

const FORTNITE_16_9_PRESET: Pick<
  VibeCvConfig,
  | 'shieldRoi'
  | 'healthRoi'
  | 'stormRoi'
  | 'shieldTriggerRatio'
  | 'shieldRecoveryRatio'
  | 'healthTriggerRatio'
  | 'healthRecoveryRatio'
  | 'stormTriggerRatio'
  | 'stormClearRatio'
  | 'consecutiveFrames'
> = {
  shieldRoi: { x: 0.055, y: 0.885, w: 0.135, h: 0.022 },
  healthRoi: { x: 0.055, y: 0.912, w: 0.135, h: 0.022 },
  stormRoi: { x: 0.845, y: 0.115, w: 0.075, h: 0.06 },
  shieldTriggerRatio: 0.12,
  shieldRecoveryRatio: 0.25,
  healthTriggerRatio: 0.15,
  healthRecoveryRatio: 0.35,
  stormTriggerRatio: 0.025,
  stormClearRatio: 0.006,
  consecutiveFrames: 2,
};

function numVal(v: string): number {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

interface RoiEditorProps {
  label: string;
  roi: VibeCvRoi;
  accent: string;
  onChange: (roi: VibeCvRoi) => void;
}

function RoiEditor({ label, roi, accent, onChange }: RoiEditorProps) {
  return (
    <div>
      <span className={styles.fieldLabel} style={{ color: accent }}>
        {label} (X, Y, Ancho, Alto)
      </span>
      <div className={styles.cvRoiRow}>
        {(['x', 'y', 'w', 'h'] as const).map((k) => (
          <input
            key={k}
            type="number"
            min={0}
            max={1}
            step={0.005}
            title={k.toUpperCase()}
            className={styles.cvRoiInput}
            value={roi[k]}
            onChange={(e) => {
              const v = Math.max(0, Math.min(1, numVal(e.target.value)));
              onChange({ ...roi, [k]: v });
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function VibeCvSection() {
  const [cfg, setCfg] = useState<VibeCvConfig | null>(null);
  const [status, setStatus] = useState<VibeCvStatus | null>(null);
  const [capture, setCapture] = useState<VibeCvCaptureDebug | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  useEffect(() => {
    if (!isDesktop) return;
    window.streamforger?.vibeCv.getConfig().then((c) => setCfg(c)).catch(() => {});
  }, []);

  useEffect(() => {
    if (!isDesktop) return;
    const poll = () => {
      window.streamforger?.vibeCv.getStatus().then((s) => setStatus(s)).catch(() => {});
    };
    poll();
    const id = window.setInterval(poll, 2500);
    return () => window.clearInterval(id);
  }, []);

  const patch = useCallback((p: Partial<VibeCvConfig>) => {
    setCfg((c) => (c ? { ...c, ...p } : c));
  }, []);

  const patchRoi = useCallback(
    (key: 'shieldRoi' | 'healthRoi' | 'stormRoi', p: Partial<VibeCvRoi>) => {
      setCfg((c) => (c && c[key] ? { ...c, [key]: { ...c[key], ...p } } : c));
    },
    [],
  );

  const patchCooldowns = useCallback((p: Partial<VibeCvConfig['cooldowns']>) => {
    setCfg((c) => (c ? { ...c, cooldowns: { ...c.cooldowns, ...p } } : c));
  }, []);

  const save = useCallback(async () => {
    if (!cfg || !isDesktop) return;
    const ok = await window.streamforger?.vibeCv.setConfig(cfg);
    if (ok) {
      setSaved(true);
      setTimeout(() => setSaved(false), 2200);
    }
  }, [cfg]);

  const testCapture = useCallback(async () => {
    if (!isDesktop) return;
    setBusy(true);
    try {
      const cap = await window.streamforger?.vibeCv.captureDebug();
      if (cap) setCapture(cap);
    } catch {
      setCapture({
        dataUrl: null,
        ratios: { shield: 0, health: 0, storm: 0 },
        sourceLabel: null,
        captureSize: null,
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const applyFortnitePreset = useCallback(() => {
    patch({ ...FORTNITE_16_9_PRESET });
  }, [patch]);

  const ratios: VibeCvRatios = capture?.ratios ?? status?.ratios ?? { shield: 0, health: 0, storm: 0 };

  return (
    <section className={styles.comicPanel}>
      <div className={styles.comicPanelHeader}>
        <div className={styles.panelHeading}>
          <span>📡</span>
          <span>Escáner Automático de HUD Fortnite (Visión Ultra-Ligera)</span>
        </div>
        <div className={styles.comicTagRow}>
          <span className={`${styles.comicBadge} ${styles.comicBadgeGreen}`}>
            <span>⚡ BAJO CONSUMO · 640×360</span>
          </span>
          {status?.running && (
            <span className={`${styles.comicBadge} ${styles.comicBadgeCyan}`}>
              <span>🟢 ESCANEANDO</span>
            </span>
          )}
        </div>
      </div>

      <div className={styles.comicPanelBody}>
        <p className={styles.reservedShortcutsNote} style={{ margin: 0 }}>
          Lee automáticamente tus barras de <strong>Escudo</strong>, <strong>Vida</strong> y{' '}
          <strong>Tormenta</strong> en Fortnite usando captura optimizada 9× más ligera que Full HD, con
          protección anti-falsos positivos en el lobby o escritorio.
        </p>

        {!isDesktop && (
          <div className={styles.conflictBanner}>
            El escáner de pantalla solo está disponible en la aplicación de escritorio (Windows Electron).
          </div>
        )}

        {isDesktop && cfg && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
              <Toggle
                size="sm"
                checked={cfg.enabled}
                label={cfg.enabled ? 'Escáner automático ACTIVADO' : 'Escáner automático desactivado'}
                onChange={(enabled) => patch({ enabled })}
              />
              <div style={{ flex: 1 }} />
              {saved && <span className={styles.savedFlash}>✓ Escáner guardado</span>}
              <button
                type="button"
                className={`${styles.comicBtn} ${styles.comicBtnCyan} ${styles.comicBtnSm}`}
                onClick={testCapture}
                disabled={busy}
              >
                📸 {busy ? 'Analizando...' : 'Capturar prueba'}
              </button>
              <button
                type="button"
                className={`${styles.comicBtn} ${styles.comicBtnYellow} ${styles.comicBtnSm}`}
                onClick={save}
              >
                💾 Guardar escáner
              </button>
            </div>

            <div className={styles.configGrid}>
              <div>
                <label className={styles.fieldLabel}>Fuente de lectura</label>
                <select
                  className={styles.fieldInput}
                  value={cfg.sourceType}
                  onChange={(e) => patch({ sourceType: e.target.value as VibeCvConfig['sourceType'] })}
                >
                  <option value="screen">🖥️ Pantalla principal (Más rápido · Menor CPU)</option>
                  <option value="window">🪟 Ventana específica (Ej: Fortnite)</option>
                </select>
              </div>
              {cfg.sourceType === 'window' && (
                <div>
                  <label className={styles.fieldLabel}>Título de la ventana</label>
                  <input
                    className={styles.fieldInput}
                    value={cfg.windowTitleMatch}
                    onChange={(e) => patch({ windowTitleMatch: e.target.value })}
                    placeholder="Fortnite"
                  />
                </div>
              )}
              <div>
                <label className={styles.fieldLabel}>Frecuencia de escaneo (FPS)</label>
                <select
                  className={styles.fieldInput}
                  value={cfg.captureFps}
                  onChange={(e) => patch({ captureFps: numVal(e.target.value) })}
                >
                  <option value={0.5}>0.5 FPS · Eco (Cada 2s · Cero impacto)</option>
                  <option value={1}>1 FPS · Recomendado (Cada 1s)</option>
                  <option value={2}>2 FPS · Rápido (Cada 0.5s)</option>
                </select>
              </div>
            </div>

            {/* Live Cartoon Meters for Shield / Health / Storm */}
            <div className={styles.cvMeterGrid}>
              <div
                className={`${styles.cvMeterCard} ${
                  ratios.shield < cfg.shieldTriggerRatio && ratios.health > 0.04
                    ? styles.cvMeterCardAlert
                    : ''
                }`}
              >
                <div className={styles.cvMeterTop}>
                  <span style={{ color: '#00d8ff' }}>🛡️ Escudo</span>
                  <span>{(ratios.shield * 100).toFixed(1)}%</span>
                </div>
                <div className={styles.cvMeterTrack}>
                  <div
                    className={styles.cvMeterFill}
                    style={{
                      width: `${Math.min(100, ratios.shield * 100)}%`,
                      background: '#00d8ff',
                    }}
                  />
                </div>
                <span className={styles.reservedShortcutsNote}>
                  Salta si baja de {(cfg.shieldTriggerRatio * 100).toFixed(0)}% (arma &gt;{' '}
                  {(cfg.shieldRecoveryRatio * 100).toFixed(0)}%)
                </span>
              </div>

              <div
                className={`${styles.cvMeterCard} ${
                  ratios.health < cfg.healthTriggerRatio && ratios.health > 0.004
                    ? styles.cvMeterCardAlert
                    : ''
                }`}
              >
                <div className={styles.cvMeterTop}>
                  <span style={{ color: '#22c55e' }}>❤️ Vida</span>
                  <span>{(ratios.health * 100).toFixed(1)}%</span>
                </div>
                <div className={styles.cvMeterTrack}>
                  <div
                    className={styles.cvMeterFill}
                    style={{
                      width: `${Math.min(100, ratios.health * 100)}%`,
                      background: '#22c55e',
                    }}
                  />
                </div>
                <span className={styles.reservedShortcutsNote}>
                  Salta si baja de {(cfg.healthTriggerRatio * 100).toFixed(0)}% (arma &gt;{' '}
                  {(cfg.healthRecoveryRatio * 100).toFixed(0)}%)
                </span>
              </div>

              <div
                className={`${styles.cvMeterCard} ${
                  ratios.storm >= cfg.stormTriggerRatio ? styles.cvMeterCardAlert : ''
                }`}
              >
                <div className={styles.cvMeterTop}>
                  <span style={{ color: '#c084fc' }}>🌀 Tormenta</span>
                  <span>{(ratios.storm * 100).toFixed(1)}%</span>
                </div>
                <div className={styles.cvMeterTrack}>
                  <div
                    className={styles.cvMeterFill}
                    style={{
                      width: `${Math.min(100, ratios.storm * 400)}%`,
                      background: '#c084fc',
                    }}
                  />
                </div>
                <span className={styles.reservedShortcutsNote}>
                  Salta al detectar &gt; {(cfg.stormTriggerRatio * 100).toFixed(1)}% púrpura
                </span>
              </div>
            </div>

            {status?.lastError && (
              <div className={styles.conflictBanner}>⚠️ {status.lastError}</div>
            )}

            {status?.lastEvent && (
              <div className={styles.lastActivation}>
                <span>🎯 Última detección automática:</span>
                <strong>{status.lastEvent.eventType}</strong>
                <span>· {new Date(status.lastEvent.at).toLocaleTimeString('es-ES')}</span>
              </div>
            )}

            {capture && (
              <div>
                <div className={styles.cvPreview}>
                  {capture.dataUrl ? (
                    <img src={capture.dataUrl} alt="Captura de calibración Fortnite HUD" />
                  ) : (
                    <div className={styles.cvNoCapture}>
                      No se pudo capturar la fuente. Abre Fortnite o selecciona «Pantalla principal».
                    </div>
                  )}
                  <div
                    className={styles.cvRoiBoxShield}
                    style={{
                      left: `${cfg.shieldRoi.x * 100}%`,
                      top: `${cfg.shieldRoi.y * 100}%`,
                      width: `${cfg.shieldRoi.w * 100}%`,
                      height: `${cfg.shieldRoi.h * 100}%`,
                    }}
                  />
                  <div
                    className={styles.cvRoiBoxHealth}
                    style={{
                      left: `${cfg.healthRoi.x * 100}%`,
                      top: `${cfg.healthRoi.y * 100}%`,
                      width: `${cfg.healthRoi.w * 100}%`,
                      height: `${cfg.healthRoi.h * 100}%`,
                    }}
                  />
                  <div
                    className={styles.cvRoiBoxStorm}
                    style={{
                      left: `${cfg.stormRoi.x * 100}%`,
                      top: `${cfg.stormRoi.y * 100}%`,
                      width: `${cfg.stormRoi.w * 100}%`,
                      height: `${cfg.stormRoi.h * 100}%`,
                    }}
                  />
                </div>
                {capture.sourceLabel && (
                  <p className={styles.reservedShortcutsNote} style={{ marginTop: '6px' }}>
                    Fuente capturada: <strong>{capture.sourceLabel}</strong>
                    {capture.captureSize
                      ? ` (${capture.captureSize.width}×${capture.captureSize.height})`
                      : ''}
                  </p>
                )}
              </div>
            )}

            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className={`${styles.comicBtn} ${styles.comicBtnDark} ${styles.comicBtnSm}`}
                onClick={() => setAdvanced((v) => !v)}
              >
                {advanced ? '▾ Ocultar calibración avanzada' : '▸ Calibración avanzada (ROIs y umbrales)'}
              </button>
              {advanced && (
                <button
                  type="button"
                  className={`${styles.comicBtn} ${styles.comicBtnPurple} ${styles.comicBtnSm}`}
                  onClick={applyFortnitePreset}
                >
                  🪂 Restaurar preset Fortnite 16:9
                </button>
              )}
            </div>

            {advanced && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                <div className={styles.configGrid}>
                  <RoiEditor
                    label="Zona Escudo"
                    roi={cfg.shieldRoi}
                    accent="#00d8ff"
                    onChange={(shieldRoi) => patchRoi('shieldRoi', shieldRoi)}
                  />
                  <RoiEditor
                    label="Zona Vida"
                    roi={cfg.healthRoi}
                    accent="#22c55e"
                    onChange={(healthRoi) => patchRoi('healthRoi', healthRoi)}
                  />
                  <RoiEditor
                    label="Zona Tormenta"
                    roi={cfg.stormRoi}
                    accent="#c084fc"
                    onChange={(stormRoi) => patchRoi('stormRoi', stormRoi)}
                  />
                </div>

                <div className={styles.configGrid}>
                  <div>
                    <label className={styles.fieldLabel}>Escudo · Umbral disparo</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      className={styles.fieldInput}
                      value={cfg.shieldTriggerRatio}
                      onChange={(e) =>
                        patch({ shieldTriggerRatio: Math.max(0, Math.min(1, numVal(e.target.value))) })
                      }
                    />
                  </div>
                  <div>
                    <label className={styles.fieldLabel}>Escudo · Rearme</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      className={styles.fieldInput}
                      value={cfg.shieldRecoveryRatio}
                      onChange={(e) =>
                        patch({ shieldRecoveryRatio: Math.max(0, Math.min(1, numVal(e.target.value))) })
                      }
                    />
                  </div>
                  <div>
                    <label className={styles.fieldLabel}>Vida · Umbral disparo</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      className={styles.fieldInput}
                      value={cfg.healthTriggerRatio}
                      onChange={(e) =>
                        patch({ healthTriggerRatio: Math.max(0, Math.min(1, numVal(e.target.value))) })
                      }
                    />
                  </div>
                  <div>
                    <label className={styles.fieldLabel}>Vida · Rearme</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.01}
                      className={styles.fieldInput}
                      value={cfg.healthRecoveryRatio}
                      onChange={(e) =>
                        patch({ healthRecoveryRatio: Math.max(0, Math.min(1, numVal(e.target.value))) })
                      }
                    />
                  </div>
                  <div>
                    <label className={styles.fieldLabel}>Tormenta · Umbral</label>
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.005}
                      className={styles.fieldInput}
                      value={cfg.stormTriggerRatio}
                      onChange={(e) =>
                        patch({ stormTriggerRatio: Math.max(0, Math.min(1, numVal(e.target.value))) })
                      }
                    />
                  </div>
                  <div>
                    <label className={styles.fieldLabel}>Frames consecutivos</label>
                    <input
                      type="number"
                      min={1}
                      max={10}
                      className={styles.fieldInput}
                      value={cfg.consecutiveFrames}
                      onChange={(e) =>
                        patch({
                          consecutiveFrames: Math.max(1, Math.min(10, Math.round(numVal(e.target.value)))),
                        })
                      }
                    />
                  </div>
                </div>

                <div className={styles.configGrid}>
                  <div>
                    <label className={styles.fieldLabel}>Cooldown Escudo (ms)</label>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      className={styles.fieldInput}
                      value={cfg.cooldowns.lowShieldMs}
                      onChange={(e) =>
                        patchCooldowns({
                          lowShieldMs: Math.max(1000, Math.round(numVal(e.target.value))),
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className={styles.fieldLabel}>Cooldown Vida (ms)</label>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      className={styles.fieldInput}
                      value={cfg.cooldowns.lowHealthMs}
                      onChange={(e) =>
                        patchCooldowns({
                          lowHealthMs: Math.max(1000, Math.round(numVal(e.target.value))),
                        })
                      }
                    />
                  </div>
                  <div>
                    <label className={styles.fieldLabel}>Cooldown Tormenta (ms)</label>
                    <input
                      type="number"
                      min={1000}
                      step={1000}
                      className={styles.fieldInput}
                      value={cfg.cooldowns.stormMs}
                      onChange={(e) =>
                        patchCooldowns({
                          stormMs: Math.max(1000, Math.round(numVal(e.target.value))),
                        })
                      }
                    />
                  </div>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
