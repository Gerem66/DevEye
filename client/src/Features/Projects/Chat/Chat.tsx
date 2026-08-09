import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MinimalUser, ProjectMessage } from 'deveye-types';
import { PROJECT_MESSAGE_MAX_LENGTH } from 'deveye-types';
import { Button } from '@/Components';
import { ws } from '@/api/ws';
import { useResourceVersion } from '@/stores/invalidation';
import { useTypers, useTypingSignal } from '@/live/useTyping';
import { humanizeError, withSecrecy } from '../api';
import { Avatar } from '../Board/Avatar';
import styles from '../style.module.css';

/**
 * Regroupement des messages : au-delà de ce silence, un même auteur repart avec
 * son en-tête. Sans ça, deux messages écrits à trois heures d'écart se
 * colleraient comme s'ils formaient une seule prise de parole.
 */
const GROUP_WINDOW_SECONDS = 5 * 60;

interface ChatProps {
    cardId: number;
    members: MinimalUser[];
    meUserId: number;
    canWrite: boolean;
}

/**
 * Le fil de discussion d'une carte.
 *
 * L'en-tête (avatar + pseudo) n'apparaît que quand l'auteur **change**, ou après
 * un silence : répéter le même nom sur dix messages d'affilée n'apprend rien et
 * hache la lecture.
 *
 * La présence est déjà cadrée par le `l2` du dialogue de carte : le serveur ne
 * diffuse la frappe qu'aux pairs situés exactement là, donc ce composant n'a
 * rien à déclarer de plus.
 */
export function Chat({ cardId, members, meUserId, canWrite }: ChatProps) {
    const [messages, setMessages] = useState<ProjectMessage[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const version = useResourceVersion('project.messages');
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const typers = useTypers();
    const { onInput, stop } = useTypingSignal();

    const load = useCallback(
        async (before?: number) => {
            try {
                const res = await withSecrecy(() =>
                    ws.send('project.messageList', before === undefined ? { cardId } : { cardId, before })
                );
                setHasMore(res.hasMore);
                setMessages((prev) => (before === undefined ? res.messages : [...res.messages, ...(prev ?? [])]));
                setError(null);
                return res.messages;
            } catch (e) {
                setError(humanizeError(e, 'Impossible de charger la discussion.'));
                return [];
            }
        },
        [cardId]
    );

    useEffect(() => {
        void load();
    }, [load, version]);

    /**
     * Marquer lu dès que le fil est à l'écran. Le point d'eau haute est le
     * dernier message reçu : c'est ce qui fait disparaître le badge de la carte.
     */
    useEffect(() => {
        if (!messages || messages.length === 0) return;
        const last = messages[messages.length - 1];
        void ws.send('project.markRead', { cardId, lastMessageId: last.id }).catch(() => {
            /* sans conséquence : la marque repartira à la prochaine ouverture */
        });
    }, [cardId, messages]);

    // Le fil s'écrit par le bas : on y reste collé à chaque nouvelle arrivée.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: 'end' });
    }, [messages]);

    const send = async () => {
        const body = text.trim();
        if (!body || busy) return;
        setBusy(true);
        stop();
        try {
            // Les mentions sont extraites du texte au moment de l'envoi : le
            // serveur ne lit jamais le corps pour le comprendre, il ne fait que
            // le chiffrer.
            await withSecrecy(() =>
                ws.send('project.messageSend', { cardId, text: body, mentions: findMentions(body, members) })
            );
            setText('');
            await load();
        } catch (e) {
            setError(humanizeError(e, 'L’envoi a échoué.'));
        } finally {
            setBusy(false);
        }
    };

    const groups = useMemo(() => groupMessages(messages ?? []), [messages]);
    const typingNames = typers
        .filter((t) => t.userId !== meUserId)
        .map((t) => members.find((m) => m.id === t.userId)?.username)
        .filter((n): n is string => Boolean(n));
    const uniqueTyping = [...new Set(typingNames)];

    return (
        <div className={styles.chat}>
            {/* L'intitulé est **dans** l'encart, comme celui des sous-tâches en
                face : deux panneaux côte à côte dont l'un porte son titre au
                dessus et l'autre dedans ne se lisent pas comme une paire. */}
            <div className={styles.chatHead}>
                <span className={styles.label}>Discussion</span>
                {messages !== null && messages.length > 0 && (
                    <span className={styles.checkCount}>{messages.length}</span>
                )}
            </div>

            {error && <p className={styles.error}>{error}</p>}

            <div className={styles.chatScroll}>
                {hasMore && (
                    <button type='button' className={styles.loadMore} onClick={() => void load(messages?.[0]?.id)}>
                        Charger les messages précédents
                    </button>
                )}

                {messages === null && <p className={styles.empty}>Chargement…</p>}
                {messages?.length === 0 && <p className={styles.empty}>Aucun message. Lancez la discussion.</p>}

                {groups.map((group) => {
                    const author = members.find((m) => m.id === group.authorUserId);
                    return (
                        <div key={group.key} className={styles.msgGroup}>
                            <Avatar user={author} size={26} />
                            <div className={styles.msgBody}>
                                <div className={styles.msgHead}>
                                    <span className={styles.msgAuthor}>{author?.username ?? 'Compte supprimé'}</span>
                                    <span className={styles.msgTime}>{formatTime(group.created)}</span>
                                </div>
                                {group.messages.map((m) => (
                                    <p key={m.id} className={styles.msgText}>
                                        {m.text}
                                        {m.edited !== null && <span className={styles.msgEdited}> (modifié)</span>}
                                    </p>
                                ))}
                            </div>
                        </div>
                    );
                })}

                <div ref={bottomRef} />
            </div>

            {/* Discret, et réservé à la place : la ligne existe toujours pour que
                l'apparition d'un « écrit… » ne fasse pas sauter le composeur. */}
            <p className={styles.typing}>
                {uniqueTyping.length === 1 && `${uniqueTyping[0]} est en train d’écrire…`}
                {uniqueTyping.length > 1 && `${uniqueTyping.join(', ')} sont en train d’écrire…`}
            </p>

            {canWrite && (
                <div className={styles.composer}>
                    {/* Le champ grandit avec son texte **par le CSS seul** : ce
                        conteneur superpose la saisie et une copie invisible du
                        même texte, et c'est la copie qui donne la hauteur. Voir
                        `.grow` — l'ancienne mesure en JavaScript arrondissait
                        au pixel et laissait une barre de défilement à demeure. */}
                    <div className={styles.grow} data-value={text}>
                        <textarea
                            className={styles.textarea}
                            value={text}
                            rows={1}
                            maxLength={PROJECT_MESSAGE_MAX_LENGTH}
                            placeholder='Écrire un message… (@ pour mentionner)'
                            onChange={(e) => {
                                setText(e.target.value);
                                onInput();
                            }}
                            onBlur={stop}
                            onKeyDown={(e) => {
                                // Entrée envoie, Maj+Entrée passe à la ligne. Le
                                // `onSubmit` du Dialog ne s'applique pas aux
                                // textarea, on câble donc l'envoi ici.
                                if (e.key === 'Enter' && !e.shiftKey) {
                                    e.preventDefault();
                                    void send();
                                }
                            }}
                        />
                    </div>
                    <Button onClick={() => void send()} disabled={busy || !text.trim()}>
                        Envoyer
                    </Button>
                </div>
            )}
        </div>
    );
}

interface Group {
    key: string;
    authorUserId: number | null;
    created: number;
    messages: ProjectMessage[];
}

/** Regroupe les messages consécutifs d'un même auteur, dans une même fenêtre. */
function groupMessages(messages: ProjectMessage[]): Group[] {
    const groups: Group[] = [];
    for (const message of messages) {
        const last = groups[groups.length - 1];
        const sameAuthor = last && last.authorUserId === message.authorUserId;
        const closeEnough =
            last && message.created - last.messages[last.messages.length - 1].created < GROUP_WINDOW_SECONDS;
        if (sameAuthor && closeEnough) {
            last.messages.push(message);
            continue;
        }
        groups.push({
            key: `g${message.id}`,
            authorUserId: message.authorUserId,
            created: message.created,
            messages: [message]
        });
    }
    return groups;
}

/**
 * Repère les `@pseudo` correspondant à un membre de l'espace.
 *
 * Le plus long pseudo d'abord : sans ça, `@marc` avalerait le début de
 * `@marc-antoine` et la mention viserait la mauvaise personne.
 */
function findMentions(text: string, members: MinimalUser[]): number[] {
    const found = new Set<number>();
    const sorted = [...members].sort((a, b) => b.username.length - a.username.length);
    for (const member of sorted) {
        if (text.includes(`@${member.username}`)) found.add(member.id);
    }
    return [...found];
}

function formatTime(seconds: number): string {
    const date = new Date(seconds * 1000);
    const today = new Date();
    const sameDay = date.toDateString() === today.toDateString();
    return sameDay
        ? date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : date.toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export default Chat;
