import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from 'deveye-sdk-client';

import type { ConvertKind } from '../contracts/catalogue';
import type { MediaInfo } from '../contracts/estimate';
import { cropRect, imageDims, type Dims, type Rect } from '../contracts/geometry';
import type { CropValue, SizeValue } from '../contracts/options';
import { Compare } from './Compare';
import { Picto } from './icons';
import styles from './style.module.css';
import { useObjectUrl } from './useObjectUrl';

interface PreviewProps {
    file: File;
    kind: ConvertKind;
    /** Un PDF se montre, les autres documents non : aucun navigateur ne sait les ouvrir. */
    isPdf: boolean;
    info: MediaInfo | null;
    crop: CropValue | null;
    resize: SizeValue;
    /** L'image telle qu'elle sortirait. Présente, l'aperçu devient une comparaison avant / après. */
    sample: Blob | null;
}

/** La vue agrandie prend ce que la fenêtre offre : le dialogue borne de lui-même sa largeur. */
const ZOOM_WIDTH = 2400;
/** Une image minuscule reste visible, sans être étalée sur toute la colonne. */
const MIN_SHOWN_WIDTH = 320;

/**
 * Le cadrage du résultat appliqué à l'image d'origine, en CSS pur : l'image est
 * agrandie et décalée derrière une fenêtre aux proportions du recadrage.
 */
function framing(source: Dims, area: Rect | null): CSSProperties {
    if (!area) return { width: '100%', height: '100%', left: 0, top: 0 };
    return {
        width: `${(source.width / area.width) * 100}%`,
        height: `${(source.height / area.height) * 100}%`,
        left: `${(-area.x / area.width) * 100}%`,
        top: `${(-area.y / area.height) * 100}%`
    };
}

function NoPreview({ kind, reason }: { kind: ConvertKind; reason: string }) {
    return (
        <div className={styles.noPreview}>
            <Picto id={kind} size={40} />
            <p>{reason}</p>
        </div>
    );
}

/**
 * L'aperçu du fichier choisi, lu dans le navigateur : rien n'est envoyé. Un
 * format que le navigateur ne sait pas ouvrir garde le cadre et le dit ; la
 * conversion, elle, se fait sur le serveur et n'en dépend pas.
 */
export function Preview({ file, kind, isPdf, info, crop, resize, sample }: PreviewProps) {
    const url = useObjectUrl(file, isPdf ? 'application/pdf' : undefined);
    const sampleUrl = useObjectUrl(sample);
    const [failed, setFailed] = useState(false);
    const [zoomed, setZoomed] = useState(false);
    const [split, setSplit] = useState(50);
    useEffect(() => {
        setFailed(false);
        setZoomed(false);
    }, [file]);

    if (!url) return <div className={styles.previewFrame} />;

    /** L'image, à la taille du cadre ou à celle de la vue agrandie : les deux partagent tout, curseur compris. */
    const picture = (large: boolean): ReactNode => {
        const image = { src: url, alt: `Aperçu de ${file.name}`, draggable: false, onError: () => setFailed(true) };
        const source = info?.width && info.height ? { width: info.width, height: info.height } : null;
        // Dimensions encore inconnues : l'image entière, sans cadrage ni comparaison.
        if (!source) return <img className={styles.previewImage} {...image} />;

        const area = cropRect(source, crop);
        const output = imageDims(source, crop, resize);
        const shape = {
            '--ratio': output.width / output.height,
            ...(large ? {} : { '--natural-w': `${Math.max(area?.width ?? source.width, MIN_SHOWN_WIDTH)}px` })
        } as CSSProperties;
        const original = <img className={styles.stageLayer} style={framing(source, area)} {...image} />;
        return (
            <div className={styles.stage} style={shape}>
                {sampleUrl ? (
                    <Compare before={original} afterUrl={sampleUrl} split={split} onSplit={setSplit} />
                ) : (
                    original
                )}
            </div>
        );
    };

    let body: ReactNode;
    let zoomable = false;
    if (failed) {
        body = (
            <NoPreview
                kind={kind}
                reason='Votre navigateur ne sait pas afficher ce format. La conversion fonctionne quand même.'
            />
        );
    } else if (kind === 'image') {
        body = picture(false);
        zoomable = true;
    } else if (kind === 'video') {
        body = (
            <video
                className={styles.previewVideo}
                src={url}
                controls
                preload='metadata'
                onError={() => setFailed(true)}
            >
                <track kind='captions' />
            </video>
        );
    } else if (kind === 'audio') {
        body = (
            <div className={styles.noPreview}>
                <Picto id='audio' size={40} />
                <audio
                    className={styles.previewAudio}
                    src={url}
                    controls
                    preload='metadata'
                    onError={() => setFailed(true)}
                >
                    <track kind='captions' />
                </audio>
            </div>
        );
    } else if (isPdf) {
        body = <iframe className={styles.previewPdf} src={url} title={`Aperçu de ${file.name}`} />;
        zoomable = true;
    } else {
        body = (
            <NoPreview
                kind={kind}
                reason='Pas d’aperçu pour ce type de document. La conversion fonctionne quand même.'
            />
        );
    }

    return (
        <div className={styles.previewFrame}>
            {body}
            {zoomable && (
                <button
                    type='button'
                    className={styles.zoomButton}
                    aria-label='Agrandir l’aperçu'
                    title='Agrandir'
                    onClick={() => setZoomed(true)}
                >
                    <span className='icon icon-expand' aria-hidden='true' />
                </button>
            )}
            {/* La vidéo n'en a pas besoin : son lecteur a déjà son plein écran. */}
            <Dialog open={zoomed} onClose={() => setZoomed(false)} width={ZOOM_WIDTH}>
                <div className={styles.zoomStage}>
                    {isPdf ? (
                        <iframe className={styles.previewPdf} src={url} title={`Aperçu de ${file.name}`} />
                    ) : (
                        picture(true)
                    )}
                </div>
            </Dialog>
        </div>
    );
}
