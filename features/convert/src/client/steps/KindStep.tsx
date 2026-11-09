import { Dropzone } from 'deveye-sdk-client';

import { CATALOGUE, type ConvertKind } from '../../contracts/catalogue';
import type { ConvertFamily } from '../../contracts/domain';
import { Picto, type PictoId } from '../icons';
import { WORKSHOP_ACCEPT, type WorkshopIntent } from '../pdf/model';
import styles from '../style.module.css';

interface KindStepProps {
    families: readonly ConvertFamily[];
    onKind: (kind: ConvertKind) => void;
    /** Un dépôt sur la zone générale : l'accueil décide s'il part vers l'assistant ou l'atelier PDF. */
    onFiles: (files: File[]) => void;
    onWorkshop: (files: File[], intent: WorkshopIntent) => void;
    onTool: (tool: 'currency' | 'units') => void;
}

const TOOLS: readonly { id: 'currency' | 'units'; label: string; description: string }[] = [
    { id: 'currency', label: 'Devises', description: 'Un montant d’une monnaie à l’autre, aux taux du jour.' },
    { id: 'units', label: 'Unités', description: 'Longueurs, masses, températures, volumes, vitesses, données.' }
];

const PDF_TOOLS: readonly { id: WorkshopIntent; picto: PictoId; label: string; description: string }[] = [
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
    }
];

function Card(props: { picto: PictoId; label: string; description: string; disabled?: boolean; onClick: () => void }) {
    return (
        <li>
            <button type='button' className={styles.card} disabled={props.disabled} onClick={props.onClick}>
                <span className={styles.cardPicto}>
                    <Picto id={props.picto} />
                </span>
                <span className={styles.cardLabel}>{props.label}</span>
                <span className={styles.cardText}>{props.description}</span>
            </button>
        </li>
    );
}

export function KindStep({ families, onKind, onFiles, onWorkshop, onTool }: KindStepProps) {
    return (
        <div className={styles.stepBody}>
            <section className={styles.pdfBand} aria-labelledby='convert-pdf-workshop'>
                <div className={styles.pdfIntro}>
                    <h3 id='convert-pdf-workshop' className={styles.pdfTitle}>
                        <Picto id='pdf' size={22} />
                        Atelier PDF
                    </h3>
                    <p className={styles.pdfText}>
                        Fusionner, extraire, réorganiser, signer, annoter : tout se fait dans votre navigateur, rien
                        n’est envoyé.
                    </p>
                    <Dropzone
                        multiple
                        className={styles.pdfDrop}
                        title='Déposez un ou plusieurs PDF'
                        hint='ou cliquez pour les choisir. Des images aussi : chacune devient une page.'
                        accept={WORKSHOP_ACCEPT}
                        onFiles={(picked) =>
                            onWorkshop(
                                picked.map((p) => p.file),
                                'pages'
                            )
                        }
                    />
                </div>
                <ul className={styles.pdfTools}>
                    {PDF_TOOLS.map((tool) => (
                        <li key={tool.id}>
                            <button type='button' className={styles.pdfTool} onClick={() => onWorkshop([], tool.id)}>
                                <span className={styles.pdfToolPicto}>
                                    <Picto id={tool.picto} size={22} />
                                </span>
                                <span className={styles.pdfToolText}>
                                    <span className={styles.cardLabel}>{tool.label}</span>
                                    <span className={styles.cardText}>{tool.description}</span>
                                </span>
                            </button>
                        </li>
                    ))}
                </ul>
            </section>

            <h3 className={styles.sectionTitle}>Autres conversions</h3>
            <Dropzone
                multiple
                title='Déposez un fichier ici'
                hint='ou cliquez pour le choisir. Son type est reconnu tout seul.'
                onFiles={(picked) => onFiles(picked.map((p) => p.file))}
            />
            <h3 className={styles.sectionTitle}>Ou choisissez ce que vous voulez convertir</h3>
            <ul className={styles.cards}>
                {CATALOGUE.map((kind) => {
                    const family = families.find((f) => f.kind === kind.id);
                    const off = family !== undefined && !family.available;
                    return (
                        <Card
                            key={kind.id}
                            picto={kind.id}
                            label={kind.label}
                            description={off ? (family.reason ?? 'Indisponible sur ce serveur.') : kind.description}
                            disabled={off}
                            onClick={() => onKind(kind.id)}
                        />
                    );
                })}
                {TOOLS.map((tool) => (
                    <Card
                        key={tool.id}
                        picto={tool.id}
                        label={tool.label}
                        description={tool.description}
                        onClick={() => onTool(tool.id)}
                    />
                ))}
            </ul>
        </div>
    );
}
