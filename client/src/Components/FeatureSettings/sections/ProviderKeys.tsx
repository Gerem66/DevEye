import { useState } from 'react';

import Button from '@/Components/Button';
import { Dialog, DialogCancelButton } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';

import ReadOnlyNotice from '../ReadOnlyNotice';
import styles from '../FeatureSettings.module.css';

/**
 * Les fournisseurs d'une fonctionnalité et la clé qu'ils demandent, en une seule
 * liste : l'état et le geste au même endroit.
 *
 * Le patron d'avant montrait la même chose deux fois, une liste d'état puis une
 * pile de champs de saisie sous elle. Il fallait lire les deux pour savoir quoi
 * faire, et la moitié basse ne servait qu'un jour sur cent. Ici chaque rangée
 * porte son bouton, et la saisie vit dans un dialogue, comme partout ailleurs.
 *
 * Générique par nécessité : chaque fonctionnalité a ses fournisseurs et ses
 * commandes, seule la forme est commune.
 */

export type ProviderKeyBadgeTone = 'neutral' | 'accent' | 'warning';

export interface ProviderKeyRow {
    id: string;
    label: string;
    /** Ce que la clé débloque, ou ce que le fournisseur apporte. */
    hint: string;
    /** Une clé est enregistrée pour ce fournisseur. */
    held: boolean;
    /**
     * La clé est-elle exigée ? `false` : un fournisseur ouvert (Open-Meteo),
     * affiché sans rien à régler plutôt que de disparaître de la liste.
     * `'optional'` : la rangée sert sans clé, une clé l'enrichit. Exigée par défaut.
     */
    needsKey?: boolean | 'optional';
    /** Où l'obtenir. Le lien n'a de sens que tant qu'il n'y a pas de clé. */
    signupUrl?: string;
    /** Classe d'icône, sans le préfixe `icon-`. */
    icon?: string;
    /** Qui délivre la clé, quand la rangée porte un autre nom que lui. `label` par défaut. */
    issuer?: string;
    /** Ce que la clé change, en tête du dialogue. `hint` par défaut. */
    keyHint?: string;
    /** Pastilles après le nom : un tarif, une portée. */
    badges?: { label: string; tone?: ProviderKeyBadgeTone }[];
    /** Les rangées consécutives d'un même groupe partagent un intertitre. */
    group?: string;
}

export interface ProviderKeysProps {
    rows: ProviderKeyRow[];
    canWrite: boolean;
    /** Enregistre une clé. L'erreur remonte : le dialogue reste ouvert dessus. */
    onSave: (id: string, key: string) => Promise<void>;
    onRemove: (id: string) => Promise<void>;
    /** La phrase affichée à qui n'a pas le droit d'écrire. */
    readOnlyHint: string;
}

const BADGE_TONE: Record<ProviderKeyBadgeTone, string> = {
    neutral: styles.keyBadge,
    accent: `${styles.keyBadge} ${styles.keyBadgeAccent}`,
    warning: `${styles.keyBadge} ${styles.keyBadgeWarning}`
};

function stateLabel(row: ProviderKeyRow): string {
    if (row.held) return 'clé enregistrée';
    return row.needsKey === 'optional' ? 'clé facultative' : 'aucune clé';
}

/** Les rangées regroupées par `group`, dans l'ordre reçu. */
function runsOf(rows: ProviderKeyRow[]): { title?: string; rows: ProviderKeyRow[] }[] {
    const runs: { title?: string; rows: ProviderKeyRow[] }[] = [];
    for (const row of rows) {
        const last = runs[runs.length - 1];
        if (last && last.title === row.group) last.rows.push(row);
        else runs.push({ title: row.group, rows: [row] });
    }
    return runs;
}

export function ProviderKeys({ rows, canWrite, onSave, onRemove, readOnlyHint }: ProviderKeysProps) {
    const [editing, setEditing] = useState<ProviderKeyRow | null>(null);
    const [draft, setDraft] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const open = (row: ProviderKeyRow): void => {
        setEditing(row);
        setDraft('');
        setError(null);
    };

    const run = async (work: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setError(null);
        try {
            await work();
            setEditing(null);
        } catch (e) {
            // Le dialogue reste ouvert : la clé saisie ne doit pas être perdue
            // parce que le serveur l'a refusée.
            setError(e instanceof Error ? e.message : 'Enregistrement impossible.');
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className={styles.section}>
            {runsOf(rows).map((run, i) => (
                <div key={run.title ?? i} className={styles.keyGroup}>
                    {run.title && <span className={styles.sectionLabel}>{run.title}</span>}
                    <div className={styles.channelList}>
                        {run.rows.map((row) => (
                            <div key={row.id} className={styles.channelRow}>
                                <span
                                    className={`icon icon-${row.icon ?? 'key'} ${styles.channelIcon}`}
                                    aria-hidden='true'
                                />
                                <span className={styles.channelText}>
                                    <span className={styles.channelLabel}>
                                        {row.label}
                                        {row.badges?.map((b) => (
                                            <span key={b.label} className={BADGE_TONE[b.tone ?? 'neutral']}>
                                                {b.label}
                                            </span>
                                        ))}
                                        {row.needsKey !== false && (
                                            <span className={row.held ? styles.channelUsage : styles.channelOff}>
                                                {stateLabel(row)}
                                            </span>
                                        )}
                                    </span>
                                    {/* `channelMeta` coupe à une ligne : le texte entier
                                        reste au survol, et le lien vers le fournisseur
                                        vit dans le dialogue, avec le geste qui en a besoin. */}
                                    <span className={styles.channelMeta} title={row.hint}>
                                        {row.hint}
                                    </span>
                                </span>
                                {canWrite && row.needsKey !== false && (
                                    <span className={styles.channelActions}>
                                        <Button variant='ghost' onClick={() => open(row)}>
                                            {row.held ? 'Modifier' : 'Ajouter une clé'}
                                        </Button>
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            ))}

            {!canWrite && <ReadOnlyNotice>{readOnlyHint}</ReadOnlyNotice>}

            <Dialog
                open={editing !== null}
                onClose={() => setEditing(null)}
                title={editing ? `Clé ${editing.issuer ?? editing.label}` : ''}
                description={editing ? (editing.keyHint ?? editing.hint) : undefined}
                width={460}
            >
                <div className={styles.section}>
                    <div className={styles.field}>
                        <span className={styles.sectionLabel}>Clé d’API</span>
                        <TextInput
                            type='password'
                            enableShowHideButton
                            value={draft}
                            autoFocus
                            onChange={(e) => setDraft(e.target.value)}
                            placeholder={editing?.held ? 'Remplacer la clé…' : 'Coller la clé…'}
                        />
                        <span className={styles.fieldHint}>
                            {editing?.held
                                ? 'La clé enregistrée n’est jamais réaffichée. Laissez vide pour la conserver.'
                                : 'Elle est chiffrée puis conservée pour cet espace.'}
                        </span>
                        {!editing?.held && editing?.signupUrl && (
                            <a
                                className={styles.link}
                                href={editing.signupUrl}
                                target='_blank'
                                rel='noopener noreferrer'
                            >
                                Obtenir une clé chez {editing.issuer ?? editing.label}
                            </a>
                        )}
                    </div>

                    {error && <p className={styles.errorText}>{error}</p>}

                    <div className={styles.sectionActions}>
                        <Button
                            disabled={busy || draft.trim() === ''}
                            onClick={() => void run(() => onSave(editing!.id, draft.trim()))}
                        >
                            {busy ? '…' : 'Enregistrer'}
                        </Button>
                        {editing?.held && (
                            <Button
                                variant='danger'
                                disabled={busy}
                                onClick={() => void run(() => onRemove(editing.id))}
                            >
                                Retirer la clé
                            </Button>
                        )}
                        <DialogCancelButton>Annuler</DialogCancelButton>
                    </div>
                </div>
            </Dialog>
        </div>
    );
}

export default ProviderKeys;
