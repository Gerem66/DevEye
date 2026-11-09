import type { PictoId } from '../icons';

/** Les outils de l'onglet Signer et annoter. `select` déplace et redimensionne ce qui est posé. */
export type Tool =
    | 'select'
    | 'signature'
    | 'initials'
    | 'text'
    | 'date'
    | 'check'
    | 'cross'
    | 'image'
    | 'highlight'
    | 'box'
    | 'ink'
    | 'redact';

export const TOOLS: readonly { id: Tool; label: string; picto: PictoId; title: string }[] = [
    { id: 'select', label: 'Sélection', picto: 'select', title: 'Déplacer et redimensionner ce qui est posé' },
    { id: 'signature', label: 'Signature', picto: 'signature', title: 'Poser votre signature' },
    { id: 'initials', label: 'Paraphe', picto: 'initials', title: 'Poser vos initiales, sur toutes les pages' },
    { id: 'text', label: 'Texte', picto: 'text', title: 'Écrire un texte' },
    { id: 'date', label: 'Date', picto: 'date', title: 'Poser la date du jour' },
    { id: 'check', label: 'Coche', picto: 'check', title: 'Cocher une case' },
    { id: 'cross', label: 'Croix', picto: 'cross', title: 'Poser une croix' },
    { id: 'image', label: 'Image', picto: 'image', title: 'Poser une image (un tampon, un logo)' },
    { id: 'highlight', label: 'Surligner', picto: 'highlight', title: 'Surligner un passage' },
    { id: 'box', label: 'Rectangle', picto: 'box', title: 'Encadrer, ou couvrir d’un rectangle blanc' },
    { id: 'ink', label: 'Dessiner', picto: 'ink', title: 'Dessiner à main levée' },
    { id: 'redact', label: 'Caviarder', picto: 'redact', title: 'Effacer un passage pour de bon' }
];

/** Les outils qui tracent un rectangle du bout du pointeur. */
export const DRAW_TOOLS: readonly Tool[] = ['highlight', 'box', 'redact'];
