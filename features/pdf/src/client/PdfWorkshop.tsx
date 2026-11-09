import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dropzone,
    ErrorNote,
    errorNote,
    handFileTo,
    LoadingVeil,
    pickFiles,
    ProgressDialog,
    saveFrom,
    StickyHeader,
    useRequestPopupWidth,
    useSubView,
    type ConfirmRequest,
    type ErrorNoteInput
} from 'deveye-sdk-client';

import { Picto } from './icons';
import { addImage, buildInputOf, forgetAll, openSource } from './documents';
import { EditTab } from './EditTab';
import { ExportDialog, type ImageDpi, type ImageFormat } from './ExportDialog';
import { FinishTab } from './FinishTab';
import type { Finishing } from './finishing';
import { buildFonts } from './fonts';
import { FormTab } from './FormTab';
import {
    isImageFile,
    isPdfFile,
    outputName,
    summarize,
    WORKSHOP_ACCEPT,
    type PlanPage,
    type SourceInfo,
    type WorkshopIntent
} from './model';
import { PagesTab } from './PagesTab';
import { PasswordDialog, type PasswordRequest } from './PasswordDialog';
import styles from './pdf.module.css';
import { openDocument, NeedsPassword, renderPage } from './pdfjs';
import { redactedPages } from './raster';
import { splitParts, type SplitMode } from './split';
import { TextTab } from './TextTab';
import { clearThumbnails } from './thumbnails';
import { useBuild } from './useBuild';
import { usePdfWorkshop, type OpenedFile } from './usePdfWorkshop';
import { zipFiles } from './zip';

const POPUP_WIDTH = 1280;
/** Un assemblage plus court que ça n'a pas besoin d'un dialogue d'avancement. */
const PROGRESS_DELAY_MS = 400;
/** Le temps laissé au navigateur pour lire une adresse `blob:` avant qu'elle ne soit rendue. */
const BLOB_URL_TTL_MS = 60_000;

type Tab = 'pages' | 'edit' | 'form' | 'finish' | 'text';
/** `apart` : l'onglet ne change pas le document, il le lit. Il se tient à l'écart des autres. */
const TABS: readonly { id: Tab; label: string; icon: string; apart?: boolean }[] = [
    { id: 'pages', label: 'Pages', icon: 'file' },
    { id: 'edit', label: 'Signer et annoter', icon: 'edit' },
    { id: 'form', label: 'Formulaire', icon: 'square-check' },
    { id: 'finish', label: 'Finitions', icon: 'format' },
    { id: 'text', label: 'Texte', icon: 'notes', apart: true }
];

const TAB_OF_INTENT: Partial<Record<WorkshopIntent, Tab>> = {
    sign: 'edit',
    form: 'form',
    text: 'text',
    protect: 'finish'
};

const stem = (name: string): string => name.replace(/\.pdf$/i, '');
const JPEG_QUALITY = 0.9;

/** Les cibles du Convertisseur qu'on atteint depuis l'atelier : il dit lui-même ce que son serveur sait faire. */
export type ServerTarget = 'pdf-light' | 'pdf-ocr';

interface PdfWorkshopProps {
    initialFiles: readonly File[];
    intent: WorkshopIntent;
    onLeave: () => void;
}

/**
 * L'atelier PDF : tout se fait dans le navigateur, le fichier ne monte pas.
 * pdf.js affiche, pdf-lib assemble (dans un worker), et le résultat se
 * télécharge depuis une adresse `blob:`.
 */
export default function PdfWorkshop({ initialFiles, intent, onLeave }: PdfWorkshopProps) {
    useRequestPopupWidth(POPUP_WIDTH);
    const workshop = usePdfWorkshop();
    const { plan, elements, fields, flatten, finishing, selection, act } = workshop;
    const [fileName, setFileName] = useState<string | null>(null);
    const [exportsOpen, setExportsOpen] = useState(false);
    const [exporting, setExporting] = useState<{ step: string; done: number; total: number } | null>(null);
    const name = fileName ?? outputName(plan);
    const [tab, setTab] = useState<Tab>(TAB_OF_INTENT[intent] ?? 'pages');
    // L'onglet Formulaire n'existe que s'il y a des champs à remplir.
    const hasForm = plan.sources.some((s) => s.hasForm);
    const tabs = TABS.filter((t) => t.id !== 'form' || hasForm);
    const shown: Tab = tab === 'form' && !hasForm ? 'pages' : tab;
    useSubView(shown);
    const [opening, setOpening] = useState(0);
    const [error, setError] = useState<ErrorNoteInput | null>(null);
    const [password, setPassword] = useState<PasswordRequest | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const nextColor = useRef(0);
    const { build, progress } = useBuild();

    const building = progress !== null;
    const [slow, setSlow] = useState(false);
    useEffect(() => {
        if (!building) {
            setSlow(false);
            return;
        }
        const timer = window.setTimeout(() => setSlow(true), PROGRESS_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [building]);

    const askPassword = useCallback(
        (file: File, incorrect: boolean) =>
            new Promise<string | null>((resolve) => setPassword({ file, incorrect, resolve })),
        []
    );

    /** Le fichier ouvert, ou la phrase qui dit pourquoi il ne l'a pas été. */
    const openPdf = useCallback(
        async (file: File): Promise<SourceInfo | string> => {
            let given: string | null = null;
            for (;;) {
                try {
                    const source = await openSource(file, given, nextColor.current);
                    nextColor.current++;
                    return source;
                } catch (e) {
                    if (!(e instanceof NeedsPassword)) {
                        return e instanceof Error ? e.message : `« ${file.name} » n’a pas pu être ouvert.`;
                    }
                    given = await askPassword(file, e.incorrect);
                    if (given === null) return `« ${file.name} » a été laissé de côté : il lui faut son mot de passe.`;
                }
            }
        },
        [askPassword]
    );

    const addFiles = useCallback(
        async (files: readonly File[], at?: number): Promise<void> => {
            if (files.length === 0) return;
            setOpening((n) => n + 1);
            const opened: OpenedFile[] = [];
            const problems: string[] = [];
            try {
                for (const file of files) {
                    if (isPdfFile(file)) {
                        const result = await openPdf(file);
                        if (typeof result === 'string') problems.push(result);
                        else opened.push({ kind: 'source', source: result });
                    } else if (isImageFile(file)) {
                        try {
                            opened.push({ kind: 'image', image: await addImage(file) });
                        } catch (e) {
                            problems.push(e instanceof Error ? e.message : `« ${file.name} » n’a pas pu être lue.`);
                        }
                    } else {
                        problems.push(`« ${file.name} » n’est ni un PDF ni une image.`);
                    }
                }
            } finally {
                setOpening((n) => n - 1);
            }
            if (opened.length > 0) act('addFiles', { files: opened, at });
            if (problems.length > 0) setError({ message: problems.join(' '), code: null });
        },
        [act, openPdf]
    );

    const started = useRef(false);
    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void addFiles(initialFiles);
    }, [addFiles, initialFiles]);

    useEffect(
        () => () => {
            forgetAll();
            clearThumbnails();
        },
        []
    );

    /** Un champ de propriété laissé vide garde ce que le premier fichier disait. */
    const effectiveFinishing = useCallback((): Finishing => {
        const first = plan.sources[0]?.meta;
        const { metadata } = finishing;
        if (metadata.strip || !first) return finishing;
        return {
            ...finishing,
            metadata: {
                ...metadata,
                title: metadata.title || first.title,
                author: metadata.author || first.author,
                subject: metadata.subject || first.subject
            }
        };
    }, [plan, finishing]);

    /** Le document, ou une partie : les pages données, avec tout ce qui s'y rapporte. */
    const buildPart = useCallback(
        async (
            pages: readonly PlanPage[],
            numbering?: { offset: number; total: number }
        ): Promise<Uint8Array<ArrayBuffer>> => {
            const kept = new Set(pages.map((p) => p.id));
            const fonts = await buildFonts();
            const redactions = await redactedPages(
                { ...plan, pages },
                elements.filter((e) => kept.has(e.pageId))
            );
            return build({
                ...buildInputOf(plan),
                pages,
                elements,
                fonts,
                redactions,
                fields,
                flatten,
                finishing: effectiveFinishing(),
                numbering
            });
        },
        [build, plan, elements, fields, flatten, effectiveFinishing]
    );

    const save = (bytes: Uint8Array<ArrayBuffer>, type: string, fileName: string): void => {
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        saveFrom(url, fileName);
        window.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
    };

    const download = useCallback(
        async (ids: readonly string[] | null): Promise<void> => {
            const pages = ids ? plan.pages.filter((p) => ids.includes(p.id)) : plan.pages;
            if (pages.length === 0) return;
            setError(null);
            try {
                const bytes = await buildPart(pages);
                save(bytes, 'application/pdf', ids ? `${stem(name)} (extrait).pdf` : name);
            } catch (e) {
                setError(errorNote(e, 'Le document n’a pas pu être assemblé.'));
            }
        },
        [buildPart, plan, name]
    );

    const exportSplit = async (mode: SplitMode): Promise<void> => {
        const parts = splitParts(plan, mode);
        if (!parts) return;
        setError(null);
        setExporting({ step: 'Partie 1', done: 0, total: parts.length });
        try {
            const entries: { name: string; bytes: Uint8Array }[] = [];
            for (const [i, part] of parts.entries()) {
                setExporting({ step: `Partie ${i + 1} : ${part.label}`, done: i, total: parts.length });
                entries.push({
                    name: `${stem(name)} - ${part.label}.pdf`,
                    bytes: await buildPart(part.pages, { offset: part.offset, total: plan.pages.length })
                });
            }
            save(zipFiles(entries), 'application/zip', `${stem(name)}.zip`);
            setExportsOpen(false);
        } catch (e) {
            setError(errorNote(e, 'Le découpage n’a pas pu être fait.'));
        } finally {
            setExporting(null);
        }
    };

    /** Le document, tel qu'il sortirait, confié au Convertisseur : l'allègement et la reconnaissance se font sur son serveur. */
    const handoff = async (target: ServerTarget): Promise<void> => {
        if (plan.pages.length === 0) return;
        setError(null);
        setExporting({ step: 'Assemblage du document', done: 0, total: plan.pages.length });
        try {
            const bytes = await buildPart(plan.pages);
            handFileTo('convert', new File([bytes], name, { type: 'application/pdf' }), target);
        } catch (e) {
            setError(errorNote(e, 'Le document n’a pas pu être assemblé.'));
        } finally {
            setExporting(null);
        }
    };

    const exportImages = async (format: ImageFormat, dpi: ImageDpi): Promise<void> => {
        if (plan.pages.length === 0) return;
        setError(null);
        setExporting({ step: 'Assemblage du document', done: 0, total: plan.pages.length });
        try {
            // Les images sont celles du document produit, ce qui est posé dessus compris.
            const bytes = await buildPart(plan.pages);
            const doc = await openDocument(bytes, finishing.password);
            const entries: { name: string; bytes: Uint8Array }[] = [];
            const mime = format === 'png' ? 'image/png' : 'image/jpeg';
            try {
                for (let i = 1; i <= doc.numPages; i++) {
                    setExporting({ step: `Page ${i} sur ${doc.numPages}`, done: i - 1, total: doc.numPages });
                    const page = await doc.getPage(i);
                    const canvas = document.createElement('canvas');
                    const width = page.getViewport({ scale: 1 }).width * (dpi / 72);
                    await renderPage(page, canvas, Math.round(width), page.rotate);
                    const blob = await new Promise<Blob | null>((resolve) =>
                        canvas.toBlob(resolve, mime, JPEG_QUALITY)
                    );
                    if (!blob) throw new Error('La page n’a pas pu être dessinée.');
                    entries.push({
                        name: `${stem(name)} - page ${i}.${format === 'png' ? 'png' : 'jpg'}`,
                        bytes: new Uint8Array(await blob.arrayBuffer())
                    });
                }
            } finally {
                void doc.loadingTask.destroy().catch(() => undefined);
            }
            save(zipFiles(entries), 'application/zip', `${stem(name)} - images.zip`);
            setExportsOpen(false);
        } catch (e) {
            setError(errorNote(e, 'Les images n’ont pas pu être produites.'));
        } finally {
            setExporting(null);
        }
    };

    const pick = (): void => {
        void pickFiles({ multiple: true, accept: WORKSHOP_ACCEPT }).then((picked) =>
            addFiles(picked.map((p) => p.file))
        );
    };

    const leave = (): void => {
        if (plan.pages.length === 0) {
            onLeave();
            return;
        }
        setConfirm({
            title: 'Quitter l’atelier ?',
            description:
                'Le document préparé ici n’est pas enregistré : il sera perdu. Téléchargez-le d’abord pour le garder.',
            confirmLabel: 'Quitter',
            onConfirm: onLeave
        });
    };

    const empty = plan.pages.length === 0;

    const tabButton = (t: (typeof TABS)[number]) => (
        <button
            key={t.id}
            type='button'
            className={t.id === shown ? styles.tabActive : styles.tab}
            aria-current={t.id === shown ? 'page' : undefined}
            disabled={t.id !== 'pages' && empty}
            title={t.label}
            onClick={() => setTab(t.id)}
        >
            <span className={`icon icon-${t.icon}`} aria-hidden='true' />
            <span className={styles.tabLabel}>{t.label}</span>
        </button>
    );

    return (
        <div className={styles.root}>
            <StickyHeader className={styles.headBand}>
                <header className={styles.header}>
                    <div className={styles.headLeft}>
                        <Button variant='ghost' icon='arrow-left' onClick={leave}>
                            PDF
                        </Button>
                        <div className={styles.headTitle}>
                            <h2 className={styles.heading}>Atelier</h2>
                            <p className={styles.subheading}>{summarize(plan)}</p>
                        </div>
                    </div>
                    <div className={styles.actions}>
                        <button
                            type='button'
                            className={styles.iconButton}
                            aria-label='Annuler la dernière action'
                            title='Annuler (Ctrl+Z)'
                            disabled={!workshop.canUndo}
                            onClick={workshop.undo}
                        >
                            <Picto id='undo' size={16} />
                        </button>
                        <button
                            type='button'
                            className={styles.iconButton}
                            aria-label='Rétablir'
                            title='Rétablir (Ctrl+Maj+Z)'
                            disabled={!workshop.canRedo}
                            onClick={workshop.redo}
                        >
                            <Picto id='redo' size={16} />
                        </button>
                        <Button variant='secondary' icon='add' onClick={pick}>
                            Ajouter des fichiers
                        </Button>
                    </div>
                </header>
                <nav className={styles.tabs} aria-label='Parties de l’atelier'>
                    {tabs.filter((t) => !t.apart).map(tabButton)}
                    <div className={styles.tabsApart}>{tabs.filter((t) => t.apart).map(tabButton)}</div>
                </nav>
            </StickyHeader>

            <ErrorNote note={error} onDismiss={() => setError(null)} />

            <div className={styles.body}>
                {empty && opening === 0 ? (
                    <Dropzone
                        multiple
                        className={styles.emptyDrop}
                        title='Déposez vos PDF ici'
                        hint='ou cliquez pour les choisir. Des images aussi : chacune devient une page.'
                        accept={WORKSHOP_ACCEPT}
                        onFiles={(picked) => void addFiles(picked.map((p) => p.file))}
                    />
                ) : shown === 'edit' ? (
                    <EditTab workshop={workshop} />
                ) : shown === 'form' ? (
                    <FormTab workshop={workshop} />
                ) : shown === 'text' ? (
                    <TextTab workshop={workshop} onOcr={() => void handoff('pdf-ocr')} />
                ) : shown === 'finish' ? (
                    <FinishTab workshop={workshop} />
                ) : (
                    <PagesTab
                        workshop={workshop}
                        onAddFiles={(files) => void addFiles(files)}
                        onDownloadSelection={() => void download(selection)}
                    />
                )}
                {opening > 0 && <LoadingVeil label='Lecture des fichiers…' delayed />}
            </div>

            <footer className={styles.footer}>
                <div className={styles.footerText}>
                    <span className={styles.footerName}>{name}</span>
                    <span className={styles.footerMeta}>
                        {summarize(plan)} · tout se fait sur cet appareil, rien n’est envoyé
                    </span>
                </div>
                <div className={styles.footerActions}>
                    <Button variant='ghost' disabled={empty || building} onClick={() => setExportsOpen(true)}>
                        Autres exports…
                    </Button>
                    <Button icon='download' disabled={empty || building} onClick={() => void download(null)}>
                        Télécharger le PDF
                    </Button>
                </div>
            </footer>

            <PasswordDialog request={password} onDone={() => setPassword(null)} />
            <ExportDialog
                open={exportsOpen}
                plan={plan}
                fileName={name}
                onFileName={(next) => setFileName(next.endsWith('.pdf') ? next : `${next}.pdf`)}
                busy={exporting !== null || building}
                onClose={() => setExportsOpen(false)}
                onSplit={(mode) => void exportSplit(mode)}
                onImages={(format, dpi) => void exportImages(format, dpi)}
                onServer={(target) => void handoff(target)}
            />
            <ProgressDialog
                open={exporting !== null || (slow && progress !== null)}
                title={exporting ? 'Export en cours' : 'Assemblage du document'}
                description={
                    exporting
                        ? 'Chaque partie est assemblée sur cet appareil, puis rangée dans un zip.'
                        : 'Les pages sont copiées dans un PDF neuf, sur cet appareil.'
                }
                value={
                    exporting
                        ? exporting.total > 0
                            ? exporting.done / exporting.total
                            : undefined
                        : progress && progress.total > 0
                          ? progress.done / progress.total
                          : undefined
                }
                step={exporting ? exporting.step : progress ? `Page ${progress.done} sur ${progress.total}` : undefined}
            />
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}
