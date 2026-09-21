import type { SourceFormat, TargetFormat } from '../../contracts/catalogue';
import type { MediaInfo } from '../../contracts/estimate';
import type { OptionValues } from '../../contracts/options';
import type { JobPaths } from '../storage';

/** Ce que la sonde a lu du FICHIER, jamais ce que le client a déclaré. */
export interface InputProbe extends MediaInfo {
    /** Le nom sous lequel l'outil a reconnu le fichier, à redonner tel quel à la conversion. */
    reader: string | null;
    hasAudio: boolean;
    pages: number | null;
}

/** Une conversion à mener : des chemins, des réglages déjà validés, de quoi rendre compte. */
export interface EngineJob {
    source: SourceFormat;
    target: TargetFormat;
    options: OptionValues;
    probe: InputProbe;
    paths: JobPaths;
    signal: AbortSignal;
    /** L'avancement, en millièmes. Appelé souvent : c'est à l'appelant d'étrangler. */
    onProgress(permille: number): void;
}

/** La présence d'un outil sur ce serveur. `reason` nomme celui qui manque. */
export interface ToolStatus {
    available: boolean;
    reason: string | null;
}
