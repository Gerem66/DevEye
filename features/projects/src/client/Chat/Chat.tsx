import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, humanizeError, useResourceVersion, useTypers, useTypingSignal, withSecrecy } from 'deveye-sdk-client';
import type { MinimalUser } from '@deveye/types';
import { api } from '../api';
import { PROJECT_MESSAGE_MAX_LENGTH, type ProjectMessage } from '../../contracts/domain';
import { MemberAvatar, MemberName } from '../Member';
import { renderMessage } from './markdown';
import styles from '../style.module.css';

/** Au-delà de ce silence, un même auteur repart avec son en-tête. */
const GROUP_WINDOW_SECONDS = 5 * 60;

interface ChatProps {
    cardId: number;
    members: readonly MinimalUser[];
    meUserId: number;
    canWrite: boolean;
}

/**
 * Le fil de discussion d'une carte. L'en-tête (avatar, pseudo) ne reparaît que
 * quand l'auteur change ou après un silence. La présence est déjà cadrée par le
 * niveau que déclare le dialogue de carte : le serveur ne diffuse la frappe qu'aux
 * pairs situés exactement là, rien à déclarer de plus ici.
 */
export function Chat({ cardId, members, meUserId, canWrite }: ChatProps) {
    const [messages, setMessages] = useState<ProjectMessage[] | null>(null);
    const [hasMore, setHasMore] = useState(false);
    const [text, setText] = useState('');
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const version = useResourceVersion('projects.messages');
    const bottomRef = useRef<HTMLDivElement | null>(null);
    const typers = useTypers();
    const { onInput, stop } = useTypingSignal();

    const load = useCallback(
        async (before?: number) => {
            try {
                const res = await withSecrecy(() =>
                    api.send('projects.messageList', before === undefined ? { cardId } : { cardId, before })
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
        void api.send('projects.markRead', { cardId, lastMessageId: last.id }).catch(() => {
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
            // Les mentions sont extraites à l'envoi : le serveur ne lit jamais le
            // corps pour le comprendre, il ne fait que le chiffrer.
            await withSecrecy(() =>
                api.send('projects.messageSend', { cardId, text: body, mentions: findMentions(body, members) })
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

                {/* Sur un projet projeté, l'auteur peut être membre de l'espace
                    d'origine et pas d'ici : `Member` l'affiche alors masqué. */}
                {groups.map((group) => (
                    <div key={group.key} className={styles.msgGroup}>
                        <MemberAvatar userId={group.authorUserId} size={26} />
                        <div className={styles.msgBody}>
                            <div className={styles.msgHead}>
                                <span className={styles.msgAuthor}>
                                    <MemberName userId={group.authorUserId} />
                                </span>
                                <span className={styles.msgTime}>{formatTime(group.created)}</span>
                            </div>
                            {group.messages.map((m) => (
                                <div key={m.id} className={styles.msgText}>
                                    {renderMessage(
                                        m.text,
                                        m.edited !== null ? <span className={styles.msgEdited}> (modifié)</span> : null
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                ))}

                <div ref={bottomRef} />
            </div>

            {/* La ligne existe toujours, pour que l'apparition d'un « écrit… » ne
                fasse pas sauter le composeur. */}
            <p className={styles.typing}>
                {uniqueTyping.length === 1 && `${uniqueTyping[0]} est en train d’écrire…`}
                {uniqueTyping.length > 1 && `${uniqueTyping.join(', ')} sont en train d’écrire…`}
            </p>

            {canWrite && (
                <div className={styles.composer}>
                    {/* Le champ grandit avec son texte par le CSS seul : `.grow`
                        superpose la saisie et une copie invisible du même texte,
                        et c'est la copie qui donne la hauteur. */}
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
                                // Entrée envoie, Maj+Entrée passe à la ligne : le
                                // `onSubmit` du Dialog ignore les textarea.
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
 * Repère les `@pseudo` d'un membre de l'espace. Le plus long d'abord : sans ça,
 * `@marc` avalerait le début de `@marc-antoine`.
 */
function findMentions(text: string, members: readonly MinimalUser[]): number[] {
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
