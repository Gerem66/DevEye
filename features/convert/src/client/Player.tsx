import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

import type { Dims, Rect } from '../contracts/geometry';
import { framing } from './framing';
import { Picto } from './icons';
import styles from './style.module.css';

interface PlayerProps {
    kind: 'video' | 'audio';
    url: string;
    name: string;
    /** Les dimensions de la vidéo. Inconnues, elle se montre entière, sans recadrage. */
    source: Dims | null;
    area: Rect | null;
    /** Le passage gardé, en secondes. `null` : depuis le début, jusqu'à la fin. */
    start: number | null;
    end: number | null;
    /** Une autre vue du même fichier a pris le relais : celle-ci se tait. */
    suspended: boolean;
    /** Les boutons posés sur le cadre. */
    actions: ReactNode;
    onError: () => void;
}

const clock = (seconds: number): string => {
    const total = Math.max(0, Math.floor(seconds));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Le lecteur de l'aperçu. Maison, et non celui du navigateur, pour deux raisons :
 * ses commandes restent hors de l'image, qui peut ainsi être recadrée en CSS
 * comme elle le sera ; et la lecture se borne au passage gardé, si bien que
 * régler le début ou la fin montre aussitôt l'image où l'on coupe. Rien n'est
 * encodé : définition, cadence et qualité ne se voient qu'au résultat.
 */
export function Player({ kind, url, name, source, area, start, end, suspended, actions, onError }: PlayerProps) {
    const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
    const [duration, setDuration] = useState<number | null>(null);
    const [time, setTime] = useState(0);
    const [playing, setPlaying] = useState(false);

    const from = Math.min(Math.max(start ?? 0, 0), duration ?? Infinity);
    const to = end !== null && end > from ? Math.min(end, duration ?? end) : (duration ?? 0);

    const seek = (seconds: number): void => {
        if (!media.current) return;
        media.current.currentTime = seconds;
        setTime(seconds);
    };

    // Bouger le début montre l'image du début, bouger la fin celle de la fin :
    // c'est là qu'on coupe, et c'est ce qu'on veut voir en réglant.
    const previous = useRef({ from, to, duration });
    useEffect(() => {
        const was = previous.current;
        previous.current = { from, to, duration };
        if (duration === null) return;
        if (was.duration !== duration || was.from !== from) seek(from);
        else if (was.to !== to) seek(Math.max(from, to - 0.05));
    }, [from, to, duration]);

    useEffect(() => {
        if (suspended) media.current?.pause();
    }, [suspended]);

    const toggle = (): void => {
        const element = media.current;
        if (!element) return;
        if (!element.paused) return element.pause();
        if (element.currentTime < from || element.currentTime >= to - 0.05) seek(from);
        void element.play().catch(() => undefined);
    };

    const shared = {
        ref: media,
        src: url,
        preload: 'metadata' as const,
        onError,
        onLoadedMetadata: () => {
            const total = media.current?.duration;
            setDuration(total !== undefined && Number.isFinite(total) ? total : null);
        },
        onPlay: () => setPlaying(true),
        onPause: () => setPlaying(false),
        onTimeUpdate: () => {
            const element = media.current;
            if (!element) return;
            setTime(element.currentTime);
            // La lecture s'arrête où le résultat s'arrêtera.
            if (to > from && element.currentTime >= to) element.pause();
        }
    };

    const ratio = area ? area.width / area.height : source ? source.width / source.height : null;
    return (
        <>
            <div className={styles.previewFrame}>
                {kind === 'audio' ? (
                    <div className={styles.noPreview}>
                        <Picto id='audio' size={40} />
                        <audio {...shared}>
                            <track kind='captions' />
                        </audio>
                    </div>
                ) : source && ratio ? (
                    <div className={styles.stage} style={{ '--ratio': ratio } as CSSProperties}>
                        <video
                            {...shared}
                            className={styles.stageLayer}
                            style={framing(source, area)}
                            playsInline
                            aria-label={`Aperçu de ${name}`}
                            onClick={toggle}
                        >
                            <track kind='captions' />
                        </video>
                    </div>
                ) : (
                    <video
                        {...shared}
                        className={styles.previewVideo}
                        playsInline
                        aria-label={`Aperçu de ${name}`}
                        onClick={toggle}
                    >
                        <track kind='captions' />
                    </video>
                )}
                {actions}
            </div>
            <div className={styles.playerBar}>
                <button
                    type='button'
                    className={styles.playerButton}
                    aria-label={playing ? 'Mettre en pause' : 'Lire le passage gardé'}
                    disabled={duration === null}
                    onClick={toggle}
                >
                    <span className={`icon ${playing ? 'icon-pause' : 'icon-play'}`} aria-hidden='true' />
                </button>
                <input
                    className={styles.playerSeek}
                    type='range'
                    min={from}
                    max={Math.max(to, from)}
                    step={0.05}
                    value={Math.min(Math.max(time, from), Math.max(to, from))}
                    disabled={duration === null}
                    aria-label='Position dans le passage gardé'
                    aria-valuetext={`${clock(time - from)} sur ${clock(to - from)}`}
                    onChange={(event) => seek(Number(event.target.value))}
                />
                <span className={styles.playerTime}>
                    {clock(time - from)} / {clock(to - from)}
                </span>
            </div>
        </>
    );
}
