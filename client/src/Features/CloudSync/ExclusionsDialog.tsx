import { useState } from 'react';
import type { CloudSyncShare, SyncExclusionKind } from 'deveye-types';

import { ws } from '@/api/ws';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import styles from './style.module.css';

interface ExclusionsDialogProps {
    open: boolean;
    share: CloudSyncShare;
    onClose: () => void;
    onChanged: () => void;
}

const KIND_LABELS: Record<SyncExclusionKind, string> = {
    path: 'Chemin exact',
    name: 'Nom de dossier/fichier',
    regex: 'Expression régulière'
};

/**
 * Exclusions proposées en un clic : ce qu'on ne veut à peu près jamais
 * synchroniser — dépendances réinstallables, caches, artefacts de build,
 * métadonnées d'outils.
 *
 * Toutes en `name`, et c'est le point : ce type attrape le dossier PARTOUT dans
 * l'arborescence, alors qu'un chemin exact ne viserait que celui de la racine.
 * Un `node_modules` imbriqué coûte exactement aussi cher que l'autre.
 *
 * Volontairement absents : `.DS_Store`, `Thumbs.db` et `desktop.ini`. Ils sont
 * déjà exclus en dur (`SYNC_DEFAULT_IGNORED_NAMES`), donc les proposer créerait
 * une règle sans le moindre effet — que l'utilisateur croirait pourtant utile.
 */
const SUGGESTIONS = [
    'node_modules',
    '.git',
    '.venv',
    '__pycache__',
    'target',
    'dist',
    'build',
    '.cache',
    '.next',
    '.idea'
] as const;

/** Exclusions d'un partage : chemin exact, nom de composant, ou regex. */
export default function ExclusionsDialog({ open, share, onClose, onChanged }: ExclusionsDialogProps) {
    const [kind, setKind] = useState<SyncExclusionKind>('name');
    const [pattern, setPattern] = useState('');
    const [error, setError] = useState<string | null>(null);

    /**
     * La seule voie d'ajout : le formulaire et les suggestions la partagent, pour
     * qu'une correction faite d'un côté ne manque jamais à l'autre.
     */
    const addPattern = async (nextKind: SyncExclusionKind, nextPattern: string): Promise<boolean> => {
        setError(null);
        try {
            await ws.send('cloudSync.addExclusion', { shareId: share.id, kind: nextKind, pattern: nextPattern });
            onChanged();
            return true;
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Ajout impossible.');
            return false;
        }
    };

    const add = async () => {
        const trimmed = pattern.trim();
        if (trimmed === '') return;
        if (await addPattern(kind, trimmed)) setPattern('');
    };

    const remove = async (exclusionId: number) => {
        setError(null);
        try {
            await ws.send('cloudSync.removeExclusion', { shareId: share.id, exclusionId });
            onChanged();
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Suppression impossible.');
        }
    };

    // Une suggestion déjà posée quitte la rangée : sans ça, chaque clic ajouterait
    // un doublon et la rangée finirait en liste de règles mortes. Quand elles ont
    // toutes été ajoutées, la rangée disparaît d'elle-même.
    const alreadyExcluded = new Set(share.exclusions.filter((x) => x.kind === 'name').map((x) => x.pattern));
    const suggestions = SUGGESTIONS.filter((s) => !alreadyExcluded.has(s));

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={`Exclusions — ${share.name}`}
            description='Les chemins exclus ne sont ni envoyés ni téléchargés ; ceux déjà dans le cloud en sont retirés (archivés en sauvegardes, les copies locales restent).'
            width={560}
            onSubmit={() => void add()}
        >
            <div className={styles.formCol}>
                <div className={styles.rows}>
                    {share.exclusions.map((x) => (
                        <div key={x.id} className={styles.row}>
                            <div className={styles.rowMain}>
                                <span className={styles.rowTitle}>{x.pattern}</span>
                                <span className={styles.rowSub}>{KIND_LABELS[x.kind]}</span>
                            </div>
                            <div className={styles.rowActions}>
                                <Button
                                    variant='ghost'
                                    icon='trash'
                                    title='Retirer'
                                    onClick={() => void remove(x.id)}
                                />
                            </div>
                        </div>
                    ))}
                    {share.exclusions.length === 0 && <div className={styles.mutedNote}>Aucune exclusion.</div>}
                </div>
                <div className={styles.formRow}>
                    <label className={styles.field}>
                        Type
                        <SelectInput value={kind} onChange={(e) => setKind(e.target.value as SyncExclusionKind)}>
                            {(Object.keys(KIND_LABELS) as SyncExclusionKind[]).map((k) => (
                                <option key={k} value={k}>
                                    {KIND_LABELS[k]}
                                </option>
                            ))}
                        </SelectInput>
                    </label>
                    <label className={styles.field}>
                        Motif
                        <TextInput
                            placeholder={
                                kind === 'name' ? 'node_modules' : kind === 'path' ? 'docs/brouillons' : '\\.tmp$'
                            }
                            value={pattern}
                            onChange={(e) => setPattern(e.target.value)}
                        />
                    </label>
                    <Button icon='add' disabled={pattern.trim() === ''} onClick={() => void add()}>
                        Ajouter
                    </Button>
                </div>
                {suggestions.length > 0 && (
                    <div className={styles.suggestRow}>
                        <span className={styles.suggestLabel}>Suggestions</span>
                        {suggestions.map((s) => (
                            <button
                                key={s}
                                type='button'
                                className={styles.suggestChip}
                                title={`Exclure « ${s} » partout dans le partage`}
                                onClick={() => void addPattern('name', s)}
                            >
                                <span className='icon icon-add' />
                                {s}
                            </button>
                        ))}
                    </div>
                )}
                {error && <div className={styles.mutedNote}>{error}</div>}
                <div className={styles.mutedNote}>
                    Jamais synchronisés, quelles que soient les règles : liens symboliques, liens durs (chaque copie
                    devient un fichier indépendant), fichiers creux (recopiés en fichiers pleins), ACL et attributs
                    étendus. Seuls les bits de permission Unix sont conservés.
                </div>
            </div>
        </Dialog>
    );
}
