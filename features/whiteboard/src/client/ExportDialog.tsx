import {
    Button,
    Dialog,
    DialogCancelButton,
    ErrorNote,
    errorNote,
    SegmentedControl,
    Switch,
    type ErrorNoteInput
} from 'deveye-sdk-client';
import { useEffect, useRef, useState } from 'react';

import type { HostTools } from './excalidraw/Host';
import {
    boundedScale,
    formatOf,
    IMAGE_FORMATS,
    IMAGE_SCALES,
    imageFileName,
    pixelSize,
    type ImageFormat,
    type ImageOptions
} from './imageExport';
import styles from './style.module.css';

/** Le grand côté de l'aperçu : net dans le dialogue, rapide à redessiner à chaque réglage. */
const PREVIEW_SIDE = 640;

type Content = 'all' | 'selection';
type Theme = 'light' | 'dark';
type Scale = `${(typeof IMAGE_SCALES)[number]}`;

/** Copier une image demande un contexte sécurisé et un navigateur qui connaît `ClipboardItem`. */
const canCopyImage = (): boolean =>
    typeof ClipboardItem !== 'undefined' && typeof navigator.clipboard?.write === 'function';

/** Propose le fichier au navigateur, puis rend l'URL temporaire. */
function download(name: string, blob: Blob): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const sizeLabel = ({ width, height }: { width: number; height: number }): string =>
    `${width.toLocaleString('fr-FR')} × ${height.toLocaleString('fr-FR')}`;

/**
 * L'image d'un tableau ouvert, au format choisi : tout le tableau ou la
 * sélection, avec ou sans fond, en clair ou en sombre. Elle se dessine dans le
 * navigateur, rien ne passe par le serveur.
 */
export default function ExportDialog({
    open,
    onClose,
    tools,
    title
}: {
    open: boolean;
    onClose: () => void;
    tools: HostTools;
    title: string;
}) {
    const [format, setFormat] = useState<ImageFormat>('png');
    const [content, setContent] = useState<Content>('all');
    const [withBackground, setWithBackground] = useState(true);
    const [theme, setTheme] = useState<Theme>('light');
    const [scale, setScale] = useState<Scale>('2');
    const [scope, setScope] = useState({ empty: false, selection: false });
    const [preview, setPreview] = useState<{ url: string; width: number; height: number } | null>(null);
    const previewUrl = useRef<string | null>(null);
    const [busy, setBusy] = useState<'download' | 'copy' | null>(null);
    const [copied, setCopied] = useState(false);
    const [error, setError] = useState<ErrorNoteInput | null>(null);

    // Relue à chaque ouverture : une sélection faite juste avant est ce qu'on veut exporter.
    useEffect(() => {
        if (!open) return;
        const next = tools.exportScope();
        setScope(next);
        setContent(next.selection ? 'selection' : 'all');
        setError(null);
        setCopied(false);
    }, [open, tools]);

    const selectionOnly = scope.selection && content === 'selection';
    const background = withBackground || format === 'jpeg';
    const dark = theme === 'dark';
    const options: ImageOptions = { format, selectionOnly, background, dark };

    useEffect(() => {
        if (!open || scope.empty) return;
        let live = true;
        tools
            .image({ format: 'png', selectionOnly, background, dark }, { fit: PREVIEW_SIDE })
            .then(({ blob, width, height }) => {
                if (!live) return;
                if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
                previewUrl.current = URL.createObjectURL(blob);
                setPreview({ url: previewUrl.current, width, height });
            })
            .catch((e: unknown) => {
                if (live) setError(errorNote(e, 'L’aperçu n’a pas pu être dessiné.'));
            });
        return () => {
            live = false;
        };
    }, [open, tools, scope.empty, selectionOnly, background, dark]);

    useEffect(
        () => () => {
            if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
        },
        []
    );

    const run = async (mode: 'download' | 'copy'): Promise<void> => {
        setBusy(mode);
        setError(null);
        setCopied(false);
        try {
            if (mode === 'copy') {
                // Le presse-papiers reçoit la promesse de l'image, sans l'attendre : Safari
                // n'accepte l'écriture que pendant le clic, et le dessin dure plus longtemps.
                const png = tools.image({ ...options, format: 'png' }, { scale: Number(scale) });
                await navigator.clipboard.write([new ClipboardItem({ 'image/png': png.then((image) => image.blob) })]);
                setCopied(true);
            } else {
                const { blob } = await tools.image(options, { scale: Number(scale) });
                download(imageFileName(title, format), blob);
                onClose();
            }
        } catch (e) {
            setError(
                errorNote(
                    e,
                    mode === 'copy'
                        ? 'Le navigateur a refusé la copie : téléchargez l’image à la place.'
                        : 'L’image n’a pas pu être dessinée.'
                )
            );
        } finally {
            setBusy(null);
        }
    };

    const chosen = formatOf(format);
    const reduced = preview !== null && boundedScale(preview.width, preview.height, Number(scale)) < Number(scale);
    const disabled = busy !== null || scope.empty;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title='Exporter en image'
            width={560}
            onSubmit={() => {
                if (!disabled) void run('download');
            }}
            footer={
                <>
                    <DialogCancelButton variant='ghost'>Fermer</DialogCancelButton>
                    {canCopyImage() && (
                        <Button
                            variant='secondary'
                            icon='copy'
                            title='Copie l’image en PNG, le format que les autres applications savent coller'
                            disabled={disabled}
                            onClick={() => void run('copy')}
                        >
                            {busy === 'copy' ? 'Copie…' : 'Copier'}
                        </Button>
                    )}
                    <Button icon='download' disabled={disabled} onClick={() => void run('download')}>
                        {busy === 'download' ? 'Préparation…' : `Télécharger (.${chosen.extension})`}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                <div className={styles.exportPreview}>
                    {scope.empty ? (
                        <p className={styles.emptyText}>Le tableau est vide : il n’y a rien à exporter.</p>
                    ) : preview ? (
                        <img
                            src={preview.url}
                            alt={`Aperçu de l’image de « ${title} »`}
                            className={styles.exportPreviewImage}
                        />
                    ) : (
                        <p className={styles.emptyText}>Dessin de l’aperçu…</p>
                    )}
                </div>

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Format</span>
                    <SegmentedControl
                        aria-label='Format de l’image'
                        value={format}
                        onChange={setFormat}
                        options={IMAGE_FORMATS.map(({ value, label }) => ({ value, label }))}
                    />
                    <span className={styles.fieldHint}>{chosen.hint}</span>
                </div>

                {scope.selection && (
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Contenu</span>
                        <SegmentedControl<Content>
                            aria-label='Contenu de l’image'
                            value={content}
                            onChange={setContent}
                            options={[
                                { value: 'all', label: 'Tout le tableau' },
                                { value: 'selection', label: 'La sélection' }
                            ]}
                        />
                    </div>
                )}

                {format !== 'svg' && (
                    <div className={styles.field}>
                        <span className={styles.fieldLabel}>Taille</span>
                        <SegmentedControl<Scale>
                            aria-label='Taille de l’image'
                            value={scale}
                            onChange={setScale}
                            options={IMAGE_SCALES.map((n) => ({
                                value: `${n}`,
                                label: `${n}×`,
                                ...(preview ? { detail: sizeLabel(pixelSize(preview.width, preview.height, n)) } : {})
                            }))}
                        />
                        <span className={styles.fieldHint}>
                            {reduced
                                ? 'Le tableau est trop grand pour cette taille : l’image est réduite à ce que le navigateur sait dessiner.'
                                : 'En pixels. 2× reste net sur un écran haute définition ou dans une présentation.'}
                        </span>
                    </div>
                )}

                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Thème</span>
                    <SegmentedControl<Theme>
                        aria-label='Thème de l’image'
                        value={theme}
                        onChange={setTheme}
                        options={[
                            { value: 'light', label: 'Clair' },
                            { value: 'dark', label: 'Sombre' }
                        ]}
                    />
                </div>

                <Switch
                    checked={background}
                    disabled={format === 'jpeg'}
                    onChange={setWithBackground}
                    label='Fond du tableau'
                    hint={
                        format === 'jpeg'
                            ? 'Le JPEG n’a pas de transparence : le fond reste.'
                            : 'Sans lui, l’image est transparente.'
                    }
                />

                {copied && (
                    <p className={styles.exportDone} role='status'>
                        Image copiée : elle se colle dans un document ou une conversation.
                    </p>
                )}
                <ErrorNote note={error} />
            </div>
        </Dialog>
    );
}
