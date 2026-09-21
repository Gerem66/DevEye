import type { OptionSpec } from './options';

/**
 * Le catalogue : ce que le Convertisseur sait lire, vers quoi, avec quels
 * réglages et par quelle recette. C'est LE fichier à ouvrir pour ajouter un
 * format : une entrée ici, et ni l'écran ni les moteurs n'ont à changer.
 */

export const CONVERT_KINDS = ['video', 'audio', 'image', 'document'] as const;
export type ConvertKind = (typeof CONVERT_KINDS)[number];

/**
 * Comment une cible se fabrique. Tout ce qu'un moteur a besoin de savoir d'un
 * format tient ici : il reste générique, et ne nomme jamais un format.
 */
export type Recipe =
    | {
          engine: 'video';
          /** Le multiplexeur ffmpeg (`-f`). */
          muxer: string;
          videoCodec: string;
          audioCodec: string;
          /** La plage du facteur de qualité de ce codec, du plus fidèle au plus léger. */
          crf: { best: number; worst: number };
          /** Ce que le codec exige en plus du facteur pour encoder à qualité constante. */
          constantQuality?: readonly string[];
          /** Les arguments de chaque niveau d'effort de compression. */
          speed: Readonly<Record<'fast' | 'balanced' | 'small', readonly string[]>>;
          /** Débit nécessaire à qualité égale, rapporté au H.264 (1). Ne sert qu'à l'estimation. */
          efficiency: number;
          /** Part de l'enveloppe dans le fichier produit. */
          overhead: number;
          extra?: readonly string[];
      }
    | { engine: 'gif' }
    | {
          engine: 'audio';
          muxer: string;
          codec: string;
          /** Sans perte : le débit n'est pas un réglage, et la taille ne se calcule pas. */
          lossy: boolean;
          overhead: number;
          extra?: readonly string[];
      }
    | {
          engine: 'image';
          /** Le préfixe de codeur d'ImageMagick (`JPEG:sortie`). */
          coder: string;
          lossy: boolean;
          /** Le format sait porter la transparence. Sinon elle s'aplatit sur du blanc. */
          alpha: boolean;
          /** Octets par pixel à la qualité la plus basse et la plus haute. Ne sert qu'à l'estimation. */
          bytesPerPixel: readonly [number, number];
      }
    /** LibreOffice : le filtre de `--convert-to`. */
    | { engine: 'office'; filter: string }
    | { engine: 'pdfImage'; device: 'png' | 'jpeg' }
    | { engine: 'pdfCompress' }
    | { engine: 'pdfText' };

export interface SourceFormat {
    id: string;
    label: string;
    /** Les extensions reconnues, sans point, la première étant la canonique. */
    ext: readonly string[];
    /** Ce que ce format a le droit de devenir : les cibles qui nomment ce groupe. */
    group: string;
    /**
     * Sous quels noms l'outil de lecture reconnaît ce format (démultiplexeur de
     * ffmpeg, codeur d'ImageMagick). Le serveur refuse un fichier reconnu
     * autrement : l'extension d'un envoi ne prouve rien.
     */
    readers?: readonly string[];
}

export interface TargetFormat {
    id: string;
    label: string;
    ext: string;
    mime: string;
    /** Les groupes de sources que cette cible accepte. */
    from: readonly string[];
    options: readonly OptionSpec[];
    recipe: Recipe;
}

export interface KindSpec {
    id: ConvertKind;
    label: string;
    description: string;
    sources: readonly SourceFormat[];
    targets: readonly TargetFormat[];
}

const QUALITY_MARKS = ['Léger', 'Équilibré', 'Fidèle'] as const;

const TRIM: readonly OptionSpec[] = [
    {
        kind: 'number',
        id: 'trimStart',
        section: 'trim',
        half: true,
        label: 'Début',
        hint: 'Pour ne garder qu’un passage : où il commence.',
        min: 0,
        max: 86_400,
        step: 1,
        unit: 's'
    },
    {
        kind: 'number',
        id: 'trimEnd',
        section: 'trim',
        half: true,
        label: 'Fin',
        min: 0,
        max: 86_400,
        step: 1,
        unit: 's'
    }
];

const VIDEO_OPTIONS: readonly OptionSpec[] = [
    {
        kind: 'segments',
        id: 'mode',
        section: 'quality',
        label: 'Ce qui compte',
        options: [
            { value: 'quality', label: 'La qualité' },
            { value: 'size', label: 'La taille du fichier' }
        ],
        default: 'quality'
    },
    {
        kind: 'slider',
        id: 'quality',
        section: 'quality',
        label: 'Qualité',
        hint: 'Plus à gauche, le fichier est petit et l’image se dégrade. Au milieu, la différence ne se voit presque pas.',
        min: 0,
        max: 100,
        step: 1,
        default: 65,
        marks: QUALITY_MARKS,
        when: { option: 'mode', equals: 'quality' }
    },
    {
        kind: 'bytes',
        id: 'targetBytes',
        section: 'quality',
        label: 'Taille à ne pas dépasser',
        hint: 'La conversion se fait en deux passages pour tomber juste : elle dure environ deux fois plus longtemps.',
        default: 25 * 1024 * 1024,
        when: { option: 'mode', equals: 'size' }
    },
    {
        kind: 'segments',
        id: 'height',
        section: 'picture',
        label: 'Définition',
        hint: 'Une vidéo n’est jamais agrandie : une définition plus haute que l’originale est ignorée.',
        options: [
            { value: 'source', label: 'Celle de l’original' },
            { value: '2160', label: '2160p (4K)' },
            { value: '1440', label: '1440p' },
            { value: '1080', label: '1080p' },
            { value: '720', label: '720p' },
            { value: '480', label: '480p' },
            { value: '360', label: '360p' }
        ],
        default: 'source'
    },
    {
        kind: 'segments',
        id: 'fps',
        section: 'picture',
        label: 'Images par seconde',
        options: [
            { value: 'source', label: 'Original' },
            { value: '60', label: '60' },
            { value: '30', label: '30' },
            { value: '24', label: '24' }
        ],
        default: 'source'
    },
    {
        kind: 'segments',
        id: 'speed',
        section: 'quality',
        label: 'Effort de compression',
        hint: 'À qualité égale, plus d’effort donne un fichier plus petit, et une conversion plus longue.',
        options: [
            { value: 'fast', label: 'Rapide' },
            { value: 'balanced', label: 'Équilibré' },
            { value: 'small', label: 'Compact' }
        ],
        default: 'balanced'
    },
    { kind: 'toggle', id: 'audio', section: 'sound', label: 'Garder le son', default: true },
    {
        kind: 'slider',
        id: 'audioBitrate',
        section: 'sound',
        label: 'Qualité du son',
        min: 64,
        max: 320,
        step: 16,
        default: 128,
        unit: 'kb/s',
        when: { option: 'audio', equals: true }
    },
    { kind: 'crop', id: 'crop', section: 'picture', label: 'Recadrer' },
    ...TRIM,
    {
        kind: 'toggle',
        id: 'stripMetadata',
        section: 'privacy',
        label: 'Retirer les informations cachées',
        hint: 'Une vidéo de téléphone embarque souvent le lieu et la date du tournage.',
        default: true
    }
];

const GIF_OPTIONS: readonly OptionSpec[] = [
    {
        kind: 'slider',
        id: 'gifWidth',
        section: 'picture',
        label: 'Largeur',
        hint: 'Un GIF pèse vite très lourd : la largeur et la cadence sont ses deux seuls leviers.',
        min: 120,
        max: 960,
        step: 20,
        default: 480,
        unit: 'px'
    },
    {
        kind: 'slider',
        id: 'gifFps',
        section: 'picture',
        label: 'Images par seconde',
        min: 5,
        max: 30,
        step: 1,
        default: 12
    },
    { kind: 'crop', id: 'crop', section: 'picture', label: 'Recadrer' },
    ...TRIM
];

const AUDIO_SHAPE: readonly OptionSpec[] = [
    {
        kind: 'segments',
        id: 'sampleRate',
        section: 'sound',
        label: 'Fréquence',
        options: [
            { value: 'source', label: 'Originale' },
            { value: '48000', label: '48 kHz' },
            { value: '44100', label: '44,1 kHz' },
            { value: '22050', label: '22 kHz' }
        ],
        default: 'source'
    },
    {
        kind: 'segments',
        id: 'channels',
        section: 'sound',
        label: 'Canaux',
        options: [
            { value: 'source', label: 'Originaux' },
            { value: '2', label: 'Stéréo' },
            { value: '1', label: 'Mono' }
        ],
        default: 'source'
    },
    {
        kind: 'toggle',
        id: 'normalize',
        section: 'sound',
        label: 'Égaliser le volume',
        hint: 'Ramène le niveau sonore à celui d’une diffusion ordinaire, sans écrêter.',
        default: false
    },
    ...TRIM
];

const AUDIO_BITRATE: OptionSpec = {
    kind: 'slider',
    id: 'bitrate',
    section: 'quality',
    label: 'Qualité',
    hint: '192 kb/s est indiscernable de l’original pour la plupart des oreilles.',
    min: 64,
    max: 320,
    step: 16,
    default: 192,
    unit: 'kb/s',
    marks: QUALITY_MARKS
};

const LOSSY_AUDIO: readonly OptionSpec[] = [AUDIO_BITRATE, ...AUDIO_SHAPE];

const IMAGE_SHAPE: readonly OptionSpec[] = [
    {
        kind: 'size',
        id: 'resize',
        section: 'picture',
        label: 'Dimensions',
        hint: 'Cadenas fermé, l’image garde ses proportions. Ouvert, elle est étirée aux dimensions exactes.'
    },
    { kind: 'crop', id: 'crop', section: 'picture', label: 'Recadrer' },
    {
        kind: 'toggle',
        id: 'stripMetadata',
        section: 'privacy',
        label: 'Retirer les informations cachées',
        hint: 'Une photo embarque souvent le lieu de la prise de vue, la date et le modèle de l’appareil.',
        default: true
    }
];

const IMAGE_QUALITY: OptionSpec = {
    kind: 'slider',
    id: 'quality',
    section: 'quality',
    label: 'Qualité',
    hint: 'Autour de 80, la compression ne se voit pas à l’œil nu.',
    min: 1,
    max: 100,
    step: 1,
    default: 82,
    marks: QUALITY_MARKS
};

const LOSSY_IMAGE: readonly OptionSpec[] = [IMAGE_QUALITY, ...IMAGE_SHAPE];

const PDF_PAGE: OptionSpec = {
    kind: 'slider',
    id: 'page',
    section: 'picture',
    label: 'Page à exporter',
    min: 1,
    max: 500,
    step: 1,
    default: 1
};
const PDF_DPI: OptionSpec = {
    kind: 'slider',
    id: 'dpi',
    section: 'picture',
    label: 'Finesse',
    hint: '150 suffit pour un écran, 300 pour une impression.',
    min: 72,
    max: 300,
    step: 6,
    default: 150,
    unit: 'ppp'
};

const x264 = {
    videoCodec: 'libx264',
    crf: { best: 17, worst: 36 },
    efficiency: 1,
    speed: { fast: ['-preset', 'veryfast'], balanced: ['-preset', 'medium'], small: ['-preset', 'slow'] }
} as const;

export const CATALOGUE: readonly KindSpec[] = [
    {
        id: 'video',
        label: 'Vidéo',
        description: 'Changer de format, alléger un fichier trop lourd, en tirer le son ou un GIF.',
        sources: [
            { id: 'mp4', label: 'MP4', ext: ['mp4', 'm4v'], group: 'video', readers: ['mov'] },
            { id: 'mov', label: 'MOV', ext: ['mov'], group: 'video', readers: ['mov'] },
            { id: 'mkv', label: 'MKV', ext: ['mkv'], group: 'video', readers: ['matroska'] },
            { id: 'webm', label: 'WebM', ext: ['webm'], group: 'video', readers: ['matroska'] },
            { id: 'avi', label: 'AVI', ext: ['avi'], group: 'video', readers: ['avi'] },
            { id: 'wmv', label: 'WMV', ext: ['wmv'], group: 'video', readers: ['asf'] },
            { id: 'flv', label: 'FLV', ext: ['flv'], group: 'video', readers: ['flv'] },
            {
                id: 'mpeg',
                label: 'MPEG',
                ext: ['mpg', 'mpeg', 'ts', 'm2ts'],
                group: 'video',
                readers: ['mpeg', 'mpegts', 'mpegvideo']
            },
            { id: '3gp', label: '3GP', ext: ['3gp'], group: 'video', readers: ['mov'] }
        ],
        targets: [
            {
                id: 'mp4',
                label: 'MP4',
                ext: 'mp4',
                mime: 'video/mp4',
                from: ['video'],
                options: VIDEO_OPTIONS,
                recipe: {
                    engine: 'video',
                    muxer: 'mp4',
                    ...x264,
                    audioCodec: 'aac',
                    overhead: 0.015,
                    extra: ['-pix_fmt', 'yuv420p', '-movflags', '+faststart']
                }
            },
            {
                id: 'webm',
                label: 'WebM',
                ext: 'webm',
                mime: 'video/webm',
                from: ['video'],
                options: VIDEO_OPTIONS,
                recipe: {
                    engine: 'video',
                    muxer: 'webm',
                    videoCodec: 'libvpx-vp9',
                    audioCodec: 'libopus',
                    crf: { best: 22, worst: 46 },
                    constantQuality: ['-b:v', '0'],
                    speed: {
                        fast: ['-deadline', 'good', '-cpu-used', '5'],
                        balanced: ['-deadline', 'good', '-cpu-used', '3'],
                        small: ['-deadline', 'good', '-cpu-used', '1']
                    },
                    efficiency: 0.7,
                    overhead: 0.005,
                    extra: ['-pix_fmt', 'yuv420p', '-row-mt', '1']
                }
            },
            {
                id: 'mkv',
                label: 'MKV',
                ext: 'mkv',
                mime: 'video/x-matroska',
                from: ['video'],
                options: VIDEO_OPTIONS,
                recipe: {
                    engine: 'video',
                    muxer: 'matroska',
                    ...x264,
                    audioCodec: 'aac',
                    overhead: 0.005,
                    extra: ['-pix_fmt', 'yuv420p']
                }
            },
            {
                id: 'mov',
                label: 'MOV',
                ext: 'mov',
                mime: 'video/quicktime',
                from: ['video'],
                options: VIDEO_OPTIONS,
                recipe: {
                    engine: 'video',
                    muxer: 'mov',
                    ...x264,
                    audioCodec: 'aac',
                    overhead: 0.015,
                    extra: ['-pix_fmt', 'yuv420p']
                }
            },
            {
                id: 'gif',
                label: 'GIF animé',
                ext: 'gif',
                mime: 'image/gif',
                from: ['video'],
                options: GIF_OPTIONS,
                recipe: { engine: 'gif' }
            },
            {
                id: 'mp3',
                label: 'MP3 (le son seul)',
                ext: 'mp3',
                mime: 'audio/mpeg',
                from: ['video'],
                options: LOSSY_AUDIO,
                recipe: { engine: 'audio', muxer: 'mp3', codec: 'libmp3lame', lossy: true, overhead: 0.002 }
            },
            {
                id: 'm4a',
                label: 'M4A (le son seul)',
                ext: 'm4a',
                mime: 'audio/mp4',
                from: ['video'],
                options: LOSSY_AUDIO,
                recipe: { engine: 'audio', muxer: 'ipod', codec: 'aac', lossy: true, overhead: 0.01 }
            }
        ]
    },
    {
        id: 'audio',
        label: 'Audio',
        description: 'Passer d’un format à l’autre, alléger une piste, égaliser le volume, garder un extrait.',
        sources: [
            { id: 'mp3', label: 'MP3', ext: ['mp3'], group: 'audio', readers: ['mp3'] },
            { id: 'wav', label: 'WAV', ext: ['wav'], group: 'audio', readers: ['wav'] },
            { id: 'flac', label: 'FLAC', ext: ['flac'], group: 'audio', readers: ['flac'] },
            { id: 'm4a', label: 'M4A / AAC', ext: ['m4a', 'aac'], group: 'audio', readers: ['mov', 'aac'] },
            { id: 'ogg', label: 'OGG', ext: ['ogg', 'oga'], group: 'audio', readers: ['ogg'] },
            { id: 'opus', label: 'Opus', ext: ['opus'], group: 'audio', readers: ['ogg'] },
            { id: 'wma', label: 'WMA', ext: ['wma'], group: 'audio', readers: ['asf'] },
            { id: 'aiff', label: 'AIFF', ext: ['aiff', 'aif'], group: 'audio', readers: ['aiff'] }
        ],
        targets: [
            {
                id: 'mp3',
                label: 'MP3',
                ext: 'mp3',
                mime: 'audio/mpeg',
                from: ['audio'],
                options: LOSSY_AUDIO,
                recipe: { engine: 'audio', muxer: 'mp3', codec: 'libmp3lame', lossy: true, overhead: 0.002 }
            },
            {
                id: 'm4a',
                label: 'M4A',
                ext: 'm4a',
                mime: 'audio/mp4',
                from: ['audio'],
                options: LOSSY_AUDIO,
                recipe: { engine: 'audio', muxer: 'ipod', codec: 'aac', lossy: true, overhead: 0.01 }
            },
            {
                id: 'ogg',
                label: 'OGG',
                ext: 'ogg',
                mime: 'audio/ogg',
                from: ['audio'],
                options: LOSSY_AUDIO,
                recipe: { engine: 'audio', muxer: 'ogg', codec: 'libvorbis', lossy: true, overhead: 0.01 }
            },
            {
                id: 'opus',
                label: 'Opus',
                ext: 'opus',
                mime: 'audio/ogg',
                from: ['audio'],
                options: LOSSY_AUDIO,
                recipe: { engine: 'audio', muxer: 'opus', codec: 'libopus', lossy: true, overhead: 0.01 }
            },
            {
                id: 'flac',
                label: 'FLAC (sans perte)',
                ext: 'flac',
                mime: 'audio/flac',
                from: ['audio'],
                options: AUDIO_SHAPE,
                recipe: { engine: 'audio', muxer: 'flac', codec: 'flac', lossy: false, overhead: 0 }
            },
            {
                id: 'wav',
                label: 'WAV (sans perte)',
                ext: 'wav',
                mime: 'audio/wav',
                from: ['audio'],
                options: AUDIO_SHAPE,
                recipe: { engine: 'audio', muxer: 'wav', codec: 'pcm_s16le', lossy: false, overhead: 0 }
            }
        ]
    },
    {
        id: 'image',
        label: 'Image',
        description: 'Changer de format, compresser, redimensionner, recadrer, retirer le lieu et la date cachés.',
        sources: [
            { id: 'jpg', label: 'JPEG / JPG', ext: ['jpg', 'jpeg'], group: 'raster', readers: ['JPEG'] },
            { id: 'png', label: 'PNG', ext: ['png'], group: 'raster', readers: ['PNG'] },
            { id: 'webp', label: 'WebP', ext: ['webp'], group: 'raster', readers: ['WEBP'] },
            { id: 'avif', label: 'AVIF', ext: ['avif'], group: 'raster', readers: ['AVIF'] },
            { id: 'heic', label: 'HEIC (iPhone)', ext: ['heic', 'heif'], group: 'raster', readers: ['HEIC'] },
            { id: 'tiff', label: 'TIFF', ext: ['tiff', 'tif'], group: 'raster', readers: ['TIFF'] },
            { id: 'bmp', label: 'BMP', ext: ['bmp'], group: 'raster', readers: ['BMP'] },
            { id: 'gif', label: 'GIF', ext: ['gif'], group: 'raster', readers: ['GIF'] }
        ],
        targets: [
            {
                id: 'jpg',
                label: 'JPEG / JPG',
                ext: 'jpg',
                mime: 'image/jpeg',
                from: ['raster'],
                options: LOSSY_IMAGE,
                recipe: { engine: 'image', coder: 'JPEG', lossy: true, alpha: false, bytesPerPixel: [0.03, 0.9] }
            },
            {
                id: 'png',
                label: 'PNG',
                ext: 'png',
                mime: 'image/png',
                from: ['raster'],
                options: IMAGE_SHAPE,
                recipe: { engine: 'image', coder: 'PNG', lossy: false, alpha: true, bytesPerPixel: [1.4, 1.4] }
            },
            {
                id: 'webp',
                label: 'WebP',
                ext: 'webp',
                mime: 'image/webp',
                from: ['raster'],
                options: LOSSY_IMAGE,
                recipe: { engine: 'image', coder: 'WEBP', lossy: true, alpha: true, bytesPerPixel: [0.02, 0.6] }
            },
            {
                id: 'avif',
                label: 'AVIF',
                ext: 'avif',
                mime: 'image/avif',
                from: ['raster'],
                options: LOSSY_IMAGE,
                recipe: { engine: 'image', coder: 'AVIF', lossy: true, alpha: true, bytesPerPixel: [0.012, 0.45] }
            },
            {
                id: 'tiff',
                label: 'TIFF',
                ext: 'tiff',
                mime: 'image/tiff',
                from: ['raster'],
                options: IMAGE_SHAPE,
                recipe: { engine: 'image', coder: 'TIFF', lossy: false, alpha: true, bytesPerPixel: [3, 3] }
            },
            {
                id: 'bmp',
                label: 'BMP',
                ext: 'bmp',
                mime: 'image/bmp',
                from: ['raster'],
                options: IMAGE_SHAPE,
                recipe: { engine: 'image', coder: 'BMP', lossy: false, alpha: false, bytesPerPixel: [3, 3] }
            },
            {
                id: 'pdf',
                label: 'PDF',
                ext: 'pdf',
                mime: 'application/pdf',
                from: ['raster'],
                options: LOSSY_IMAGE,
                recipe: { engine: 'image', coder: 'PDF', lossy: true, alpha: false, bytesPerPixel: [0.03, 0.9] }
            }
        ]
    },
    {
        id: 'document',
        label: 'Document',
        description: 'Un texte, un tableur ou un diaporama en PDF ou dans un autre format, un PDF allégé ou en image.',
        sources: [
            { id: 'docx', label: 'Word (DOCX)', ext: ['docx', 'doc'], group: 'text' },
            { id: 'odt', label: 'OpenDocument Texte', ext: ['odt'], group: 'text' },
            { id: 'rtf', label: 'RTF', ext: ['rtf'], group: 'text' },
            { id: 'txt', label: 'Texte brut', ext: ['txt'], group: 'text' },
            { id: 'html', label: 'Page HTML', ext: ['html', 'htm'], group: 'text' },
            { id: 'xlsx', label: 'Excel (XLSX)', ext: ['xlsx', 'xls'], group: 'sheet' },
            { id: 'ods', label: 'OpenDocument Tableur', ext: ['ods'], group: 'sheet' },
            { id: 'csv', label: 'CSV', ext: ['csv'], group: 'sheet' },
            { id: 'pptx', label: 'PowerPoint (PPTX)', ext: ['pptx', 'ppt'], group: 'slides' },
            { id: 'odp', label: 'OpenDocument Présentation', ext: ['odp'], group: 'slides' },
            { id: 'pdf', label: 'PDF', ext: ['pdf'], group: 'pdf' }
        ],
        targets: [
            {
                id: 'pdf',
                label: 'PDF',
                ext: 'pdf',
                mime: 'application/pdf',
                from: ['text', 'sheet', 'slides'],
                options: [],
                recipe: { engine: 'office', filter: 'pdf' }
            },
            {
                id: 'docx',
                label: 'Word (DOCX)',
                ext: 'docx',
                mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                from: ['text'],
                options: [],
                recipe: { engine: 'office', filter: 'docx' }
            },
            {
                id: 'odt',
                label: 'OpenDocument Texte',
                ext: 'odt',
                mime: 'application/vnd.oasis.opendocument.text',
                from: ['text'],
                options: [],
                recipe: { engine: 'office', filter: 'odt' }
            },
            {
                id: 'txt',
                label: 'Texte brut',
                ext: 'txt',
                mime: 'text/plain',
                from: ['text'],
                options: [],
                recipe: { engine: 'office', filter: 'txt:Text' }
            },
            {
                id: 'xlsx',
                label: 'Excel (XLSX)',
                ext: 'xlsx',
                mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                from: ['sheet'],
                options: [],
                recipe: { engine: 'office', filter: 'xlsx' }
            },
            {
                id: 'ods',
                label: 'OpenDocument Tableur',
                ext: 'ods',
                mime: 'application/vnd.oasis.opendocument.spreadsheet',
                from: ['sheet'],
                options: [],
                recipe: { engine: 'office', filter: 'ods' }
            },
            {
                id: 'csv',
                label: 'CSV',
                ext: 'csv',
                mime: 'text/csv',
                from: ['sheet'],
                options: [],
                recipe: { engine: 'office', filter: 'csv' }
            },
            {
                id: 'pptx',
                label: 'PowerPoint (PPTX)',
                ext: 'pptx',
                mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                from: ['slides'],
                options: [],
                recipe: { engine: 'office', filter: 'pptx' }
            },
            {
                id: 'odp',
                label: 'OpenDocument Présentation',
                ext: 'odp',
                mime: 'application/vnd.oasis.opendocument.presentation',
                from: ['slides'],
                options: [],
                recipe: { engine: 'office', filter: 'odp' }
            },
            {
                id: 'pdf-light',
                label: 'PDF allégé',
                ext: 'pdf',
                mime: 'application/pdf',
                from: ['pdf'],
                options: [
                    {
                        kind: 'segments',
                        id: 'level',
                        section: 'quality',
                        label: 'Allègement',
                        hint: 'Ce sont les images du document qui sont recompressées : un PDF de texte seul ne maigrit presque pas.',
                        options: [
                            { value: 'screen', label: 'Fort' },
                            { value: 'ebook', label: 'Équilibré' },
                            { value: 'printer', label: 'Léger' }
                        ],
                        default: 'ebook'
                    }
                ],
                recipe: { engine: 'pdfCompress' }
            },
            {
                id: 'png',
                label: 'Image PNG (une page)',
                ext: 'png',
                mime: 'image/png',
                from: ['pdf'],
                options: [PDF_PAGE, PDF_DPI],
                recipe: { engine: 'pdfImage', device: 'png' }
            },
            {
                id: 'jpg',
                label: 'Image JPEG / JPG (une page)',
                ext: 'jpg',
                mime: 'image/jpeg',
                from: ['pdf'],
                options: [PDF_PAGE, PDF_DPI],
                recipe: { engine: 'pdfImage', device: 'jpeg' }
            },
            {
                id: 'pdf-text',
                label: 'Texte brut',
                ext: 'txt',
                mime: 'text/plain',
                from: ['pdf'],
                options: [],
                recipe: { engine: 'pdfText' }
            }
        ]
    }
];

export function kindOf(id: ConvertKind): KindSpec {
    return CATALOGUE.find((k) => k.id === id) as KindSpec;
}

export function sourceOf(kind: ConvertKind, sourceId: string): SourceFormat | null {
    return kindOf(kind).sources.find((s) => s.id === sourceId) ?? null;
}

/** Ce qu'une source a le droit de devenir, dans l'ordre du catalogue. */
export function targetsFor(kind: ConvertKind, sourceId: string): readonly TargetFormat[] {
    const source = sourceOf(kind, sourceId);
    if (!source) return [];
    return kindOf(kind).targets.filter((t) => t.from.includes(source.group));
}

export function targetOf(kind: ConvertKind, sourceId: string, targetId: string): TargetFormat | null {
    return targetsFor(kind, sourceId).find((t) => t.id === targetId) ?? null;
}

/** La famille et le format d'un fichier, d'après son nom. `null` : rien de reconnu. */
export function detectSource(fileName: string): { kind: ConvertKind; source: SourceFormat } | null {
    const dot = fileName.lastIndexOf('.');
    if (dot === -1) return null;
    const ext = fileName.slice(dot + 1).toLowerCase();
    for (const kind of CATALOGUE) {
        const source = kind.sources.find((s) => s.ext.includes(ext));
        if (source) return { kind: kind.id, source };
    }
    return null;
}

/** Le nom du fichier produit : celui de l'original, sous l'extension de la cible. */
export function outputName(originalName: string, target: TargetFormat): string {
    const dot = originalName.lastIndexOf('.');
    const stem = dot > 0 ? originalName.slice(0, dot) : originalName;
    return `${stem || 'fichier'}.${target.ext}`;
}
