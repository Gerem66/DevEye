import { useId } from 'react';
import type { PathExclusion } from '@deveye/types';
import type { BackupSourceCandidate } from '../contracts/domain';

import { DeviceFolderField, PathExclusionsEditor, Switch } from 'deveye-sdk-client';
import { BACKUP_FOLDER_EXCLUSIONS_MAX } from '../contracts/domain';
import { candidateKey, sourceHint } from './format';
import SourcePicker from './SourcePicker';

/** Le dossier d'une machine, tel qu'on le règle avant de l'envoyer. */
export interface FolderDraft {
    path: string;
    exclusions: PathExclusion[];
    oneFileSystem: boolean;
}

export const EMPTY_FOLDER: FolderDraft = { path: '', exclusions: [], oneFileSystem: true };

interface JobSourceFieldsProps {
    candidates: readonly BackupSourceCandidate[];
    source: string;
    onSourceChange: (key: string) => void;
    folder: FolderDraft;
    onFolderChange: (next: FolderDraft) => void;
    /** Pour un travail existant : le membre au nom de qui il tourne, `null` s'il n'est plus là. */
    author?: string | null;
    disabled?: boolean;
    /** Les classes de l'hôte : un dialogue et un panneau de réglages n'ont pas les mêmes. */
    classes: { field: string; label: string; hint: string };
}

/**
 * « Quoi sauvegarder », et pour une machine, lequel de ses dossiers : ce que
 * la création et l'onglet Général d'un travail règlent de la même façon.
 */
export default function JobSourceFields({
    candidates,
    source,
    onSourceChange,
    folder,
    onFolderChange,
    author,
    disabled,
    classes
}: JobSourceFieldsProps) {
    const pathId = useId();
    const selected = candidates.find((c) => candidateKey(c) === source) ?? null;
    const hint = sourceHint(selected);
    const device =
        selected?.kind === 'deviceFolder' && selected.deviceId ? { id: selected.deviceId, name: selected.name } : null;

    return (
        <>
            <div className={classes.field}>
                <span className={classes.label}>Quoi sauvegarder</span>
                <SourcePicker candidates={candidates} value={source} disabled={disabled} onChange={onSourceChange} />
                {hint && <span className={classes.hint}>{hint}</span>}
            </div>

            {device && (
                <>
                    <div className={classes.field}>
                        <label className={classes.label} htmlFor={pathId}>
                            Dossier à sauvegarder
                        </label>
                        <DeviceFolderField
                            id={pathId}
                            device={device}
                            value={folder.path}
                            placeholder='/srv/www'
                            allowCreate={false}
                            disabled={disabled}
                            pickerDescription='Choisissez le dossier à sauvegarder : tout ce qu’il contient part dans l’archive, sauf ce que vous excluez.'
                            onChange={(path) => onFolderChange({ ...folder, path })}
                        />
                        <span className={classes.hint}>
                            Chemin absolu sur la machine. Les liens symboliques sont gardés comme liens. Une base de
                            données se sauvegarde par sa propre source, pas par ses fichiers.
                        </span>
                    </div>

                    <div className={classes.field}>
                        <span className={classes.label}>Exclusions</span>
                        <PathExclusionsEditor
                            items={folder.exclusions.map((rule, index) => ({ key: index, ...rule }))}
                            canWrite={!disabled}
                            scope='le dossier'
                            onAdd={(kind, pattern) => {
                                const known = folder.exclusions.some((r) => r.kind === kind && r.pattern === pattern);
                                if (known || folder.exclusions.length >= BACKUP_FOLDER_EXCLUSIONS_MAX) return false;
                                onFolderChange({ ...folder, exclusions: [...folder.exclusions, { kind, pattern }] });
                                return true;
                            }}
                            onRemove={(key) =>
                                onFolderChange({ ...folder, exclusions: folder.exclusions.filter((_, i) => i !== key) })
                            }
                        />
                    </div>

                    <Switch
                        checked={folder.oneFileSystem}
                        disabled={disabled}
                        onChange={(oneFileSystem) => onFolderChange({ ...folder, oneFileSystem })}
                        label='Rester sur ce système de fichiers'
                        hint='Un disque monté ou un partage réseau à l’intérieur du dossier n’est pas parcouru. Si la machine héberge DevEye, excluez aussi le dossier de ses sauvegardes.'
                    />

                    {author !== undefined && (
                        <span className={classes.hint}>
                            S’exécute au nom de {author ?? 'un ancien membre'}, dont les droits sont revérifiés à chaque
                            passage. L’enregistrer vous en fait l’auteur.
                        </span>
                    )}
                </>
            )}
        </>
    );
}
