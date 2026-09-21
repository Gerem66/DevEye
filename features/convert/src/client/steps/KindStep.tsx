import { CATALOGUE, type ConvertKind } from '../../contracts/catalogue';
import type { ConvertFamily } from '../../contracts/domain';
import { Dropzone } from '../Dropzone';
import { Picto, type PictoId } from '../icons';
import styles from '../style.module.css';

interface KindStepProps {
    families: readonly ConvertFamily[];
    onKind: (kind: ConvertKind) => void;
    onFile: (file: File) => void;
    onTool: (tool: 'currency' | 'units') => void;
}

const TOOLS: readonly { id: 'currency' | 'units'; label: string; description: string }[] = [
    { id: 'currency', label: 'Devises', description: 'Un montant d’une monnaie à l’autre, aux taux du jour.' },
    { id: 'units', label: 'Unités', description: 'Longueurs, masses, températures, volumes, vitesses, données.' }
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

export function KindStep({ families, onKind, onFile, onTool }: KindStepProps) {
    return (
        <div className={styles.stepBody}>
            <Dropzone
                title='Déposez un fichier ici'
                hint='ou cliquez pour le choisir. Son type est reconnu tout seul.'
                onFile={onFile}
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
