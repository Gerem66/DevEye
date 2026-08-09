import type { ReactNode } from 'react';

/**
 * Le peu de markdown qu'un message de discussion mérite.
 *
 * Quatre marques en ligne et trois sortes de blocs, pas davantage : on écrit ici
 * des phrases et des listes de points, pas des documents. `Features/Notes` a son
 * propre moteur, plus riche (couleurs, barré) — il n'est pas réutilisé pour deux
 * raisons : il rend des **chaînes HTML**, et il lit `_` en paire double.
 *
 * Le rendu produit des **nœuds React**, jamais du HTML injecté. Ce n'est pas un
 * détail de style : le texte vient d'un autre membre de l'espace, et le faire
 * passer par `dangerouslySetInnerHTML` donnerait à quiconque écrit un message le
 * pouvoir d'exécuter du balisage chez ses lecteurs. Le seul balisage possible
 * ici est celui que ce fichier construit lui-même.
 *
 * Marques reconnues :
 *
 * | Écrit          | Rendu        |
 * |----------------|--------------|
 * | `**gras**`     | gras         |
 * | `*italique*`   | italique     |
 * | `_souligné_`   | souligné     |
 * | `# titre`      | titre (1 à 3 niveaux) |
 * | `- point`      | liste à puces |
 * | `1. point`     | liste numérotée |
 */

/**
 * Les trois marques en ligne, en une passe.
 *
 * L'ordre des alternatives compte : `**` doit être tenté avant `*`, sinon un
 * gras se lirait comme un italique vide suivi de texte. Les quantificateurs sont
 * paresseux pour que deux marques voisines ne fusionnent pas en une seule.
 *
 * Le `_` n'ouvre une marque **qu'aux limites d'un mot**, comme dans le markdown
 * de référence. Sans cette réserve, `assignee_user_id` — le genre de mot qui
 * circule tous les jours dans ces discussions — se lirait « assignee<u>user</u>id ».
 * L'astérisque n'a pas besoin de la même précaution : il n'apparaît pas au
 * milieu des identifiants.
 */
const INLINE_RE = /\*\*([\s\S]+?)\*\*|\*([\s\S]+?)\*|(?<![A-Za-z0-9])_([\s\S]+?)_(?![A-Za-z0-9])/;

/** Les marques imbriquent : `**gras _et souligné_**` rend les deux. */
function inline(text: string): ReactNode[] {
    const out: ReactNode[] = [];
    let rest = text;
    let key = 0;

    while (rest.length > 0) {
        const match = INLINE_RE.exec(rest);
        if (!match) {
            out.push(rest);
            break;
        }
        const [token, bold, italic, underline] = match;
        if (match.index > 0) out.push(rest.slice(0, match.index));

        const content = bold ?? italic ?? underline ?? '';
        const Tag = bold !== undefined ? 'strong' : italic !== undefined ? 'em' : 'u';
        // Le contenu est strictement plus court que ce qu'on vient de consommer
        // (les délimiteurs en sont retirés) : la récursion se termine toujours.
        out.push(<Tag key={key++}>{inline(content)}</Tag>);

        rest = rest.slice(match.index + token.length);
    }
    return out;
}

type Block =
    | { kind: 'p'; lines: string[] }
    | { kind: 'h'; level: number; text: string }
    | { kind: 'ul'; items: string[] }
    | { kind: 'ol'; items: string[] };

const HEADING_RE = /^(#{1,3})\s+(.+)$/;
const BULLET_RE = /^\s*[-*]\s+(.+)$/;
const NUMBER_RE = /^\s*\d{1,3}[.)]\s+(.+)$/;

/**
 * Découpe le message en blocs.
 *
 * Les tirets et les nombres sont reconnus **en début de ligne seulement**, ce
 * qui laisse `*italique*` et « 3. ok » au milieu d'une phrase tranquilles. Les
 * lignes d'un même paragraphe restent séparées par leur saut : c'est le
 * `white-space: pre-wrap` du conteneur qui les rend, et un message reste donc
 * fidèle à la façon dont il a été tapé.
 */
function parse(text: string): Block[] {
    const blocks: Block[] = [];
    let paragraph: string[] = [];

    const flush = (): void => {
        if (paragraph.length > 0) blocks.push({ kind: 'p', lines: paragraph });
        paragraph = [];
    };

    for (const line of text.split('\n')) {
        if (line.trim() === '') {
            flush();
            continue;
        }

        const heading = HEADING_RE.exec(line);
        if (heading) {
            flush();
            blocks.push({ kind: 'h', level: heading[1].length, text: heading[2] });
            continue;
        }

        const bullet = BULLET_RE.exec(line);
        if (bullet) {
            flush();
            const last = blocks[blocks.length - 1];
            if (last?.kind === 'ul') last.items.push(bullet[1]);
            else blocks.push({ kind: 'ul', items: [bullet[1]] });
            continue;
        }

        const numbered = NUMBER_RE.exec(line);
        if (numbered) {
            flush();
            const last = blocks[blocks.length - 1];
            if (last?.kind === 'ol') last.items.push(numbered[1]);
            else blocks.push({ kind: 'ol', items: [numbered[1]] });
            continue;
        }

        paragraph.push(line);
    }
    flush();
    return blocks;
}

/**
 * Rend un message.
 *
 * `trailing` — la mention « (modifié) » — se colle à la fin du dernier
 * paragraphe plutôt que de vivre à part : posée après le dernier bloc, elle
 * tomberait à la ligne toute seule sous un message d'un mot.
 */
export function renderMessage(text: string, trailing?: ReactNode): ReactNode[] {
    const blocks = parse(text);
    const lastIndex = blocks.length - 1;
    const nodes: ReactNode[] = [];

    blocks.forEach((block, i) => {
        const tail = i === lastIndex && block.kind === 'p' ? trailing : null;
        if (block.kind === 'p') {
            nodes.push(
                <p key={i}>
                    {inline(block.lines.join('\n'))}
                    {tail}
                </p>
            );
            return;
        }
        if (block.kind === 'h') {
            const Tag = (['h4', 'h5', 'h6'] as const)[block.level - 1];
            nodes.push(<Tag key={i}>{inline(block.text)}</Tag>);
            return;
        }
        const Tag = block.kind;
        nodes.push(
            <Tag key={i}>
                {block.items.map((item, j) => (
                    <li key={j}>{inline(item)}</li>
                ))}
            </Tag>
        );
    });

    // Un message qui finit sur une liste ou un titre : la mention prend sa
    // propre ligne, faute de paragraphe où se glisser.
    if (trailing && (blocks.length === 0 || blocks[lastIndex].kind !== 'p')) {
        nodes.push(<p key='trailing'>{trailing}</p>);
    }
    return nodes;
}
