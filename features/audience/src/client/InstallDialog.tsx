import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Button, Dialog, humanizeError, invalidate, useResourceVersion } from 'deveye-sdk-client';
import type { AudienceForm, AudienceSite } from '../contracts/domain';

import { api } from './api';
import { formatAgo, snippetFor } from './format';
import { agentBrief, submitBrief, submitExamples, usageExamples } from './usage';
import styles from './style.module.css';

/**
 * Un dépliant animé et exclusif : `<details>` natif ne sait ni s'animer ni se
 * refermer quand son voisin s'ouvre, et trois panneaux ouverts font un mur de
 * code. L'ouverture est donc pilotée par l'appelant, qui n'en garde qu'une.
 *
 * `overflow: hidden` pendant la transition, sans quoi le contenu déborderait du
 * panneau replié pendant la fraction de seconde où il se ferme.
 */
function Disclosure({
    title,
    open,
    onToggle,
    children
}: {
    title: string;
    open: boolean;
    onToggle: () => void;
    children: ReactNode;
}) {
    return (
        <div className={styles.disclosure}>
            <button type='button' className={styles.disclosureHead} onClick={onToggle} aria-expanded={open}>
                <span className={`icon icon-chevron ${open ? styles.disclosureOpen : styles.disclosureShut}`} />
                {title}
            </button>
            <AnimatePresence initial={false}>
                {open && (
                    <motion.div
                        key='body'
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        transition={{ duration: 0.22, ease: 'easeOut' }}
                        style={{ overflow: 'hidden' }}
                    >
                        <div className={styles.disclosureBody}>{children}</div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/**
 * Ce que la fenêtre a le droit de montrer, selon l'écran d'où on l'ouvre : le
 * sommaire donne la balise et la clé, chaque section ne montre que ce qui la
 * concerne. Une fenêtre unique obligeait à dérouler quatre dépliants pour
 * trouver le sien.
 */
export type InstallScope = 'site' | 'traffic' | 'funnels' | 'forms';

interface InstallDialogProps {
    open: boolean;
    scope?: InstallScope;
    /** Le formulaire ouvert, quand on vient des retours : le `<form>` en découle. */
    form?: AudienceForm | null;
    site: AudienceSite;
    /**
     * L'adresse par laquelle les pages suivies atteignent l'ingestion, telle que
     * le serveur la connaît. Jamais `window.location.origin` : l'application est
     * derrière le VPN et l'ingestion doit être joignable sans lui, donc la
     * déduire du navigateur donnerait une balise fausse en production.
     */
    ingestOrigin: string;
    canWrite: boolean;
    onClose: () => void;
    /**
     * La clé vient d'être renouvelée. Facultatif : le dialogue ravive lui-même
     * la fiche et la liste, un appelant qui tient le site par `useResource` n'a
     * rien à faire de plus.
     */
    onRotated?: (site: AudienceSite) => void;
}

/**
 * Comment brancher un site, et tout ce qu'on peut en faire ensuite. Quatre
 * dépliants, du plus courant au plus spécialisé ; tous repliés pour ne pas
 * noyer l'étape qui compte, coller la balise et voir la première mesure
 * arriver.
 *
 * Les retours ont leur dépliant plutôt qu'une fenêtre à part : c'est la même
 * clé, la même porte publique et les mêmes origines autorisées, et un site
 * statique peut n'utiliser qu'eux sans jamais poser la balise.
 *
 * Tous les blocs sont bâtis depuis la vraie clé et la vraie adresse
 * d'ingestion : un exemple qu'il faut adapter est un exemple qu'on adapte mal.
 */
export function InstallDialog({
    open,
    scope = 'site',
    form = null,
    site,
    ingestOrigin,
    canWrite,
    onClose,
    onRotated
}: InstallDialogProps) {
    /** Le bloc dont la copie vient d'aboutir, pour le retour visuel. */
    const [copied, setCopied] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [confirmRotate, setConfirmRotate] = useState(false);
    const [lang, setLang] = useState('js');
    const [submitLang, setSubmitLang] = useState('html');
    /** Les formulaires du site, chargés seulement quand on ouvre leur dépliant. */
    const [forms, setForms] = useState<AudienceForm[] | null>(null);
    /** Un seul dépliant ouvert à la fois ; `null` = tous repliés. */
    const [section, setSection] = useState<string | null>(null);
    const toggle = (id: string) => setSection((current) => (current === id ? null : id));

    // Tout ce que montre cette fenêtre suit le mode réglé sur le site : une balise
    // sans `data-visitor` donnée à qui vient d'activer le mode persistant laisserait
    // croire que les visiteurs connus se mesurent.
    const persistent = site.visitorMode === 'persistent';
    const snippet = snippetFor(site.publicKey, ingestOrigin, persistent);
    // Mémorisés : ce sont des chaînes bâties par concaténation, et rien ne les
    // fait changer tant que la clé ou l'adresse ne bougent pas.
    const examples = useMemo(
        () => usageExamples(site.publicKey, ingestOrigin, persistent),
        [site.publicKey, ingestOrigin, persistent]
    );
    // Deux mémos, jamais les deux à la fois : ce sont deux intégrations, et un
    // agent à qui on donne les deux d'un coup mélange les deux API.
    const brief = useMemo(
        () =>
            scope === 'forms'
                ? submitBrief(site.publicKey, ingestOrigin, form?.name ?? 'contact', form?.fields ?? [])
                : agentBrief(site.publicKey, ingestOrigin, persistent),
        [scope, site.publicKey, ingestOrigin, persistent, form?.name, form?.fields]
    );
    const example = examples.find((e) => e.id === lang) ?? examples[0];
    const submits = useMemo(
        () => submitExamples(site.publicKey, ingestOrigin, form?.name ?? 'contact', form?.fields ?? []),
        [site.publicKey, ingestOrigin, form?.name, form?.fields]
    );
    const submitExample = submits.find((e) => e.id === submitLang) ?? submits[0];

    const formsVersion = useResourceVersion('audience.forms');

    // Le pendant de « première mesure reçue », pour les retours. Chargé à
    // l'ouverture du dépliant seulement : la fiche n'en a pas besoin, et un envoi
    // par site à chaque ouverture de cette fenêtre coûterait pour rien.
    useEffect(() => {
        if (section !== 'submit') return;
        let cancelled = false;
        api.send('audience.formList', { siteId: site.id })
            .then((res) => {
                if (!cancelled) setForms(res.forms);
            })
            .catch(() => {
                // Lecture d'appoint : l'installation se lit sans elle.
            });
        return () => {
            cancelled = true;
        };
    }, [section, site.id, formsVersion]);

    /** Le retour le plus récent, tous formulaires confondus ; `null` = aucun. */
    const lastSubmission =
        forms?.reduce<number | null>(
            (best, form) => (form.lastAt !== null && (best === null || form.lastAt > best) ? form.lastAt : best),
            null
        ) ?? null;

    const copy = async (text: string, id: string) => {
        try {
            await navigator.clipboard.writeText(text);
            setCopied(id);
            window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
        } catch {
            setError('Copie impossible — sélectionnez le texte à la main.');
        }
    };

    const rotate = async () => {
        setBusy(true);
        setError(null);
        try {
            const res = await api.send('audience.siteRotateKey', { siteId: site.id });
            invalidate('audience.list');
            invalidate('audience.detail');
            setConfirmRotate(false);
            onRotated?.(res.site);
        } catch (e) {
            setError(humanizeError(e, 'Renouvellement impossible.'));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open={open}
            onClose={onClose}
            title={
                scope === 'forms' ? 'Recevoir des retours' : scope === 'traffic' ? 'Installer la mesure' : 'Installer'
            }
            width={720}
            onSubmit={onClose}
            footer={
                <>
                    {/* Poussé tout à gauche du pied : geste rare et conséquent, il n'a
                        pas à côtoyer « Fermer » qu'on presse à chaque visite, et une
                        pleine largeur lui donnerait le poids d'une action principale. */}
                    {canWrite &&
                        (confirmRotate ? (
                            <div className={styles.footerLeft}>
                                <Button variant='secondary' onClick={() => setConfirmRotate(false)} disabled={busy}>
                                    Annuler
                                </Button>
                                <Button variant='danger' onClick={() => void rotate()} disabled={busy}>
                                    {busy ? 'Renouvellement…' : 'Confirmer le renouvellement'}
                                </Button>
                            </div>
                        ) : (
                            <Button
                                className={styles.footerLeft}
                                variant='ghost'
                                onClick={() => setConfirmRotate(true)}
                            >
                                Renouveler la clé publique
                            </Button>
                        ))}
                    <Button variant='secondary' onClick={onClose}>
                        Fermer
                    </Button>
                </>
            }
        >
            <div className={styles.install}>
                {scope !== 'forms' && (
                    <>
                        <p className={styles.installStep}>
                            <span className={styles.stepNumber}>1</span>
                            Collez cette balise dans le <code>&lt;head&gt;</code>, avant le bundle de votre application.
                        </p>
                        <pre className={styles.snippet}>{snippet}</pre>
                        <div className={styles.installActions}>
                            <Button variant='secondary' icon='copy' onClick={() => void copy(snippet, 'tag')}>
                                {copied === 'tag' ? 'Copié' : 'Copier la balise'}
                            </Button>
                        </div>

                        <p className={styles.installStep}>
                            <span className={styles.stepNumber}>2</span>
                            Ouvrez une page du site. La première mesure arrive en quelques secondes.
                        </p>
                        <p className={site.lastEventAt === null ? styles.waiting : styles.received}>
                            {site.lastEventAt === null
                                ? 'En attente de la première mesure…'
                                : `Première mesure reçue — dernière ${formatAgo(site.lastEventAt)}.`}
                        </p>
                    </>
                )}

                {/* Les trois dépliants dans un groupe sans gouttière : le `gap` de
                    `.install` s'ajouterait au-dessus de chaque filet, si bien qu'un titre
                    serait plus loin de sa propre ligne que du bloc précédent. */}
                <div className={styles.disclosures}>
                    {scope !== 'forms' && (
                        <Disclosure
                            title='Utilisation de base : marquer des étapes, nommer un utilisateur'
                            open={section === 'base'}
                            onToggle={() => toggle('base')}
                        >
                            <p className={styles.hint}>
                                Les pages sont suivies toutes seules, changements de route d’une SPA compris. Le reste
                                se pose à la main, là où l’étape est réellement franchie :
                            </p>
                            <pre className={styles.snippet}>{`window.deveye?.event('Votre projet');
window.deveye?.identify(user.id);`}</pre>

                            <p className={styles.hint}>
                                <strong>Ne gardez jamais la référence dans une variable.</strong> La balise porte{' '}
                                <code>defer</code> : elle s’exécute après les scripts en ligne de la page, donc{' '}
                                <code>window.deveye</code> peut ne pas exister encore au moment où votre code se charge.
                                Le relire à chaque appel supprime le problème. La page marcherait sans, mais aucune
                                mesure ne partirait.
                            </p>
                            <p className={styles.hint}>
                                Les noms sont <strong>comparés à l’identique</strong> : accents, espaces et majuscules
                                comptent. Composez vos entonnoirs depuis les suggestions plutôt qu’en les retapant.
                            </p>
                            <p className={styles.hint}>
                                Sur <code>localhost</code>, la mesure est désactivée pour qu’un rechargement de
                                développement ne gonfle pas vos chiffres : ajoutez{' '}
                                <code>data-local=&quot;true&quot;</code> à la balise pour l’essayer quand même.
                            </p>
                        </Disclosure>
                    )}

                    {scope !== 'forms' && scope !== 'funnels' && (
                        <Disclosure
                            title='Exemples de code : navigateur, Node.js, PHP'
                            open={section === 'code'}
                            onToggle={() => toggle('code')}
                        >
                            <div className={styles.segmented} role='group' aria-label='Langage'>
                                {examples.map((item) => (
                                    <button
                                        key={item.id}
                                        type='button'
                                        className={item.id === lang ? styles.segmentActive : styles.segment}
                                        aria-pressed={item.id === lang}
                                        onClick={() => setLang(item.id)}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>

                            <p className={styles.hint}>{example.note}</p>
                            <pre className={styles.snippetTall}>{example.code}</pre>
                            <div className={styles.installActions}>
                                <Button
                                    variant='secondary'
                                    icon='copy'
                                    onClick={() => void copy(example.code, example.id)}
                                >
                                    {copied === example.id ? 'Copié' : `Copier l’exemple ${example.label}`}
                                </Button>
                            </div>
                        </Disclosure>
                    )}

                    {scope !== 'traffic' && (
                        <Disclosure
                            title={
                                form
                                    ? `Brancher « ${form.name} » : formulaire, appel, curl`
                                    : 'Recevoir des retours : formulaire, sondage, signalement'
                            }
                            open={section === 'submit'}
                            onToggle={() => toggle('submit')}
                        >
                            <p className={styles.hint}>
                                Un site statique n’a souvent besoin d’un serveur que pour ça. Le formulaire se crée{' '}
                                <strong>à sa première réception</strong> : il n’y a rien à déclarer ici avant, et le nom
                                que vous envoyez est celui qui apparaîtra dans « Retours ».
                            </p>

                            <div className={styles.segmented} role='group' aria-label='Façon d’envoyer'>
                                {submits.map((item) => (
                                    <button
                                        key={item.id}
                                        type='button'
                                        className={item.id === submitLang ? styles.segmentActive : styles.segment}
                                        aria-pressed={item.id === submitLang}
                                        onClick={() => setSubmitLang(item.id)}
                                    >
                                        {item.label}
                                    </button>
                                ))}
                            </div>

                            <p className={styles.hint}>{submitExample.note}</p>
                            <pre className={styles.snippetTall}>{submitExample.code}</pre>
                            <div className={styles.installActions}>
                                <Button
                                    variant='secondary'
                                    icon='copy'
                                    onClick={() => void copy(submitExample.code, `submit-${submitExample.id}`)}
                                >
                                    {copied === `submit-${submitExample.id}` ? 'Copié' : 'Copier'}
                                </Button>
                            </div>

                            {/* Le même repère que pour la balise : une intégration se vérifie
                            en voyant arriver le premier envoi, jamais au code de retour,
                            que la porte publique rend identique en cas de refus. */}
                            <p className={lastSubmission === null ? styles.waiting : styles.received}>
                                {forms === null
                                    ? 'Lecture des formulaires…'
                                    : lastSubmission === null
                                      ? 'En attente du premier retour…'
                                      : `${forms.length} formulaire${forms.length > 1 ? 's' : ''} — dernier retour ${formatAgo(lastSubmission)}.`}
                            </p>

                            <p className={styles.hint}>
                                Les origines autorisées du site s’appliquent aux retours comme aux mesures, et le
                                plafond est de vingt formulaires par site et 50 000 retours par formulaire. Un
                                formulaire se ferme, se vide et se renomme depuis « Retours ».
                            </p>
                        </Disclosure>
                    )}

                    <Disclosure
                        title='Mémo pour un agent de code'
                        open={section === 'agent'}
                        onToggle={() => toggle('agent')}
                    >
                        <p className={styles.hint}>
                            À coller tel quel dans une conversation avec un assistant : tout ce qu’il lui faut pour
                            brancher la mesure sans se tromper, y compris les trois pièges qui coûtent une session de
                            débogage.
                        </p>
                        {/* Un `textarea` en lecture seule plutôt qu'un `pre` : on
                        sélectionne tout d'un Ctrl+A sans attraper le reste de la page,
                        même si l'API de copie est refusée par le navigateur. */}
                        <textarea className={styles.brief} value={brief} readOnly spellCheck={false} rows={14} />
                        <div className={styles.installActions}>
                            <Button variant='secondary' icon='copy' onClick={() => void copy(brief, 'brief')}>
                                {copied === 'brief' ? 'Copié' : 'Copier le mémo'}
                            </Button>
                        </div>
                    </Disclosure>
                </div>

                {/* L'avertissement reste dans le corps : c'est une phrase à lire,
                    et un pied de fenêtre n'est pas fait pour ça. */}
                {confirmRotate && (
                    <p className={styles.rotateWarn}>
                        L’ancienne clé cesse d’être acceptée <strong>immédiatement</strong> : toute page qui la porte
                        encore arrêtera de mesurer jusqu’à ce qu’elle soit mise à jour. L’historique déjà collecté est
                        conservé.
                    </p>
                )}

                {error && <p className={styles.error}>{error}</p>}
            </div>
        </Dialog>
    );
}

export default InstallDialog;
