import { useEffect, useState, type CSSProperties } from 'react';

import type { ConvertKind } from '../contracts/catalogue';
import type { MediaInfo } from '../contracts/estimate';
import { clampCrop } from '../contracts/geometry';
import type { CropValue } from '../contracts/options';
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
    /** L'image telle qu'elle sortirait. Présente, l'aperçu devient une comparaison avant / après. */
    sample: Blob | null;
}

/**
 * Le cadrage du résultat appliqué à l'image d'origine, en CSS pur : l'image est
 * agrandie et décalée derrière une fenêtre aux proportions du recadrage.
 */
function framing(source: { width: number; height: number }, crop: CropValue | null): CSSProperties {
    if (!crop) return { width: '100%', height: '100%', left: 0, top: 0 };
    return {
        width: `${(source.width / crop.width) * 100}%`,
        height: `${(source.height / crop.height) * 100}%`,
        left: `${(-crop.x / crop.width) * 100}%`,
        top: `${(-crop.y / crop.height) * 100}%`
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
export function Preview({ file, kind, isPdf, info, crop, sample }: PreviewProps) {
    const url = useObjectUrl(file, isPdf ? 'application/pdf' : undefined);
    const sampleUrl = useObjectUrl(sample);
    const [failed, setFailed] = useState(false);
    useEffect(() => setFailed(false), [file]);

    const unreadable = 'Votre navigateur ne sait pas afficher ce format. La conversion fonctionne quand même.';
    if (!url) return <div className={styles.previewFrame} />;

    let body: React.ReactNode;
    if (failed) {
        body = <NoPreview kind={kind} reason={unreadable} />;
    } else if (kind === 'image') {
        const source = info?.width && info.height ? { width: info.width, height: info.height } : null;
        const area = source ? clampCrop(source, crop) : null;
        const ratio = area ? area.width / area.height : source ? source.width / source.height : null;
        const image = { src: url, alt: `Aperçu de ${file.name}`, draggable: false, onError: () => setFailed(true) };
        if (!source || !ratio) {
            // Dimensions encore inconnues : l'image entière, sans cadrage ni comparaison.
            body = <img className={styles.previewImage} {...image} />;
        } else {
            const original = <img className={styles.stageLayer} style={framing(source, area)} {...image} />;
            body = (
                <div className={styles.stage} style={{ '--ratio': ratio } as CSSProperties}>
                    {sampleUrl ? <Compare before={original} afterUrl={sampleUrl} /> : original}
                </div>
            );
        }
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
    } else {
        body = (
            <NoPreview
                kind={kind}
                reason='Pas d’aperçu pour ce type de document. La conversion fonctionne quand même.'
            />
        );
    }

    return <div className={styles.previewFrame}>{body}</div>;
}
