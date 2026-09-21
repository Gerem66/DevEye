import { useRef } from 'react';
import { Button, formatBytesFr } from 'deveye-sdk-client';

import { kindOf, sourceOf } from '../contracts/catalogue';
import type { ConvertFamily } from '../contracts/domain';
import { clampCrop } from '../contracts/geometry';
import { cropOf, type OptionValues } from '../contracts/options';
import { Dropzone } from './Dropzone';
import { formatDuration, KIND_NOUNS } from './format';
import { Preview } from './Preview';
import styles from './style.module.css';
import type { Wizard } from './useWizard';

interface FilePaneProps {
    wizard: Wizard;
    family: ConvertFamily | undefined;
    /** Les réglages en cours : le recadrage se voit dans l'aperçu. */
    values: OptionValues;
    sample: Blob | null;
    /** L'envoi est parti : on ne change plus de fichier. */
    locked: boolean;
}

/**
 * La colonne du fichier, la même aux étapes 2, 3 et 4 : le dépôt tant qu'il n'y
 * en a pas, puis son aperçu. Elle ne se démonte pas d'une étape à l'autre, si
 * bien qu'une vidéo en lecture continue pendant qu'on règle ses options.
 */
export function FilePane({ wizard, family, values, sample, locked }: FilePaneProps) {
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
                    fill
                    title={`Déposez ${KIND_NOUNS[state.kind]} ici`}
                    hint='ou cliquez pour choisir un fichier'
                    accept={accept}
                    onFile={wizard.pickFile}
                />
            </div>
        );
    }

    const { file, info } = state;
    const dims = info?.width && info.height ? { width: info.width, height: info.height } : null;
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
                crop={dims ? clampCrop(dims, cropOf(values, 'crop')) : null}
                sample={state.view === 'format' ? null : sample}
            />
            <div className={styles.fileBar}>
                <div className={styles.fileText}>
                    <span className={styles.fileName}>{file.name}</span>
                    <span className={styles.fileMeta}>{facts.join(' · ')}</span>
                </div>
                <div className={styles.fileActions}>
                    <Button variant='secondary' disabled={locked} onClick={() => input.current?.click()}>
                        Changer
                    </Button>
                    <Button variant='ghost' icon='trash' disabled={locked} onClick={wizard.removeFile}>
                        Retirer
                    </Button>
                </div>
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
