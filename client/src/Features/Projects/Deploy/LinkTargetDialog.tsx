import { useEffect, useState } from 'react';
import type { DeployCandidate, GitCredential, ProjectDeployTarget } from 'deveye-types';
import { Button, Dialog, SelectInput, TextInput } from '@/Components';
import { ws } from '@/api/ws';
import { humanizeError, withSecrecy } from '../api';
import styles from '../style.module.css';

interface LinkTargetDialogProps {
    open: boolean;
    projectId: number;
    /** L'application déjà liée : le dialogue sert alors à la remplacer. */
    current: ProjectDeployTarget | null;
    onClose: () => void;
    onSaved: () => void;
}

/**
 * Relier une application Dokploy au projet.
 *
 * **Il charge lui-même les accès de l'espace**, et dit ce qui manque quand il
 * n'y en a aucun. C'est ce qui lui permet d'être ouvert de deux endroits — le
 * bouton de l'onglet, et le menu « + » de la barre, qui l'appelle avant même
 * que l'onglet n'existe. Un dialogue à qui l'on passe ses accès aurait obligé
 * chaque appelant à les lire d'abord, et le conseil « ajoutez un accès
 * Dokploy » serait resté affiché loin du geste qu'il débloque.
 */
export function LinkTargetDialog({ open, projectId, current, onClose, onSaved }: LinkTargetDialogProps) {
    const [credentials, setCredentials] = useState<GitCredential[] | null>(null);
    const [credentialId, setCredentialId] = useState('');
    const [candidates, setCandidates] = useState<DeployCandidate[]>([]);
    const [externalId, setExternalId] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open) return;
        setExternalId(current?.externalId ?? '');
        setCandidates([]);
        setError(null);
        void (async () => {
            try {
                // Les jetons appartiennent à la feature Git, qui les porte pour
                // les deux fournisseurs. Seuls les accès Dokploy déploient.
                const res = await ws.send('git.credentialList', {});
                const dokploy = res.credentials.filter((c) => c.provider === 'dokploy');
                setCredentials(dokploy);
                setCredentialId(current?.credentialId ? String(current.credentialId) : String(dokploy[0]?.id ?? ''));
            } catch (e) {
                setCredentials([]);
                setError(humanizeError(e, 'Impossible de charger les accès de l’espace.'));
            }
        })();
    }, [open, current]);

    // La liste des applications vient de l'instance : c'est la seule commande du
    // module qui appelle un service externe en direct, parce qu'attendre un tour
    // d'ordonnanceur pour remplir un sélecteur n'aurait aucun sens.
    const loadCandidates = async () => {
        if (!credentialId) return;
        setBusy(true);
        setError(null);
        try {
            const res = await ws.send('project.deployCandidates', { credentialId: Number(credentialId) });
            setCandidates(res.candidates);
            if (res.candidates.length === 0) setError('Cette instance ne déclare aucune application.');
        } catch (e) {
            setError(humanizeError(e, 'Impossible de joindre l’instance Dokploy.'));
        } finally {
            setBusy(false);
        }
    };

    const submit = async () => {
        const chosen = candidates.find((c) => c.externalId === externalId);
        if (busy || !credentialId || !externalId) return;
        setBusy(true);
        setError(null);
        try {
            await withSecrecy(() =>
                ws.send('project.deployLink', {
                    projectId,
                    credentialId: Number(credentialId),
                    // Une cible saisie à la main est supposée être une
                    // application : c'est le repli, et le sélecteur donne le
                    // vrai type dès qu'on passe par lui.
                    kind: chosen?.kind ?? 'application',
                    externalId,
                    name: chosen?.name ?? externalId
                })
            );
            onSaved();
        } catch (e) {
            setError(humanizeError(e, 'La liaison a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    /** Aucun accès Dokploy : rien n'est déployable tant qu'il n'y en a pas un. */
    const nothingToUse = credentials !== null && credentials.length === 0;

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={current ? 'Modifier l’application liée' : 'Ajouter une application au projet'}
            width={560}
            onSubmit={submit}
            holdSecrecy
            footer={
                <>
                    <Button variant='secondary' onClick={onClose} disabled={busy}>
                        Annuler
                    </Button>
                    <Button onClick={submit} disabled={busy || !externalId}>
                        {busy ? 'Enregistrement…' : 'Lier'}
                    </Button>
                </>
            }
        >
            <div className={styles.form}>
                {nothingToUse ? (
                    <p className={styles.hint}>
                        {/* Le conseil renvoyait autrefois vers l'onglet Git d'un
                            projet, qui ne savait créer que des jetons GitHub :
                            il était donc impossible à suivre. La feature Git,
                            elle, gère les deux fournisseurs. */}
                        Aucun accès Dokploy dans cet espace. Ajoutez-en un (adresse de l’instance + clé d’API) depuis la
                        feature Git, section « Jetons d’accès », puis revenez ici.
                    </p>
                ) : (
                    <>
                        <label className={styles.field}>
                            <span className={styles.label}>Instance Dokploy</span>
                            <SelectInput value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
                                {(credentials ?? []).map((c) => (
                                    <option key={c.id} value={c.id}>
                                        {c.label} — {c.baseUrl}
                                    </option>
                                ))}
                            </SelectInput>
                        </label>

                        <Button
                            variant='secondary'
                            icon='refresh'
                            onClick={() => void loadCandidates()}
                            disabled={busy || !credentialId}
                        >
                            {busy ? 'Interrogation…' : 'Lister les applications'}
                        </Button>

                        {candidates.length > 0 && (
                            <label className={styles.field}>
                                <span className={styles.label}>Cible</span>
                                <SelectInput value={externalId} onChange={(e) => setExternalId(e.target.value)}>
                                    <option value=''>Choisir…</option>
                                    {candidates.map((c) => (
                                        <option key={`${c.kind}:${c.externalId}`} value={c.externalId}>
                                            {c.kind === 'compose' ? '🧩 ' : '📦 '}
                                            {c.name}
                                            {c.path ? ` — ${c.path}` : ''}
                                        </option>
                                    ))}
                                </SelectInput>
                            </label>
                        )}

                        {/* Repli manuel : si l'instance répond dans une forme que
                            le décodeur ne reconnaît pas, on doit quand même
                            pouvoir lier. */}
                        <label className={styles.field}>
                            <span className={styles.label}>…ou identifiant de cible</span>
                            <TextInput
                                value={externalId}
                                placeholder='applicationId ou composeId'
                                onChange={(e) => setExternalId(e.target.value)}
                            />
                        </label>
                    </>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default LinkTargetDialog;
