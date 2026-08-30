import { useState } from 'react';

import Button from '@/Components/Button';
import { Dialog, DialogCancelButton } from '@/Components/Dialog';
import TextInput from '@/Components/TextInput';

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

export interface ProviderKeyRow {
    id: string;
    label: string;
    /** Ce que la clé débloque, ou ce que le fournisseur apporte. */
    hint: string;
    /** Une clé est enregistrée pour ce fournisseur. */
    held: boolean;
    /**
     * Le fournisseur exige-t-il une clé ? Un fournisseur ouvert (Open-Meteo)
     * s'affiche sans rien à régler, plutôt que de disparaître de la liste.
     */
    needsKey?: boolean;
    /** Où l'obtenir. Le lien n'a de sens que tant qu'il n'y a pas de clé. */
    signupUrl?: string;
    /** Classe d'icône, sans le préfixe `icon-`. */
    icon?: string;
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
            <div className={styles.channelList}>
                {rows.map((row) => (
                    <div key={row.id} className={styles.channelRow}>
                        <span className={`icon icon-${row.icon ?? 'key'} ${styles.channelIcon}`} aria-hidden='true' />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>
                                {row.label}
                                {row.needsKey !== false && (
                                    <span className={row.held ? styles.channelUsage : styles.channelOff}>
                                        {row.held ? 'clé enregistrée' : 'aucune clé'}
                                    </span>
                                )}
                            </span>
                            {/* `channelMeta` coupe à une ligne : tout ce qui suit
                                le texte y disparaît sur une description un peu
                                longue. Le lien vers le fournisseur est donc dans le
                                dialogue, où il accompagne le geste qui en a besoin. */}
                            <span className={styles.channelMeta}>{row.hint}</span>
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

            {!canWrite && <p className={styles.sectionHint}>{readOnlyHint}</p>}

            <Dialog
                open={editing !== null}
                onClose={() => setEditing(null)}
                title={editing ? `Clé ${editing.label}` : ''}
                description={editing?.hint}
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
                                Obtenir une clé chez {editing.label}
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
