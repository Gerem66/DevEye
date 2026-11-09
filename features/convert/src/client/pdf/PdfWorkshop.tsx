import { useCallback, useEffect, useRef, useState } from 'react';
import {
    Button,
    ConfirmDialog,
    Dropzone,
    ErrorNote,
    errorNote,
    FeatureSettingsButton,
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

import { Picto } from '../icons';
import { addImage, buildInputOf, forgetAll, openSource } from './documents';
import { EditTab } from './EditTab';
import { buildFonts } from './fonts';
import {
    isImageFile,
    isPdfFile,
    outputName,
    summarize,
    WORKSHOP_ACCEPT,
    type SourceInfo,
    type WorkshopIntent
} from './model';
import { PagesTab } from './PagesTab';
import { PasswordDialog, type PasswordRequest } from './PasswordDialog';
import styles from './pdf.module.css';
import { NeedsPassword } from './pdfjs';
import { redactedPages } from './raster';
import { clearThumbnails } from './thumbnails';
import { useBuild } from './useBuild';
import { usePdfWorkshop, type OpenedFile } from './usePdfWorkshop';

const POPUP_WIDTH = 1280;
/** Un assemblage plus court que ça n'a pas besoin d'un dialogue d'avancement. */
const PROGRESS_DELAY_MS = 400;
/** Le temps laissé au navigateur pour lire une adresse `blob:` avant qu'elle ne soit rendue. */
const BLOB_URL_TTL_MS = 60_000;

type Tab = 'pages' | 'edit';
const TABS: readonly { id: Tab; label: string; icon: string }[] = [
    { id: 'pages', label: 'Pages', icon: 'file' },
    { id: 'edit', label: 'Signer et annoter', icon: 'edit' }
];

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
    useSubView('pdf');
    useRequestPopupWidth(POPUP_WIDTH);
    const workshop = usePdfWorkshop();
    const { plan, elements, selection, act } = workshop;
    const [tab, setTab] = useState<Tab>(intent === 'sign' ? 'edit' : 'pages');
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

    const download = useCallback(
        async (ids: readonly string[] | null): Promise<void> => {
            const pages = ids ? plan.pages.filter((p) => ids.includes(p.id)) : plan.pages;
            if (pages.length === 0) return;
            setError(null);
            try {
                const kept = new Set(pages.map((p) => p.id));
                const fonts = await buildFonts();
                const redactions = await redactedPages(
                    { ...plan, pages },
                    elements.filter((e) => kept.has(e.pageId))
                );
                const bytes = await build({ ...buildInputOf(plan), pages, elements, fonts, redactions });
                const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
                const name = outputName(plan);
                saveFrom(url, ids ? name.replace(/\.pdf$/, ' (extrait).pdf') : name);
                window.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
            } catch (e) {
                setError(errorNote(e, 'Le document n’a pas pu être assemblé.'));
            }
        },
        [build, plan, elements]
    );

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

    return (
        <div className={styles.root}>
            <StickyHeader className={styles.headBand}>
                <header className={styles.header}>
                    <div className={styles.headLeft}>
                        <Button variant='ghost' icon='arrow-left' onClick={leave}>
                            Convertisseur
                        </Button>
                        <div className={styles.headTitle}>
                            <h2 className={styles.heading}>Atelier PDF</h2>
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
                        <FeatureSettingsButton scope={{ kind: 'feature', feature: 'convert' }} />
                    </div>
                </header>
                <nav className={styles.tabs} aria-label='Parties de l’atelier'>
                    {TABS.map((t) => (
                        <button
                            key={t.id}
                            type='button'
                            className={t.id === tab ? styles.tabActive : styles.tab}
                            aria-current={t.id === tab ? 'page' : undefined}
                            disabled={t.id !== 'pages' && empty}
                            onClick={() => setTab(t.id)}
                        >
                            <span className={`icon icon-${t.icon}`} aria-hidden='true' />
                            {t.label}
                        </button>
                    ))}
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
                ) : tab === 'edit' ? (
                    <EditTab workshop={workshop} />
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
                    <span className={styles.footerName}>{outputName(plan)}</span>
                    <span className={styles.footerMeta}>
                        {summarize(plan)} · tout se fait sur cet appareil, rien n’est envoyé
                    </span>
                </div>
                <div className={styles.footerActions}>
                    <Button icon='download' disabled={empty || building} onClick={() => void download(null)}>
                        Télécharger le PDF
                    </Button>
                </div>
            </footer>

            <PasswordDialog request={password} onDone={() => setPassword(null)} />
            <ProgressDialog
                open={slow && progress !== null}
                title='Assemblage du document'
                description='Les pages sont copiées dans un PDF neuf, sur cet appareil.'
                value={progress && progress.total > 0 ? progress.done / progress.total : undefined}
                step={progress ? `Page ${progress.done} sur ${progress.total}` : undefined}
            />
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}
