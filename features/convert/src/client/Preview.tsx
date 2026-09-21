import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { Dialog } from 'deveye-sdk-client';

import type { ConvertKind } from '../contracts/catalogue';
import type { MediaInfo } from '../contracts/estimate';
import { cropRect, imageDims, type Dims } from '../contracts/geometry';
import type { CropValue, SizeValue } from '../contracts/options';
import { Compare } from './Compare';
import { framing } from './framing';
import { Picto } from './icons';
import { Player } from './Player';
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
    /** Le passage gardé d'une vidéo ou d'un son, en secondes. */
    trim: { start: number | null; end: number | null };
    /** La cadence et les dimensions d'un GIF à venir : l'aperçu les imite. */
    simulate: { fps: number; dims: Dims } | null;
    /** L'image telle qu'elle sortirait. Présente, l'aperçu devient une comparaison avant / après. */
    sample: Blob | null;
    /** Le résultat est prêt : un bouton discret le donne, à côté de l'agrandissement. */
    onDownload: (() => void) | null;
}

/** La vue agrandie prend ce que la fenêtre offre : le dialogue borne de lui-même sa largeur. */
const ZOOM_WIDTH = 2400;
/** Une image minuscule reste visible, sans être étalée sur toute la colonne. */
const MIN_SHOWN_WIDTH = 320;

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
export function Preview(props: PreviewProps) {
    const { file, kind, isPdf, info, crop, resize, trim, simulate, sample, onDownload } = props;
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

    const source = info?.width && info.height ? { width: info.width, height: info.height } : null;
    const area = source ? cropRect(source, crop) : null;
    const playable = !failed && (kind === 'video' || kind === 'audio');
    const zoomable = !failed && (kind === 'image' || kind === 'video' || isPdf);

    /** Les boutons posés en bas à droite du cadre. Absents de la vue agrandie, qui n'a que l'image. */
    const actions: ReactNode = (
        <div className={styles.previewActions}>
            {onDownload && (
                <button
                    type='button'
                    className={styles.previewAction}
                    aria-label='Télécharger le fichier converti'
                    title='Télécharger'
                    onClick={onDownload}
                >
                    <span className='icon icon-download' aria-hidden='true' />
                </button>
            )}
            {zoomable && (
                <button
                    type='button'
                    className={styles.previewAction}
                    aria-label='Agrandir l’aperçu'
                    title='Agrandir'
                    onClick={() => setZoomed(true)}
                >
                    <span className='icon icon-expand' aria-hidden='true' />
                </button>
            )}
        </div>
    );

    /** L'image, à la taille du cadre ou à celle de la vue agrandie : les deux partagent tout, curseur compris. */
    const picture = (large: boolean): ReactNode => {
        const image = { src: url, alt: `Aperçu de ${file.name}`, draggable: false, onError: () => setFailed(true) };
        // Dimensions encore inconnues : l'image entière, sans cadrage ni comparaison.
        if (!source) return <img className={styles.previewImage} {...image} />;

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

    const player = (suspended: boolean, shown: ReactNode): ReactNode => (
        <Player
            kind={kind === 'audio' ? 'audio' : 'video'}
            url={url}
            name={file.name}
            source={source}
            area={area}
            start={trim.start}
            end={trim.end}
            simulate={simulate}
            suspended={suspended}
            actions={shown}
            onError={() => setFailed(true)}
        />
    );

    let body: ReactNode;
    if (failed) {
        body = (
            <NoPreview
                kind={kind}
                reason='Votre navigateur ne sait pas afficher ce format. La conversion fonctionne quand même.'
            />
        );
    } else if (kind === 'image') {
        body = picture(false);
    } else if (isPdf) {
        body = <iframe className={styles.previewPdf} src={url} title={`Aperçu de ${file.name}`} />;
    } else {
        body = (
            <NoPreview
                kind={kind}
                reason='Pas d’aperçu pour ce type de document. La conversion fonctionne quand même.'
            />
        );
    }

    return (
        <>
            {playable ? (
                player(zoomed, actions)
            ) : (
                <div className={styles.previewFrame}>
                    {body}
                    {actions}
                </div>
            )}
            <Dialog open={zoomed} onClose={() => setZoomed(false)} width={ZOOM_WIDTH}>
                <div className={styles.zoomStage}>
                    {kind === 'video' ? (
                        player(false, null)
                    ) : isPdf ? (
                        <iframe className={styles.previewPdf} src={url} title={`Aperçu de ${file.name}`} />
                    ) : (
                        picture(true)
                    )}
                </div>
            </Dialog>
        </>
    );
}
