import { useCallback, useEffect, useState } from 'react';
import { MAINTENANCE_MESSAGE_MAX, type AdminMaintenance, type FeatureMaintenanceLevel } from '@deveye/types';

import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { Dialog } from '@/Components/Dialog';
import SegmentedControl from '@/Components/SegmentedControl';
import Switch from '@/Components/Switch';
import { moduleManifest } from '@/sdk/registry';
import { useMaintenance } from '@/stores/maintenance';
import styles from './Maintenance.module.css';

type Level = FeatureMaintenanceLevel | 'open';

const LEVEL_OPTIONS = [
    { value: 'open', label: 'Ouverte' },
    {
        value: 'requests',
        label: 'Maintenance',
        title: 'Fermée à tous sauf aux administrateurs ; son travail de fond continue'
    },
    { value: 'full', label: 'Arrêt complet', title: 'Fermée à tous, et son travail de fond s’arrête' }
] as const;

function since(epoch: number, by: AdminMaintenance['site']['updatedBy']): string {
    const at = new Date(epoch * 1000).toLocaleString('fr-FR', {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit'
    });
    return by ? `Depuis le ${at}, par ${by.username}` : `Depuis le ${at}`;
}

/**
 * Page « Maintenance » : fermer le site ou une fonctionnalité, pour tout le
 * monde, à l'instant. Réservée à l'administrateur global ; chaque commande est
 * gardée serveur.
 */
export default function FeatureMaintenance() {
    const [state, setState] = useState<AdminMaintenance | null>(null);
    /** Le texte en cours d'édition, fenêtre ouverte ; `null` fenêtre fermée. */
    const [draft, setDraft] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [confirmSite, setConfirmSite] = useState(false);

    const load = useCallback(async () => {
        try {
            setState(await ws.send('admin.maintenanceGet', {}));
        } catch (e) {
            setError(
                e instanceof WsError && e.code === 'forbidden'
                    ? 'Accès réservé aux administrateurs.'
                    : 'Impossible de charger l’état de la maintenance.'
            );
        }
    }, []);

    // Chaque changement est diffusé à tous les écrans : celui d'un autre
    // administrateur, ou une ligne modifiée à la main en base, relit la page.
    const live = useMaintenance();
    useEffect(() => {
        void load();
    }, [load, live]);

    const run = async (fn: () => Promise<AdminMaintenance>, fallback: string): Promise<boolean> => {
        setError(null);
        setBusy(true);
        try {
            setState(await fn());
            return true;
        } catch (e) {
            setError(e instanceof WsError ? e.message : fallback);
            return false;
        } finally {
            setBusy(false);
        }
    };

    if (!state) {
        return <div className={styles.container}>{error && <div className={styles.errorBanner}>{error}</div>}</div>;
    }

    const { site } = state;
    const shownMessage = site.message ?? site.defaultMessage;
    const trimmed = (draft ?? '').trim();
    // Le texte par défaut ne s'enregistre pas tel quel : il suivrait sinon ses
    // révisions à venir.
    const nextMessage = trimmed === '' || trimmed === site.defaultMessage ? null : trimmed;
    const messageChanged = draft !== null && nextMessage !== site.message;

    const setSite = (active: boolean, message: string | null): Promise<boolean> =>
        run(() => ws.send('admin.maintenanceSite', { active, message }), 'Changement impossible.');

    const saveMessage = async (): Promise<void> => {
        if (!messageChanged || (await setSite(site.active, nextMessage))) setDraft(null);
    };

    return (
        <div className={styles.container}>
            <div className={styles.headerText}>
                <h2 className={styles.title}>Maintenance</h2>
                <p className={styles.subtitle}>
                    Fermer le site ou une fonctionnalité, pour tout le monde, à l’instant.
                </p>
            </div>

            {error && <div className={styles.errorBanner}>{error}</div>}

            <div className={styles.sections}>
                <section className={styles.section}>
                    <span className={styles.sectionLabel}>Site</span>
                    <div className={styles.card}>
                        <div className={styles.row}>
                            <span
                                className={`icon icon-wrench ${styles.rowIcon} ${site.active ? styles.active : ''}`}
                            />
                            <div className={styles.rowText}>
                                <span className={styles.rowTitle}>Site en maintenance</span>
                                <span className={styles.rowMeta}>
                                    {site.active
                                        ? `${since(site.updated, site.updatedBy)}. Seuls les administrateurs entrent.`
                                        : 'Les autres comptes seront déconnectés et verront le message ci-dessous.'}
                                    {site.envSeeded &&
                                        ' Ce démarrage a été mis en maintenance par la variable MAINTENANCE.'}
                                </span>
                            </div>
                            <Switch
                                checked={site.active}
                                disabled={busy}
                                onChange={(on) => (on ? setConfirmSite(true) : void setSite(false, site.message))}
                                aria-label='Site en maintenance'
                            />
                        </div>
                        <div className={styles.row}>
                            <span className={`icon icon-chat-outline ${styles.rowIcon}`} />
                            <div className={styles.rowText}>
                                <span className={styles.rowTitle}>Message affiché</span>
                                <span className={`${styles.rowMeta} ${styles.rowMessage}`}>{shownMessage}</span>
                            </div>
                            <Button
                                variant='secondary'
                                icon='edit'
                                disabled={busy}
                                onClick={() => setDraft(shownMessage)}
                            >
                                Modifier
                            </Button>
                        </div>
                    </div>
                </section>

                <section className={styles.section}>
                    <span className={styles.sectionLabel}>Fonctionnalités</span>
                    <p className={styles.sectionHint}>
                        En maintenance, seuls les administrateurs y entrent et son travail de fond continue. En arrêt
                        complet, personne n’y entre et son travail de fond s’arrête aussi.
                    </p>
                    <div className={styles.card}>
                        {state.features.map((f) => {
                            const manifest = moduleManifest(f.id);
                            const label = manifest?.label ?? f.id;
                            const level: Level = f.level ?? 'open';
                            const options = f.hasService
                                ? LEVEL_OPTIONS
                                : LEVEL_OPTIONS.filter((o) => o.value !== 'full');
                            return (
                                <div key={f.id} className={styles.row}>
                                    <span
                                        className={`icon icon-${manifest?.icon ?? 'other'} ${styles.rowIcon} ${
                                            f.level ? styles.active : ''
                                        }`}
                                    />
                                    <div className={styles.rowText}>
                                        <span className={styles.rowTitle}>{label}</span>
                                        {f.level && f.updated !== null && (
                                            <span className={styles.rowMeta}>{since(f.updated, f.updatedBy)}</span>
                                        )}
                                    </div>
                                    <SegmentedControl<Level>
                                        options={options}
                                        value={level}
                                        disabled={busy}
                                        onChange={(next) =>
                                            void run(
                                                () =>
                                                    ws.send('admin.maintenanceFeature', {
                                                        feature: f.id,
                                                        level: next === 'open' ? null : next
                                                    }),
                                                'Changement impossible.'
                                            )
                                        }
                                        aria-label={`État de ${label}`}
                                    />
                                </div>
                            );
                        })}
                    </div>
                </section>
            </div>

            <Dialog
                open={confirmSite}
                onClose={() => setConfirmSite(false)}
                title='Mettre le site en maintenance ?'
                description='Tous les comptes non administrateurs sont déconnectés sur-le-champ et voient le message de maintenance jusqu’à sa levée.'
                footer={
                    <>
                        <Button variant='secondary' onClick={() => setConfirmSite(false)}>
                            Annuler
                        </Button>
                        <Button
                            variant='danger'
                            disabled={busy}
                            onClick={() => {
                                setConfirmSite(false);
                                void setSite(true, site.message);
                            }}
                        >
                            Mettre en maintenance
                        </Button>
                    </>
                }
            />

            <Dialog
                open={draft !== null}
                onClose={() => setDraft(null)}
                title='Message de maintenance'
                description='Ce que voit quiconque la maintenance du site garde dehors.'
                onSubmit={() => void saveMessage()}
                dirty={messageChanged}
                onSave={() => void saveMessage()}
                footer={
                    <>
                        <Button
                            variant='ghost'
                            disabled={busy || draft === site.defaultMessage}
                            onClick={() => setDraft(site.defaultMessage)}
                        >
                            Rétablir le texte par défaut
                        </Button>
                        <Button variant='secondary' onClick={() => setDraft(null)}>
                            Annuler
                        </Button>
                        <Button disabled={busy || !messageChanged} onClick={() => void saveMessage()}>
                            Enregistrer
                        </Button>
                    </>
                }
            >
                <div className={styles.grow} data-value={draft ?? ''}>
                    <textarea
                        className={styles.textarea}
                        rows={3}
                        maxLength={MAINTENANCE_MESSAGE_MAX}
                        value={draft ?? ''}
                        onChange={(e) => setDraft(e.target.value)}
                        aria-label='Message affiché pendant la maintenance'
                        data-autofocus
                    />
                </div>
            </Dialog>
        </div>
    );
}
