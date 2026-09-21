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
    /**
     * Le résultat sera un GIF : l'aperçu se dessine à sa cadence et à ses
     * dimensions, muet et en boucle, comme lui. `null` : la vidéo telle quelle.
     */
    simulate: { fps: number; dims: Dims } | null;
    /**
     * Faire de l'instant affiché le début ou la fin du passage gardé. Absent là
     * où le passage ne se règle pas : la pastille ne s'offre alors pas.
     */
    onTrim: ((edge: 'start' | 'end', seconds: number) => void) | null;
    /** Une autre vue du même fichier a pris le relais : celle-ci se tait. */
    suspended: boolean;
    /** Les boutons posés sur le cadre. */
    actions: ReactNode;
    onError: () => void;
}

/** Aux extrémités du passage, il n'y a rien à couper : la pastille ne s'offre qu'au-delà. */
const TRIM_MARGIN = 0.2;

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
export function Player(props: PlayerProps) {
    const { kind, url, name, source, area, start, end, simulate, onTrim, suspended, actions, onError } = props;
    const media = useRef<HTMLVideoElement & HTMLAudioElement>(null);
    const canvas = useRef<HTMLCanvasElement>(null);
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

    // Le GIF simulé : la vidéo joue hors de vue, et une image n'est recopiée sur
    // le canevas que lorsque la cadence choisie le veut. On y voit les saccades
    // et la définition du résultat, pas sa palette de 256 couleurs.
    const fps = simulate?.fps ?? null;
    // En nombres, et non par `source` ou `area` : ces objets renaissent à chaque rendu, et la boucle avec eux.
    const [areaX, areaY] = [area?.x ?? 0, area?.y ?? 0];
    const [areaW, areaH] = [area?.width ?? source?.width, area?.height ?? source?.height];
    useEffect(() => {
        if (fps === null || areaW === undefined || areaH === undefined) return;
        let frame = 0;
        let drawnAt = -1;
        const tick = (): void => {
            const video = media.current;
            const surface = canvas.current;
            if (video && surface && video.readyState >= 2 && !video.seeking) {
                const at = video.currentTime;
                const due = video.paused ? at !== drawnAt : Math.abs(at - drawnAt) >= 1 / fps;
                if (drawnAt < 0 || due) {
                    surface
                        .getContext('2d')
                        ?.drawImage(video, areaX, areaY, areaW, areaH, 0, 0, surface.width, surface.height);
                    drawnAt = at;
                }
            }
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [fps, areaX, areaY, areaW, areaH, simulate?.dims.width, simulate?.dims.height]);

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
            // La lecture s'arrête où le résultat s'arrêtera ; un GIF, lui, repart du début.
            if (to > from && element.currentTime >= to) {
                if (simulate) seek(from);
                else element.pause();
            }
        }
    };

    const ratio = simulate
        ? simulate.dims.width / simulate.dims.height
        : area
          ? area.width / area.height
          : source
            ? source.width / source.height
            : null;
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
                ) : source && ratio && simulate ? (
                    <div className={styles.stage} style={{ '--ratio': ratio } as CSSProperties}>
                        <video {...shared} className={styles.playerHidden} muted playsInline>
                            <track kind='captions' />
                        </video>
                        <canvas
                            ref={canvas}
                            className={styles.stageLayer}
                            style={{ width: '100%', height: '100%', left: 0, top: 0 }}
                            width={simulate.dims.width}
                            height={simulate.dims.height}
                            role='img'
                            aria-label={`Aperçu du GIF tiré de ${name}`}
                            onClick={toggle}
                        />
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
                <div className={styles.playerSeekWrap}>
                    {onTrim && time > from + TRIM_MARGIN && time < to - TRIM_MARGIN && (
                        <div
                            className={styles.trimPill}
                            style={{ '--at': (time - from) / (to - from) } as CSSProperties}
                        >
                            <button
                                type='button'
                                title='Définir ce point comme début'
                                onClick={() => onTrim('start', Math.round(time * 10) / 10)}
                            >
                                Début ici
                            </button>
                            <button
                                type='button'
                                title='Définir ce point comme fin'
                                onClick={() => onTrim('end', Math.round(time * 10) / 10)}
                            >
                                Fin ici
                            </button>
                        </div>
                    )}
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
                </div>
                <span className={styles.playerTime}>
                    {clock(time - from)} / {clock(to - from)}
                </span>
            </div>
            {simulate && (
                <p className={styles.playerNote}>
                    Aperçu des dimensions et de la cadence. Les couleurs d’un GIF, limitées à 256, seront un peu moins
                    fines.
                </p>
            )}
        </>
    );
}
