import { useRef } from 'react';
import { Button, Dropzone, formatBytesFr } from 'deveye-sdk-client';

import { kindOf, sourceOf, type TargetFormat } from '../contracts/catalogue';
import { outputDims } from '../contracts/estimate';
import type { ConvertFamily } from '../contracts/domain';
import type { Dims } from '../contracts/geometry';
import { cropOf, num, sizeOf, type OptionValues } from '../contracts/options';
import { formatDuration, KIND_NOUNS } from './format';
import { Preview } from './Preview';
import styles from './style.module.css';
import type { Wizard } from './useWizard';

interface FilePaneProps {
    wizard: Wizard;
    family: ConvertFamily | undefined;
    /** La cible choisie, quand il y en a une : un GIF se prévisualise à sa cadence. */
    target: TargetFormat | null;
    /** Les réglages en cours : le recadrage se voit dans l'aperçu. */
    values: OptionValues;
    sample: Blob | null;
    /** L'export est parti : on ne change plus de fichier. */
    locked: boolean;
    /** Le fichier produit, une fois l'export fini. Il prend alors la place des boutons, face à l'original. */
    result: FileResult | null;
}

/** Ce qu'on dit du fichier produit, dans les mêmes termes que de l'original. */
export interface FileResult {
    name: string;
    bytes: number | null;
    dims: Dims | null;
    /** Le format, tel que le catalogue le nomme. */
    label: string;
    onDownload: () => void;
}

/**
 * La colonne du fichier, la même aux étapes 2, 3 et 4 : le dépôt tant qu'il n'y
 * en a pas, puis son aperçu. Elle ne se démonte pas d'une étape à l'autre, si
 * bien qu'une vidéo en lecture continue pendant qu'on règle ses options.
 */
export function FilePane({ wizard, family, target, values, sample, locked, result }: FilePaneProps) {
    const { state } = wizard;
    const input = useRef<HTMLInputElement>(null);
    if (!state.kind) return null;

    const accept = kindOf(state.kind)
        .sources.filter((s) => !family?.missingSources.includes(s.id))
        .flatMap((s) => s.ext.map((e) => `.${e}`))
        .join(',');

    if (!state.file) {
        return (
            <div className={styles.filePane}>
                <Dropzone
                    className={styles.dropzoneFill}
                    title={`Déposez ${KIND_NOUNS[state.kind]} ici`}
                    hint='ou cliquez pour choisir un fichier'
                    accept={accept}
                    onFiles={([picked]) => wizard.pickFile(picked.file)}
                />
            </div>
        );
    }

    const { file, info } = state;
    const dims = info?.width && info.height ? { width: info.width, height: info.height } : null;
    // Le passage ne se règle qu'à l'étape des options, et pour une cible qui le permet.
    const trims = state.view === 'options' && target?.options.some((spec) => spec.id === 'trimStart');
    const gifDims = target?.recipe.engine === 'gif' && info ? outputDims(target, values, info) : null;
    const facts = [
        formatBytesFr(file.size),
        dims && `${dims.width} × ${dims.height} px`,
        info?.durationMs && formatDuration(info.durationMs / 1000)
    ].filter(Boolean);

    return (
        <div className={styles.filePane}>
            <Preview
                file={file}
                kind={state.kind}
                isPdf={state.sourceId !== null && sourceOf(state.kind, state.sourceId)?.group === 'pdf'}
                info={info}
                crop={cropOf(values, 'crop')}
                resize={sizeOf(values, 'resize')}
                trim={{ start: num(values, 'trimStart'), end: num(values, 'trimEnd') }}
                onTrim={
                    trims
                        ? (edge, seconds) => wizard.setValue(edge === 'start' ? 'trimStart' : 'trimEnd', seconds)
                        : null
                }
                simulate={gifDims ? { fps: num(values, 'gifFps') ?? 12, dims: gifDims } : null}
                sample={state.view === 'format' ? null : sample}
                onDownload={result?.onDownload ?? null}
            />
            <div className={styles.fileBar}>
                <div className={styles.fileText}>
                    <span className={styles.fileName}>{file.name}</span>
                    <span className={styles.fileMeta}>{facts.join(' · ')}</span>
                </div>
                {result ? (
                    // L'original à gauche, le résultat à droite : le même ordre que le rideau de l'aperçu.
                    <div className={`${styles.fileText} ${styles.fileTextEnd}`}>
                        <span className={styles.fileName}>{result.name}</span>
                        <span className={styles.fileMeta}>
                            {[
                                result.bytes !== null && formatBytesFr(result.bytes),
                                result.dims && `${result.dims.width} × ${result.dims.height} px`,
                                result.label
                            ]
                                .filter(Boolean)
                                .join(' · ')}
                        </span>
                    </div>
                ) : (
                    <div className={styles.fileActions}>
                        <Button variant='secondary' disabled={locked} onClick={() => input.current?.click()}>
                            Changer
                        </Button>
                        <Button variant='ghost' icon='trash' disabled={locked} onClick={wizard.removeFile}>
                            Retirer
                        </Button>
                    </div>
                )}
            </div>
            <input
                ref={input}
                type='file'
                hidden
                accept={accept}
                onChange={(e) => {
                    const next = e.target.files?.[0];
                    if (next) wizard.pickFile(next);
                    e.target.value = '';
                }}
            />
        </div>
    );
}
