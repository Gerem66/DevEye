import { lazy, Suspense, useState } from 'react';
import { Dropzone, LoadingVeil, StickyHeader, useHandedFile } from 'deveye-sdk-client';
import type { FeatureViewProps } from '@deveye/types/sdk/client';

import { manifest } from '../manifest';
import { Picto, type PictoId } from './icons';
import { WORKSHOP_ACCEPT, type WorkshopIntent } from './model';
import styles from './pdf.module.css';

/** L'atelier et ses bibliothèques ne se chargent qu'en y entrant. */
const PdfWorkshop = lazy(() => import('./PdfWorkshop'));

const GESTURES: readonly { id: WorkshopIntent; picto: PictoId; label: string; description: string }[] = [
    { id: 'merge', picto: 'merge', label: 'Fusionner', description: 'Plusieurs PDF en un seul, dans l’ordre voulu.' },
    {
        id: 'extract',
        picto: 'extract',
        label: 'Extraire des pages',
        description: 'Garder quelques pages, ou en tirer un nouveau document.'
    },
    {
        id: 'reorder',
        picto: 'reorder',
        label: 'Réorganiser',
        description: 'Déplacer, faire pivoter, dupliquer ou retirer des pages.'
    },
    {
        id: 'sign',
        picto: 'signature',
        label: 'Signer et annoter',
        description: 'Signature, paraphe, date, texte, surlignage, caviardage.'
    },
    {
        id: 'form',
        picto: 'check',
        label: 'Remplir un formulaire',
        description: 'Les champs d’un PDF à remplir, puis figés si vous voulez.'
    },
    { id: 'text', picto: 'text', label: 'Lire le texte', description: 'Le texte d’un PDF, page par page, à copier.' },
    {
        id: 'protect',
        picto: 'lock',
        label: 'Protéger et finir',
        description: 'Mot de passe, numéros de page, filigrane, propriétés.'
    }
];

interface Session {
    files: File[];
    intent: WorkshopIntent;
}

export default function Pdf(_props: FeatureViewProps) {
    const [session, setSession] = useState<Session | null>(null);

    // Un PDF que le Convertisseur nous confie : l'atelier s'ouvre dessus.
    useHandedFile('pdf', ({ file }) => setSession({ files: [file], intent: 'pages' }));

    if (session) {
        return (
            <Suspense
                fallback={
                    <div className={styles.root}>
                        <LoadingVeil label='Ouverture de l’atelier…' />
                    </div>
                }
            >
                <PdfWorkshop initialFiles={session.files} intent={session.intent} onLeave={() => setSession(null)} />
            </Suspense>
        );
    }

    return (
        <div className={styles.root}>
            <StickyHeader>
                <header className={styles.header}>
                    <div className={styles.headTitle}>
                        <h2 className={styles.heading}>{manifest.label}</h2>
                        <p className={styles.subheading}>Tout se fait dans votre navigateur : rien n’est envoyé.</p>
                    </div>
                </header>
            </StickyHeader>
            <div className={styles.landing}>
                <Dropzone
                    multiple
                    className={styles.landingDrop}
                    title='Déposez un ou plusieurs PDF'
                    hint='ou cliquez pour les choisir. Des images aussi : chacune devient une page.'
                    accept={WORKSHOP_ACCEPT}
                    onFiles={(picked) => setSession({ files: picked.map((p) => p.file), intent: 'pages' })}
                />
                <h3 className={styles.sectionTitle}>Ou commencez par ce que vous voulez faire</h3>
                <ul className={styles.gestures}>
                    {GESTURES.map((g) => (
                        <li key={g.id}>
                            <button
                                type='button'
                                className={styles.gesture}
                                onClick={() => setSession({ files: [], intent: g.id })}
                            >
                                <span className={styles.gesturePicto}>
                                    <Picto id={g.picto} size={22} />
                                </span>
                                <span className={styles.gestureText}>
                                    <span className={styles.gestureLabel}>{g.label}</span>
                                    <span className={styles.gestureHint}>{g.description}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
        </div>
    );
}
