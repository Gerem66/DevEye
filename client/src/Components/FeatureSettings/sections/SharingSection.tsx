import { useCallback, useEffect, useState } from 'react';
import { itemNounForms, type ItemShareState, type ShareBlocker } from '@deveye/types';

import { humanizeError } from '@/api/useResource';
import { ws, WsError } from '@/api/ws';
import Button from '@/Components/Button';
import { ConfirmDialog, type ConfirmRequest } from '@/Components/ConfirmDialog';
import { Dialog } from '@/Components/Dialog';
import { ProgressDialog } from '@/Components/ProgressDialog';
import SelectInput from '@/Components/SelectInput';
import Switch from '@/Components/Switch';
import { moduleManifest } from '@/sdk/registry';
import { invalidate, type ResourceKey } from '@/stores/invalidation';

import { type SettingsScope } from '../scope';
import styles from '../FeatureSettings.module.css';
import { goToItemSettings } from '../goToHome';
import CopyItem from './CopyItem';
import ItemGrantsPanel from './ItemGrantsPanel';

/**
 * Où cet élément est visible : ses espaces, et seulement les siens. Proposer les
 * espaces d'autrui contournerait l'appartenance ; le serveur le refuse aussi.
 *
 * Deux gestes, à ne pas confondre. La case **projette** : l'élément garde son
 * domicile et reste chiffré sous la clé de son origine. Le sélecteur du bas le
 * **déplace** : il change de domicile, sa donnée est re-chiffrée et ses
 * projections ne le suivent pas. Le second n'apparaît que quand le serveur le
 * dit (`movable`), et ne s'exécute qu'après un aperçu de ce qu'il détruit.
 */

const BLOCKER_TEXT: Record<ShareBlocker, string> = {
    feature:
        'Cette fonctionnalité ne se partage pas encore entre espaces : son listage ne sait pas aller chercher les éléments projetés.',
    item: 'Cet élément est chiffré au palier « gardé ». Le serveur ne peut pas le relire pour un autre espace, et il n’est donc pas projetable — passez-le au palier ouvert si sa nature s’y prête.',
    forbidden: 'Vous n’avez pas le droit de partager les éléments de cette fonctionnalité.',
    foreign:
        'Cet élément vient d’un autre espace, où vous n’avez pas le droit de le modifier : son partage se règle par ceux qui l’ont. Qui tient l’écriture de l’élément chez lui peut, en revanche, régler son partage d’ici.'
};

/**
 * Un déplacement relit et rescelle tout l'arbre de l'élément dans une
 * transaction : bien au-delà du délai ordinaire d'une commande.
 */
const MOVE_TIMEOUT_MS = 120_000;

/**
 * Le refus du serveur, tel quel : ses phrases (« déjà suivi dans cet espace »,
 * « une ligne illisible ») disent la cause, qu'un libellé générique cacherait.
 * Une panne sans phrase renvoie au journal du serveur, seul à la connaître ; un
 * délai dépassé prévient que le geste se poursuit peut-être là-bas.
 */
function explain(e: unknown, fallback: string): string {
    if (!(e instanceof WsError)) return fallback;
    if (e.code === 'timeout') {
        return `${fallback} Le serveur n’a pas répondu à temps : le geste se poursuit peut-être, vérifiez avant de réessayer.`;
    }
    if (e.code === 'internal') {
        return e.message === 'Internal server error' ? `${fallback} Le journal du serveur dit pourquoi.` : e.message;
    }
    return humanizeError(e, fallback);
}

interface Props {
    scope: SettingsScope;
    /** L'élément est parti dans un autre espace : la coquille se referme, la fiche s'en va. */
    onGone: () => void;
}

export default function SharingSection({ scope, onGone }: Props) {
    const feature = scope.feature;
    const [state, setState] = useState<ItemShareState | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    /** L'espace dont on règle les permissions ; `null` = aucun dialogue ouvert. */
    const [grantsFor, setGrantsFor] = useState<{ workspaceId: number; workspaceName: string } | null>(null);
    /** L'espace visé par un déplacement, tant qu'il n'est pas confirmé. */
    const [moveTo, setMoveTo] = useState('');
    const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
    /** Le déplacement est en vol : un dialogue de progression tient l'écran. */
    const [moving, setMoving] = useState(false);

    const itemId = scope.kind === 'item' ? scope.itemId : '';
    const { dem, Dem, Def } = itemNounForms(feature);

    const reload = useCallback(async () => {
        const res = await ws.send('share.get', { feature, itemId });
        setState(res);
    }, [feature, itemId]);

    useEffect(() => {
        void reload().catch(() => setError('Chargement impossible.'));
    }, [reload]);

    const toggle = (workspaceId: number, shared: boolean): void => {
        setBusy(true);
        setError(null);
        void ws
            .send('share.set', { feature, itemId, workspaceId, shared })
            .then((res) => {
                setState(res);
                // La liste de la fonctionnalité change des deux côtés : on ravive
                // toutes les ressources que le manifest du module déclare, le
                // même geste que son sujet live.
                for (const key of moduleManifest(feature)?.resources ?? []) invalidate(key as ResourceKey);
            })
            .catch((e: unknown) => setError(explain(e, 'Modification impossible.')))
            .finally(() => setBusy(false));
    };

    /** Ce que le déplacement ferait, demandé au serveur : l'écran n'en devine rien. */
    const askMove = (): void => {
        const workspaceId = Number(moveTo);
        if (!Number.isInteger(workspaceId) || workspaceId <= 0) return;
        setBusy(true);
        setError(null);
        void ws
            .send('share.movePreview', { feature, itemId, workspaceId })
            .then((preview) => {
                if (preview.blockers.length > 0) {
                    setError(preview.blockers[0]);
                    return;
                }
                const lost = [...preview.drops, ...preview.dependencies.map((d) => `${d.label} : ${d.reason}`)];
                setConfirm({
                    title: `Déplacer vers « ${preview.workspaceName} » ?`,
                    confirmLabel: 'Déplacer',
                    description: (
                        <>
                            <p>
                                {Dem} quittera « {preview.homeWorkspaceName} ». Sa donnée est déchiffrée puis rescellée
                                sous la clé de « {preview.workspaceName} »
                                {preview.rows > 0 ? ` (${preview.rows} valeurs à convertir).` : '.'}
                            </p>
                            {preview.losesSharedAccess && (
                                <p>Les membres de « {preview.homeWorkspaceName} » n’y auront plus accès.</p>
                            )}
                            {preview.carries.length > 0 && (
                                <>
                                    <p>Le déplacement emporte aussi :</p>
                                    <ul className={styles.usageList}>
                                        {preview.carries.map((line) => (
                                            <li key={line}>{line}</li>
                                        ))}
                                    </ul>
                                </>
                            )}
                            {lost.length > 0 && (
                                <ul className={styles.usageList}>
                                    {lost.map((line) => (
                                        <li key={line}>{line}</li>
                                    ))}
                                </ul>
                            )}
                        </>
                    ),
                    onConfirm: () => doMove(workspaceId, preview.workspaceName)
                });
            })
            .catch((e: unknown) => setError(explain(e, 'Déplacement impossible à préparer.')))
            .finally(() => setBusy(false));
    };

    const doMove = (workspaceId: number, workspaceName: string): void => {
        setBusy(true);
        setMoving(true);
        setError(null);
        void ws
            .send('share.move', { feature, itemId, workspaceId }, { timeoutMs: MOVE_TIMEOUT_MS })
            .then(() => {
                // La fiche s'en va AVANT que les ressources ne soient ravivées :
                // relue après coup, elle chercherait un élément qui n'est plus là.
                onGone();
                for (const key of moduleManifest(feature)?.resources ?? []) invalidate(key as ResourceKey);
            })
            .catch((e: unknown) => setError(explain(e, `Déplacement vers « ${workspaceName} » impossible.`)))
            .finally(() => {
                setMoving(false);
                setBusy(false);
            });
    };

    if (!state) return <p className={styles.sectionHint}>Chargement…</p>;

    // Sans le droit de régler le partage, on dit seulement où l'élément est
    // visible et pourquoi ça ne se règle pas d'ici.
    if (state.blocker === 'forbidden' || state.blocker === 'foreign') {
        const visible = state.workspaces.filter((w) => w.shared).map((w) => w.workspaceName);
        // Le domicile, s'il est parmi les espaces de l'appelant : c'est là que
        // le partage se règle, on propose d'y aller.
        const home = state.workspaces.find((w) => w.isHome) ?? null;
        return (
            <div className={styles.section}>
                <p className={styles.sectionHint}>
                    {visible.length > 1
                        ? `${Dem} est visible dans : ${visible.join(', ')}.`
                        : `${Dem} n’est visible que dans ${visible[0] ?? 'cet espace'}.`}
                </p>
                <p className={styles.sectionHint}>
                    {BLOCKER_TEXT[state.blocker]}
                    {state.blocker === 'foreign' && home !== null && (
                        <>
                            {' '}
                            <button
                                type='button'
                                className={styles.jumpBtn}
                                onClick={() => goToItemSettings(home.workspaceId, feature, itemId, 'sharing')}
                            >
                                Régler dans « {home.workspaceName} »
                            </button>
                        </>
                    )}
                </p>
                {state.copyable && <CopyItem feature={feature} itemId={itemId} />}
            </div>
        );
    }

    // Gardé par mot de passe : ni projection ni déplacement, aucun autre espace
    // ne saurait l'ouvrir. Reste la copie, que la destination rescelle chez elle.
    if (state.blocker === 'item') {
        return (
            <div className={styles.section}>
                <p className={styles.sectionHint}>{BLOCKER_TEXT.item}</p>
                {state.copyable && <CopyItem feature={feature} itemId={itemId} />}
            </div>
        );
    }

    return (
        <div className={styles.section}>
            <p className={styles.sectionHint}>
                Les espaces où {dem} est visible. Il n’y est pas copié : il reste chez lui et s’affiche ailleurs, donc
                le modifier d’un côté le modifie partout.
            </p>

            {state.blocker && <p className={styles.warning}>{BLOCKER_TEXT[state.blocker]}</p>}

            <div className={styles.channelList}>
                {state.workspaces.map((w) => (
                    <div key={w.workspaceId} className={styles.channelRow}>
                        <Switch
                            checked={w.shared}
                            aria-label={
                                w.isHome
                                    ? `${w.workspaceName} — espace d’origine`
                                    : `Rendre visible dans ${w.workspaceName}`
                            }
                            // L'origine n'est pas décochable : l'élément y est
                            // chez lui, pas projeté.
                            disabled={w.isHome || busy || state.blocker !== null}
                            onChange={(on) => toggle(w.workspaceId, on)}
                        />
                        <span className={styles.channelText}>
                            <span className={styles.channelLabel}>
                                {w.workspaceName}
                                {w.isHome && <span className={styles.channelOff}>espace d’origine</span>}
                            </span>
                            {w.isHome && (
                                <span className={styles.channelMeta}>
                                    C’est ici que la donnée vit et qu’elle est chiffrée.
                                </span>
                            )}
                        </span>
                        {/* Régler ce que chaque rôle de cet espace voit de
                            l'élément, sans y basculer : le même panneau que son
                            onglet Permissions. Le serveur dit qui peut
                            (`grantsManageable`). */}
                        {w.grantsManageable && (
                            <Button
                                variant='ghost'
                                icon='lock'
                                onClick={() =>
                                    setGrantsFor({ workspaceId: w.workspaceId, workspaceName: w.workspaceName })
                                }
                            >
                                Permissions
                            </Button>
                        )}
                    </div>
                ))}
            </div>

            <p className={styles.sectionHint}>
                Un membre d’un autre espace verra {dem}, mais pas ce à quoi il est relié ici, un compte mail ou un canal
                d’alerte. Ces liens lui apparaissent comme « d’un autre espace », sans leur contenu.
            </p>

            {/* Déplacer n'est pas partager : l'élément change de domicile, sa
                donnée est re-chiffrée et ses projections ne le suivent pas. Le
                serveur ne le propose (`movable`) que depuis le domicile, et pour
                une fonctionnalité qui sait convertir son arbre. Une fois parti,
                il n'y a plus rien à montrer ici : la fiche se referme. */}
            {state.movable && (
                <div className={styles.field}>
                    <span className={styles.fieldLabel}>Changer d’espace</span>
                    <div className={styles.fieldWithAction}>
                        <SelectInput
                            value={moveTo}
                            disabled={busy}
                            aria-label={`Déplacer ${dem} vers`}
                            onChange={(e) => setMoveTo(e.target.value)}
                        >
                            <option value=''>Choisir un espace…</option>
                            {state.workspaces
                                .filter((w) => !w.isHome)
                                .map((w) => (
                                    <option key={w.workspaceId} value={w.workspaceId}>
                                        {w.workspaceName}
                                    </option>
                                ))}
                        </SelectInput>
                        <Button variant='secondary' disabled={busy || moveTo === ''} onClick={askMove}>
                            Déplacer…
                        </Button>
                    </div>
                    <span className={styles.fieldHint}>
                        {Def} quitte cet espace pour de bon : sa donnée y est déchiffrée puis rescellée sous la clé du
                        nouveau. Ce qu’il perd est nommé avant confirmation, et sa fiche se referme une fois parti.
                    </span>
                </div>
            )}

            {error && <p className={styles.notice}>{error}</p>}

            {/* Copier n'est ni partager ni déplacer : l'élément reste, un double
                naît ailleurs. Le serveur le propose (`copyable`) depuis le
                domicile, même pour un élément gardé, que partage et déplacement
                refusent. */}
            {state.copyable && <CopyItem feature={feature} itemId={itemId} />}

            {/* Empilé au-dessus des réglages : il possède alors la couche de
                fermeture, donc Échap le referme sans emporter le dialogue de
                réglages derrière. */}
            <Dialog
                open={grantsFor !== null}
                onClose={() => setGrantsFor(null)}
                title={grantsFor ? `Permissions — ${grantsFor.workspaceName}` : ''}
                description={`Ce que chaque rôle de cet espace voit de ${dem}. On ne peut qu’abaisser ce que son rôle y donne.`}
                width={560}
            >
                {grantsFor && <ItemGrantsPanel feature={feature} itemId={itemId} workspaceId={grantsFor.workspaceId} />}
            </Dialog>

            <ConfirmDialog request={confirm} busy={busy} onClose={() => setConfirm(null)} />

            {/* Le déplacement peut prendre plusieurs secondes (tout l'arbre est
                relu et rescellé) : un dialogue que rien ne ferme le dit, plutôt
                qu'un écran figé où l'on ne sait pas si le clic a pris. */}
            <ProgressDialog
                open={moving}
                title='Déplacement en cours'
                description={`${Dem} change d’espace : sa donnée est déchiffrée puis rescellée sous la clé du nouveau. Sa fiche se refermera une fois parti.`}
            />
        </div>
    );
}
