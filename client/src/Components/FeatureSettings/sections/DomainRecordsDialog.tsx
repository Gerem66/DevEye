import { useState } from 'react';
import type { DnsRecord, FeatureDomain } from '@deveye/types';

import Button from '@/Components/Button';
import { Dialog, DialogCancelButton } from '@/Components/Dialog';
import { StatusBadge, type BadgeTone } from '@/Components/StatusBadge';
import { copyText } from '@/copyText';
import shell from '../FeatureSettings.module.css';
import styles from './Domains.module.css';

interface Props {
    /** Lu dans la liste vivante par l'appelant : les états bougent quand la vérification répond. */
    domain: FeatureDomain | null;
    /** La phrase de l'étape 2 (`manifest.domains.service`). */
    service: string;
    /** Comment un domaine web obtient son certificat ici ; `null` pour des domaines qui ne sont pas web. */
    https: 'auto' | 'manual' | null;
    canWrite: boolean;
    busy: boolean;
    onVerify: () => void;
    onClose: () => void;
}

type Chip = { tone: BadgeTone; label: string };

function ownershipChip(domain: FeatureDomain): Chip {
    if (domain.dnsState === 'ok') return { tone: 'success', label: 'Prouvé' };
    if (domain.dnsState === 'failed') return { tone: 'warning', label: 'Introuvable' };
    return { tone: 'neutral', label: 'En attente' };
}

function serviceChip(domain: FeatureDomain): Chip {
    if (domain.dnsState !== 'ok') return { tone: 'neutral', label: 'Après l’étape 1' };
    if (domain.probeState === 'ok') return { tone: 'success', label: 'Opérationnel' };
    if (domain.probeState === 'failed') return { tone: 'danger', label: 'Ne répond pas' };
    if (domain.probeError) return { tone: 'accent', label: 'En cours' };
    return { tone: 'neutral', label: 'En attente' };
}

const CERTIFICATE: Record<'auto' | 'manual', string> = {
    auto: 'Le certificat HTTPS s’obtient ensuite tout seul, en quelques minutes.',
    manual: 'Il doit ensuite être ajouté au proxy du serveur qui héberge DevEye, pour obtenir son certificat HTTPS : c’est la seule étape que DevEye ne fait pas seul.'
};

function verifiedChip(domain: FeatureDomain): Chip {
    return domain.verifiedAt === null
        ? { tone: 'neutral', label: 'À vérifier' }
        : { tone: 'success', label: `Vérifié le ${new Date(domain.verifiedAt * 1000).toLocaleDateString('fr-FR')}` };
}

/** La valeur telle qu'on la saisit chez l'hébergeur : la priorité d'un MX en fait partie. */
function valueOf(record: DnsRecord): string {
    return record.priority === undefined ? record.value : `${record.priority} ${record.value}`;
}

function CopyButton({ text, label, onFailure }: { text: string; label: string; onFailure: () => void }) {
    const [done, setDone] = useState(false);
    const copy = async () => {
        if (!(await copyText(text))) {
            onFailure();
            return;
        }
        setDone(true);
        window.setTimeout(() => setDone(false), 2000);
    };
    return (
        <button
            type='button'
            className={`${styles.copyBtn} ${done ? styles.copyBtnDone : ''}`}
            title={done ? 'Copié' : label}
            aria-label={label}
            onClick={() => void copy()}
        >
            <span className={`icon icon-${done ? 'square-check' : 'copy'}`} />
        </button>
    );
}

function RecordTable({ records }: { records: readonly DnsRecord[] }) {
    const [copyFailed, setCopyFailed] = useState(false);
    if (records.length === 0) return null;
    return (
        <>
            <div className={styles.records} role='table' aria-label='Enregistrements DNS à publier'>
                <div className={styles.recordHead} role='row'>
                    <span role='columnheader'>Type</span>
                    <span role='columnheader'>Nom</span>
                    <span role='columnheader'>Valeur</span>
                </div>
                {records.map((record) => (
                    <div key={`${record.type} ${record.name} ${record.value}`} className={styles.recordRow} role='row'>
                        <span className={styles.recordType} role='cell'>
                            {record.type}
                        </span>
                        <span className={styles.recordCell} role='cell'>
                            <code className={styles.recordValue}>{record.name}</code>
                            <CopyButton
                                text={record.name}
                                label='Copier le nom'
                                onFailure={() => setCopyFailed(true)}
                            />
                        </span>
                        <span className={styles.recordCell} role='cell'>
                            <code className={styles.recordValue}>{valueOf(record)}</code>
                            <CopyButton
                                text={valueOf(record)}
                                label='Copier la valeur'
                                onFailure={() => setCopyFailed(true)}
                            />
                        </span>
                    </div>
                ))}
            </div>
            {copyFailed && <p className={shell.errorText}>Copie impossible : sélectionnez le texte à la main.</p>}
        </>
    );
}

function Step({
    index,
    title,
    chip,
    done,
    children
}: {
    index: number;
    title: string;
    chip: Chip;
    done: boolean;
    children: React.ReactNode;
}) {
    return (
        <li className={styles.step}>
            <span className={`${styles.stepBadge} ${done ? styles.stepBadgeDone : ''}`} aria-hidden='true'>
                {index}
            </span>
            <div className={styles.stepBody}>
                <div className={styles.stepHead}>
                    <span className={styles.stepTitle}>{title}</span>
                    <StatusBadge tone={chip.tone}>{chip.label}</StatusBadge>
                </div>
                {children}
            </div>
        </li>
    );
}

/** Ce qu'un domaine demande de publier, et où il en est, en trois étapes. */
export default function DomainRecordsDialog({ domain, service, https, canWrite, busy, onVerify, onClose }: Props) {
    if (domain === null) return null;
    return (
        <Dialog
            open
            onClose={onClose}
            title={domain.host}
            description='Trois étapes, dans l’ordre. Chacune dit où elle en est.'
            width={820}
            footer={<DialogCancelButton variant='ghost'>Fermer</DialogCancelButton>}
        >
            <ol className={styles.steps}>
                <Step
                    index={1}
                    title='Prouver que le domaine est à vous'
                    chip={ownershipChip(domain)}
                    done={domain.dnsState === 'ok'}
                >
                    <p className={styles.stepText}>Ajoutez cet enregistrement chez votre hébergeur DNS.</p>
                    <RecordTable records={[domain.ownership]} />
                    {domain.dnsError && <p className={shell.errorText}>{domain.dnsError}</p>}
                </Step>

                <Step
                    index={2}
                    title='Relier le domaine au service'
                    chip={serviceChip(domain)}
                    done={domain.dnsState === 'ok' && domain.probeState === 'ok'}
                >
                    <p className={styles.stepText}>
                        {service}
                        {https !== null && ` ${CERTIFICATE[https]}`}
                    </p>
                    <RecordTable records={domain.records} />
                    {domain.probeError && (
                        <p className={domain.probeState === 'pending' ? styles.stepNote : shell.errorText}>
                            {domain.probeError}
                        </p>
                    )}
                </Step>

                <Step index={3} title='Vérifier' chip={verifiedChip(domain)} done={domain.verifiedAt !== null}>
                    <p className={styles.stepText}>
                        DevEye relit le DNS puis sonde le service. Ensuite, il revérifie tout seul.
                    </p>
                    {canWrite && (
                        <div className={styles.stepAction}>
                            <Button variant='secondary' icon='refresh' disabled={busy} onClick={onVerify}>
                                Vérifier maintenant
                            </Button>
                            <span className={styles.stepNote}>
                                Un DNS neuf met parfois quelques minutes à se propager.
                            </span>
                        </div>
                    )}
                </Step>
            </ol>
        </Dialog>
    );
}
