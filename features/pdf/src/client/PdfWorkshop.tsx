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
    runTask,
    saveFrom,
    StickyHeader,
    TaskError,
    useHandedFile,
    useRequestPopupWidth,
    useSubView,
    useTasks,
    type ConfirmRequest,
    type ErrorNoteInput,
    type TaskContext
} from 'deveye-sdk-client';

import { manifest } from '../manifest';
import { runBuild } from './buildRunner';
import { Picto } from './icons';
import { addImage, buildInputOf, forgetAll, openSource } from './documents';
import { EditTab } from './EditTab';
import { FinishTab } from './FinishTab';
import type { Finishing } from './finishing';
import { buildFonts } from './fonts';
import { FormTab } from './FormTab';
import {
    downloadName,
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
import { TextTab } from './TextTab';
import { clearThumbnails } from './thumbnails';
import { usePdfWorkshop, type OpenedFile } from './usePdfWorkshop';

const POPUP_WIDTH = 1280;
/** Un assemblage à la fois : la clé de son opération. */
const BUILD_KEY = 'build';
const BUILD_FAILED = 'Le document n’a pas pu être assemblé.';
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
    const { plan, elements, fields, flatten, finishing, act } = workshop;
    const [fileName, setFileName] = useState<string | null>(null);
    const name = downloadName(fileName, plan);
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
    // Lu dans la zone des opérations : un assemblage réduit tient encore le bouton.
    const building = useTasks({ feature: manifest.id, key: BUILD_KEY }).length > 0;

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

    // Un PDF confié par le Convertisseur pendant que l'atelier est ouvert s'ajoute au document.
    useHandedFile('pdf', ({ file }) => void addFiles([file]));

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

    /** Le document entier, avec tout ce qui s'y rapporte. */
    const buildDocument = useCallback(
        async (task: TaskContext, signal: AbortSignal): Promise<Uint8Array<ArrayBuffer>> => {
            const fonts = await buildFonts();
            const redactions = await redactedPages(plan, elements);
            return runBuild(
                {
                    ...buildInputOf(plan),
                    pages: plan.pages,
                    elements,
                    fonts,
                    redactions,
                    fields,
                    flatten,
                    finishing: effectiveFinishing()
                },
                (done, total) =>
                    task.report({ value: total > 0 ? done / total : null, step: `Page ${done} sur ${total}` }),
                signal
            );
        },
        [plan, elements, fields, flatten, effectiveFinishing]
    );

    const save = (bytes: Uint8Array<ArrayBuffer>, type: string, fileName: string): void => {
        const url = URL.createObjectURL(new Blob([bytes], { type }));
        saveFrom(url, fileName);
        window.setTimeout(() => URL.revokeObjectURL(url), BLOB_URL_TTL_MS);
    };

    /** L'assemblage, suivi comme une opération : il se réduit, ou bloque quand la suite change d'écran. */
    const assemble = async <T,>(
        minimizable: boolean,
        done: string | undefined,
        then: (bytes: Uint8Array<ArrayBuffer>) => T
    ): Promise<void> => {
        if (plan.pages.length === 0) return;
        setError(null);
        const abort = new AbortController();
        try {
            await runTask(
                {
                    feature: manifest.id,
                    key: BUILD_KEY,
                    title: 'Assemblage du document',
                    subject: name,
                    description: 'Les pages sont copiées dans un PDF neuf, sur cet appareil.',
                    local: true,
                    minimizable,
                    done,
                    failed: BUILD_FAILED,
                    cancel: () => abort.abort()
                },
                async (task) => then(await buildDocument(task, abort.signal))
            );
        } catch (e) {
            if (e instanceof TaskError && e.code === 'cancelled') return;
            setError(errorNote(e, BUILD_FAILED));
        }
    };

    // Le téléchargement part de l'opération elle-même : réduite, elle le livre
    // encore quand l'atelier a été quitté.
    const download = (): Promise<void> =>
        assemble(true, 'Document téléchargé.', (bytes) => save(bytes, 'application/pdf', name));

    /** Le document, tel qu'il sortirait, confié au Convertisseur : la reconnaissance du texte se fait sur son serveur. */
    const ocr = (): Promise<void> =>
        assemble(false, undefined, (bytes) =>
            handFileTo('convert', new File([bytes], name, { type: 'application/pdf' }), 'pdf-ocr')
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
                    <TextTab workshop={workshop} onOcr={() => void ocr()} />
                ) : shown === 'finish' ? (
                    <FinishTab workshop={workshop} />
                ) : (
                    <PagesTab
                        workshop={workshop}
                        fileName={fileName ?? outputName(plan)}
                        onFileName={setFileName}
                        onAddFiles={(files) => void addFiles(files)}
                        onAdd={pick}
                        onEdit={() => setTab('edit')}
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
                <Button icon='download' disabled={empty || building} onClick={() => void download()}>
                    Télécharger le PDF
                </Button>
            </footer>

            <PasswordDialog request={password} onDone={() => setPassword(null)} />
            <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} />
        </div>
    );
}
