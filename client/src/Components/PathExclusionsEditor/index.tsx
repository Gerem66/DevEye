import { useState } from 'react';
import { PATH_EXCLUSION_SUGGESTIONS, pathExclusionProblem, type PathExclusionKind } from '@deveye/types';

import Button from '../Button';
import SegmentedControl from '../SegmentedControl';
import TextInput from '../TextInput';
import styles from './style.module.css';

export interface PathExclusionItem {
    key: string | number;
    kind: PathExclusionKind;
    pattern: string;
}

/** Un nom trouvé dans le dossier parcouru, et ce qu'il y pèse, prêt à afficher (« 2,1 Go, 3 dossiers »). */
export interface PathExclusionFound {
    name: string;
    detail: string;
}

export interface PathExclusionsEditorProps {
    items: readonly PathExclusionItem[];
    /**
     * Ajoute une règle déjà validée. `false` (ou un rejet) garde la saisie :
     * l'appelant dit lui-même pourquoi, là où il affiche ses erreurs.
     */
    onAdd: (kind: PathExclusionKind, pattern: string) => boolean | Promise<boolean>;
    onRemove: (key: string | number) => void;
    canWrite: boolean;
    /** Où s'appliquent les suggestions, en fin de phrase : « le partage », « le dossier ». */
    scope: string;
    disabled?: boolean;
    /**
     * Noms trouvés dans le dossier, en tête des suggestions avec leur poids ;
     * `onAddFound` reçoit leur clic (à défaut, `onAdd` en règle de nom).
     */
    found?: readonly PathExclusionFound[];
    onAddFound?: (name: string) => boolean | Promise<boolean>;
}

const KIND_LABELS: Record<PathExclusionKind, string> = {
    path: 'Chemin exact',
    name: 'Nom de dossier ou fichier',
    regex: 'Expression régulière'
};

const PLACEHOLDERS: Record<PathExclusionKind, string> = {
    path: 'docs/brouillons',
    name: 'node_modules',
    regex: '\\.tmp$'
};

/**
 * Les exclusions d'un dossier parcouru : chemin exact, nom de composant, ou
 * expression régulière, toujours relatifs à sa racine. Le même éditeur pour
 * un partage CloudSync et un dossier sauvegardé : une règle s'écrit de la même
 * façon partout, et se valide comme l'agent l'exécutera. Les exclusions ne
 * tiennent pas compte de la casse.
 */
export function PathExclusionsEditor({
    items,
    onAdd,
    onRemove,
    canWrite,
    scope,
    disabled,
    found = [],
    onAddFound
}: PathExclusionsEditorProps) {
    const [kind, setKind] = useState<PathExclusionKind>('name');
    const [pattern, setPattern] = useState('');
    const [problem, setProblem] = useState<string | null>(null);

    /** Voie d'ajout unique, partagée par le formulaire et les suggestions. */
    const submit = async (
        nextKind: PathExclusionKind,
        nextPattern: string,
        add: () => boolean | Promise<boolean> = () => onAdd(nextKind, nextPattern)
    ): Promise<boolean> => {
        const refused = pathExclusionProblem(nextKind, nextPattern);
        setProblem(refused);
        if (refused) return false;
        try {
            return await add();
        } catch {
            return false;
        }
    };
    const addFound = onAddFound ?? ((name: string) => onAdd('name', name));

    const add = async (): Promise<void> => {
        const trimmed = pattern.trim();
        if (trimmed === '') return;
        if (await submit(kind, trimmed)) setPattern('');
    };

    const named = new Set(items.filter((x) => x.kind === 'name').map((x) => x.pattern));
    // Un nom déjà en règle ne se propose plus ; un nom trouvé remplace sa suggestion fixe.
    const foundChips = found.filter((f) => !named.has(f.name));
    const foundNames = new Set(foundChips.map((f) => f.name));
    const suggestions = PATH_EXCLUSION_SUGGESTIONS.filter((s) => !named.has(s) && !foundNames.has(s));

    return (
        <div className={styles.editor}>
            <div className={styles.rows}>
                {items.map((x) => (
                    <div key={x.key} className={styles.row}>
                        <div className={styles.rowMain}>
                            <span className={styles.rowTitle}>{x.pattern}</span>
                            <span className={styles.rowSub}>{KIND_LABELS[x.kind]}</span>
                        </div>
                        {canWrite && (
                            <Button
                                variant='ghost'
                                icon='trash'
                                title='Retirer'
                                aria-label={`Retirer « ${x.pattern} »`}
                                disabled={disabled}
                                onClick={() => onRemove(x.key)}
                            />
                        )}
                    </div>
                ))}
                {items.length === 0 && <p className={styles.empty}>Aucune exclusion.</p>}
            </div>

            {canWrite && (
                <>
                    <SegmentedControl
                        aria-label='Type d’exclusion'
                        value={kind}
                        onChange={setKind}
                        disabled={disabled}
                        options={(Object.keys(KIND_LABELS) as PathExclusionKind[]).map((k) => ({
                            value: k,
                            label: KIND_LABELS[k]
                        }))}
                    />
                    <div className={styles.formRow}>
                        <TextInput
                            aria-label='Motif d’exclusion'
                            placeholder={PLACEHOLDERS[kind]}
                            value={pattern}
                            disabled={disabled}
                            spellCheck={false}
                            onChange={(e) => {
                                setPattern(e.target.value);
                                setProblem(null);
                            }}
                            onKeyDown={(e) => {
                                if (e.key !== 'Enter') return;
                                // Entrée ajoute la règle, pas le formulaire qui l'entoure.
                                e.preventDefault();
                                e.stopPropagation();
                                void add();
                            }}
                        />
                        <Button
                            icon='add'
                            type='button'
                            disabled={disabled || pattern.trim() === ''}
                            onClick={() => void add()}
                        >
                            Ajouter
                        </Button>
                    </div>
                    {problem && <p className={styles.problem}>{problem}</p>}
                    {(foundChips.length > 0 || suggestions.length > 0) && (
                        <div className={styles.suggestRow}>
                            <span className={styles.suggestLabel}>Suggestions</span>
                            {foundChips.map((f) => (
                                <button
                                    key={f.name}
                                    type='button'
                                    className={styles.suggestChip}
                                    title={`Exclure « ${f.name} » partout dans ${scope} : ${f.detail}`}
                                    disabled={disabled}
                                    onClick={() => void submit('name', f.name, () => addFound(f.name))}
                                >
                                    <span className='icon icon-add' aria-hidden='true' />
                                    {f.name}
                                    <span className={styles.suggestDetail}>{f.detail}</span>
                                </button>
                            ))}
                            {suggestions.map((s) => (
                                <button
                                    key={s}
                                    type='button'
                                    className={styles.suggestChip}
                                    title={`Exclure « ${s} » partout dans ${scope}`}
                                    disabled={disabled}
                                    onClick={() => void submit('name', s)}
                                >
                                    <span className='icon icon-add' aria-hidden='true' />
                                    {s}
                                </button>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}

export default PathExclusionsEditor;
