import { useState } from 'react';
import { featureDescriptor, type FeatureDomain } from '@deveye/types';

import { ws } from '@/api/ws';
import { humanizeError } from '@/api/useResource';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { Dialog } from '@/Components/Dialog';
import { StatusBadge, type BadgeTone } from '@/Components/StatusBadge';
import TextInput from '@/Components/TextInput';
import { moduleManifest } from '@/sdk/registry';
import { useDomains } from '@/sdk/useDomains';
import { invalidateTopic } from '@/stores/invalidation';
import { useWorkspacePermissions } from '@/stores/workspace';
import ReadOnlyNotice from '../ReadOnlyNotice';
import type { SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';
import DomainRecordsDialog from './DomainRecordsDialog';

function rowBadge(domain: FeatureDomain): { tone: BadgeTone; label: string } {
    if (domain.verifiedAt !== null && domain.dnsState === 'ok' && domain.probeState === 'ok') {
        return { tone: 'success', label: 'Vérifié' };
    }
    if (domain.dnsState !== 'ok') return { tone: 'warning', label: 'Propriété à prouver' };
    if (domain.probeState === 'failed') return { tone: 'danger', label: 'Ne répond pas' };
    return { tone: 'neutral', label: 'À vérifier' };
}

/**
 * Les domaines d'une fonctionnalité, rendus par la coquille pour tout module
 * qui en déclare (`manifest.domains`). Mêmes formes que la liste des canaux.
 */
export default function DomainsSection({ scope }: { scope: SettingsScope }) {
    const feature = scope.feature;
    const copy = moduleManifest(feature)?.domains;
    const canWrite = useWorkspacePermissions().canFeature(feature, 'write');
    const { domains, loading, error: loadError } = useDomains(feature);

    const [host, setHost] = useState<string | null>(null);
    /** Par id, jamais par copie : la rangée se relit dans la liste vivante. */
    const [shownId, setShownId] = useState<number | null>(null);
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (!copy) return null;

    const run = async (work: () => Promise<void>, fallback: string): Promise<boolean> => {
        setBusy(true);
        setError(null);
        try {
            await work();
            // Le hub ne renvoie pas sa trame à l'auteur.
            invalidateTopic('domain');
            return true;
        } catch (failure) {
            setError(humanizeError(failure, fallback));
            return false;
        } finally {
            setBusy(false);
        }
    };

    const add = () => {
        const wanted = host?.trim() ?? '';
        if (wanted.length === 0) return;
        void run(async () => {
            const res = await ws.send('domain.add', { feature, host: wanted });
            setHost(null);
            // Les enregistrements à poser sont la suite immédiate du geste.
            setShownId(res.domain.id);
        }, 'Ce domaine n’a pas pu être déclaré.');
    };

    const verify = (id: number) =>
        void run(async () => {
            await ws.send('domain.verify', { feature, id });
        }, 'La vérification n’a pas abouti.');

    const askRemove = (domain: FeatureDomain) =>
        setConfirm({
            title: `Retirer ${domain.host} ?`,
            description:
                domain.useCount === 0
                    ? 'Rien ne le désigne : rien d’autre ne change.'
                    : (copy.removal ??
                      `${domain.useCount} élément(s) de ${featureDescriptor(feature).label} le désignent.`),
            confirmLabel: 'Retirer',
            tone: 'danger',
            onConfirm: async () => {
                await run(async () => {
                    await ws.send('domain.remove', { feature, id: domain.id });
                }, 'Ce domaine n’a pas pu être retiré.');
                setConfirm(null);
            }
        });

    return (
        <div className={styles.section}>
            <p className={`${styles.sectionHint} ${styles.panelLead}`}>{copy.hint}</p>

            {!canWrite && <ReadOnlyNotice>Déclarer un domaine demande le droit d’écriture.</ReadOnlyNotice>}

            <div className={styles.channelList}>
                {!loading && domains.length === 0 && (
                    <div className={styles.emptyRow}>
                        <span>
                            Aucun domaine déclaré.
                            {canWrite ? ' Ajoutez-en un ci-dessous : DevEye vous dira quoi publier.' : ''}
                        </span>
                    </div>
                )}

                {domains.map((domain) => {
                    const badge = rowBadge(domain);
                    const problem = domain.dnsError || domain.probeError;
                    return (
                        <div key={domain.id} className={styles.channelRow}>
                            <span className={`icon icon-globe ${styles.channelIcon}`} aria-hidden='true' />
                            <span className={styles.channelText}>
                                <span className={styles.channelLabel}>
                                    {domain.host}
                                    <StatusBadge tone={badge.tone}>{badge.label}</StatusBadge>
                                </span>
                                <span className={styles.channelMeta}>
                                    {domain.verifiedAt !== null
                                        ? `Vérifié le ${new Date(domain.verifiedAt * 1000).toLocaleDateString('fr-FR')}`
                                        : 'Publiez les enregistrements DNS, puis vérifiez.'}
                                </span>
                                {problem && <span className={styles.errorText}>{problem}</span>}
                            </span>
                            <span
                                className={`${styles.channelUsage} ${domain.useCount === 0 ? styles.channelUsageIdle : ''}`}
                                title={
                                    domain.useCount === 0
                                        ? 'Désigné par aucun élément'
                                        : `Désigné par ${domain.useCount} élément(s)`
                                }
                            >
                                {domain.useCount === 0 ? 'inutilisé' : `${domain.useCount}×`}
                            </span>
                            <span className={styles.channelActions}>
                                {canWrite && (
                                    <button
                                        type='button'
                                        className={styles.rowAction}
                                        title='Relire le DNS et sonder le service'
                                        aria-label={`Vérifier ${domain.host}`}
                                        disabled={busy}
                                        onClick={() => verify(domain.id)}
                                    >
                                        <span className='icon icon-refresh' />
                                    </button>
                                )}
                                <button
                                    type='button'
                                    className={styles.rowAction}
                                    title='Voir les enregistrements DNS'
                                    aria-label={`Enregistrements DNS de ${domain.host}`}
                                    onClick={() => setShownId(domain.id)}
                                >
                                    <span className='icon icon-details' />
                                </button>
                                {canWrite && (
                                    <button
                                        type='button'
                                        className={`${styles.rowAction} ${styles.rowActionDanger}`}
                                        title='Retirer ce domaine'
                                        aria-label={`Retirer ${domain.host}`}
                                        disabled={busy}
                                        onClick={() => askRemove(domain)}
                                    >
                                        <span className='icon icon-trash' />
                                    </button>
                                )}
                            </span>
                        </div>
                    );
                })}
            </div>

            {/* Dialogue d'ajout ouvert : c'est lui qui porte l'erreur du geste. */}
            {host === null && (error ?? loadError) && <p className={styles.errorText}>{error ?? loadError}</p>}

            {canWrite && (
                <div className={styles.sectionActions}>
                    <Button variant='secondary' icon='plus' disabled={busy} onClick={() => setHost('')}>
                        Ajouter un domaine
                    </Button>
                </div>
            )}

            <Dialog
                open={host !== null}
                onClose={() => setHost(null)}
                title='Nouveau domaine'
                description='Le nom seul, sans https:// ni chemin. Les enregistrements à publier s’affichent ensuite.'
                width={440}
                onSubmit={add}
                footer={
                    <>
                        <Button variant='secondary' disabled={busy} onClick={() => setHost(null)}>
                            Annuler
                        </Button>
                        <Button disabled={busy || (host ?? '').trim().length === 0} onClick={add}>
                            Déclarer
                        </Button>
                    </>
                }
            >
                <label className={styles.field}>
                    <span className={styles.fieldLabel}>Domaine</span>
                    <TextInput
                        value={host ?? ''}
                        placeholder={copy.placeholder ?? 'sous-domaine.exemple.fr'}
                        onChange={(e) => setHost(e.target.value)}
                        autoFocus
                        spellCheck={false}
                    />
                </label>
                {error && host !== null && <p className={styles.errorText}>{error}</p>}
            </Dialog>

            <DomainRecordsDialog
                domain={domains.find((d) => d.id === shownId) ?? null}
                service={copy.service}
                canWrite={canWrite}
                busy={busy}
                onVerify={() => shownId !== null && verify(shownId)}
                onClose={() => setShownId(null)}
            />

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />
        </div>
    );
}
