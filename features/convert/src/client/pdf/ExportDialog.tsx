import { useState } from 'react';
import { Button, Dialog, NumberInput, SegmentedControl, TextInput } from 'deveye-sdk-client';

import type { Plan } from './model';
import styles from './pdf.module.css';
import { splitParts, type SplitMode } from './split';

export type ImageFormat = 'png' | 'jpeg';
export type ImageDpi = 72 | 150 | 300;

interface ExportDialogProps {
    open: boolean;
    plan: Plan;
    fileName: string;
    onFileName: (name: string) => void;
    busy: boolean;
    onClose: () => void;
    onSplit: (mode: SplitMode) => void;
    onImages: (format: ImageFormat, dpi: ImageDpi) => void;
}

/** Le nom du fichier produit, et les autres façons de sortir le document : en plusieurs PDF, en images. */
export function ExportDialog({
    open,
    plan,
    fileName,
    onFileName,
    busy,
    onClose,
    onSplit,
    onImages
}: ExportDialogProps) {
    const [splitKind, setSplitKind] = useState<SplitMode['kind']>('files');
    const [every, setEvery] = useState<number | null>(1);
    const [ranges, setRanges] = useState('');
    const [format, setFormat] = useState<ImageFormat>('png');
    const [dpi, setDpi] = useState<ImageDpi>(150);

    const mode: SplitMode =
        splitKind === 'files'
            ? { kind: 'files' }
            : splitKind === 'every'
              ? { kind: 'every', count: every ?? 0 }
              : { kind: 'ranges', text: ranges };
    const parts = splitParts(plan, mode);
    const invalidRanges = splitKind === 'ranges' && ranges.trim() !== '' && parts === null;

    return (
        <Dialog open={open} onClose={onClose} title='Autres exports' width={560}>
            <div className={styles.form}>
                <label className={styles.inspectorRow}>
                    <span className={styles.inspectorLabel}>Nom du fichier</span>
                    <TextInput value={fileName} maxLength={200} onChange={(e) => onFileName(e.target.value)} />
                </label>

                <section className={styles.exportSection}>
                    <h3 className={styles.inspectorTitle}>Scinder en plusieurs PDF</h3>
                    <SegmentedControl
                        value={splitKind}
                        options={[
                            { value: 'files', label: 'Par fichier d’origine' },
                            { value: 'every', label: 'Toutes les N pages' },
                            { value: 'ranges', label: 'Par plages' }
                        ]}
                        onChange={setSplitKind}
                        fullWidth
                        aria-label='Façon de scinder'
                    />
                    {splitKind === 'every' && (
                        <label className={styles.exportRow} htmlFor='pdf-split-every'>
                            <span className={styles.inspectorLabel}>Pages par partie</span>
                            <NumberInput id='pdf-split-every' value={every} min={1} max={999} onChange={setEvery} />
                        </label>
                    )}
                    {splitKind === 'ranges' && (
                        <>
                            <TextInput
                                value={ranges}
                                placeholder='1-3 ; 4-6 ; 7-'
                                aria-label='Plages des parties'
                                onChange={(e) => setRanges(e.target.value)}
                                error={invalidRanges ? 'illisible' : undefined}
                            />
                            <p className={styles.note}>Une partie par plage, séparées par des points-virgules.</p>
                        </>
                    )}
                    <div className={styles.exportRow}>
                        <span className={styles.note}>
                            {parts
                                ? `${parts.length} partie${parts.length > 1 ? 's' : ''}, dans un zip.`
                                : 'Rien à découper ainsi.'}
                        </span>
                        <Button
                            variant='secondary'
                            icon='download'
                            disabled={busy || !parts}
                            onClick={() => onSplit(mode)}
                        >
                            Télécharger le zip
                        </Button>
                    </div>
                </section>

                <section className={styles.exportSection}>
                    <h3 className={styles.inspectorTitle}>Les pages en images</h3>
                    <div className={styles.exportPair}>
                        <SegmentedControl
                            value={format}
                            options={[
                                { value: 'png', label: 'PNG', title: 'Sans perte, plus lourd' },
                                { value: 'jpeg', label: 'JPEG', title: 'Plus léger, pour des photos' }
                            ]}
                            onChange={setFormat}
                            fullWidth
                            aria-label='Format des images'
                        />
                        <SegmentedControl
                            value={String(dpi)}
                            options={[
                                { value: '72', label: '72 dpi', title: 'Pour l’écran' },
                                { value: '150', label: '150 dpi', title: 'Pour lire' },
                                { value: '300', label: '300 dpi', title: 'Pour imprimer' }
                            ]}
                            onChange={(v) => setDpi(Number(v) as ImageDpi)}
                            fullWidth
                            aria-label='Définition des images'
                        />
                    </div>
                    <div className={styles.exportRow}>
                        <span className={styles.note}>
                            {plan.pages.length} image{plan.pages.length > 1 ? 's' : ''}, dans un zip. Ce qui est posé
                            sur les pages en fait partie.
                        </span>
                        <Button
                            variant='secondary'
                            icon='download'
                            disabled={busy || plan.pages.length === 0}
                            onClick={() => onImages(format, dpi)}
                        >
                            Télécharger les images
                        </Button>
                    </div>
                </section>
            </div>
        </Dialog>
    );
}
