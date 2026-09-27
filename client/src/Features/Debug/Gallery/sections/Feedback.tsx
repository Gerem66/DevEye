import { useEffect, useState } from 'react';

import Button from '@/Components/Button';
import CountBadge from '@/Components/CountBadge';
import ErrorNote from '@/Components/ErrorNote';
import ReadOnlyNotice from '@/Components/FeatureSettings/ReadOnlyNotice';
import { openInfo } from '@/Components/InfoPopup';
import { PlanPausedBadge, PlanPausedNotice } from '@/Components/PlanPause';
import ProgressDialog from '@/Components/ProgressDialog';
import { StatusBadge } from '@/Components/StatusBadge';
import Term from '@/Components/Term';
import { Specimen, useGalleryDisabled, Variant } from '../Specimen';
import styles from '../Gallery.module.css';

const TONES = ['online', 'offline', 'success', 'warning', 'danger', 'accent', 'neutral'] as const;

export default function Feedback() {
    const disabled = useGalleryDisabled();
    const [progress, setProgress] = useState<number | null>(null);

    // La barre avance d'elle-même, puis la fenêtre se ferme.
    useEffect(() => {
        if (progress === null) return;
        if (progress >= 100) {
            const done = setTimeout(() => setProgress(null), 400);
            return () => clearTimeout(done);
        }
        const tick = setTimeout(() => setProgress((p) => (p === null ? null : p + 10)), 250);
        return () => clearTimeout(tick);
    }, [progress]);

    return (
        <>
            <Specimen title='StatusBadge' note='Sept tons, avec et sans point.'>
                <Variant label='point' wide>
                    {TONES.map((tone) => (
                        <StatusBadge key={tone} tone={tone}>
                            {tone}
                        </StatusBadge>
                    ))}
                </Variant>
                <Variant label='sans point' wide>
                    {TONES.map((tone) => (
                        <StatusBadge key={tone} tone={tone} dot={false}>
                            {tone}
                        </StatusBadge>
                    ))}
                </Variant>
            </Specimen>
            <Specimen title='CountBadge'>
                <Variant label='accent'>
                    <CountBadge count={3} />
                    <CountBadge count={42} />
                    <CountBadge count={150} />
                </Variant>
                <Variant label='neutre'>
                    <CountBadge count={7} tone='neutral' />
                </Variant>
            </Specimen>
            <Specimen title='ErrorNote' note='Le bouton de signalement n’apparaît que pour une panne.'>
                <Variant label='refus ordinaire' wide>
                    <ErrorNote note={{ message: 'Ce nom est déjà pris.', code: 'conflict' }} />
                </Variant>
                <Variant label='panne' wide>
                    <ErrorNote note={{ message: 'Erreur interne du serveur.', code: 'internal' }}>
                        <Button variant='secondary' disabled={disabled}>
                            Réessayer
                        </Button>
                    </ErrorNote>
                </Variant>
            </Specimen>
            <Specimen title='ReadOnlyNotice'>
                <Variant label='lecture seule' wide>
                    <ReadOnlyNotice>Votre rôle ne permet pas de modifier ces réglages.</ReadOnlyNotice>
                </Variant>
            </Specimen>
            <Specimen title='PlanPausedBadge et PlanPausedNotice'>
                <Variant label='pastille'>
                    <PlanPausedBadge />
                </Variant>
                <Variant label='bandeau' wide>
                    <PlanPausedNotice count={2} one='surveillance' many='surveillances' />
                </Variant>
            </Specimen>
            <Specimen title='Term, openInfo, ProgressDialog'>
                <Variant label='Term' wide>
                    <p className={styles.demoText}>
                        Activez la <Term id='twoFactor' /> pour protéger votre compte.
                    </p>
                </Variant>
                <Variant label='openInfo'>
                    <Button
                        variant='secondary'
                        icon='info'
                        disabled={disabled}
                        onClick={() =>
                            void openInfo({
                                title: 'Une explication',
                                body: 'Le même comportement partout : un titre, un corps, Échap pour fermer.'
                            })
                        }
                    >
                        Ouvrir
                    </Button>
                </Variant>
                <Variant label='ProgressDialog'>
                    <Button variant='secondary' disabled={disabled || progress !== null} onClick={() => setProgress(0)}>
                        Lancer
                    </Button>
                </Variant>
            </Specimen>
            <ProgressDialog
                open={progress !== null}
                title='Traitement en cours'
                description='La fenêtre se ferme toute seule à la fin.'
                value={progress ?? 0}
                step={`${progress ?? 0} %`}
            />
        </>
    );
}
