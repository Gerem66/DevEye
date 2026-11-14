import { z } from 'zod';

/**
 * Ce que la veille sait lire, détecteur par détecteur. Le serveur étiquette
 * chaque composant trouvé de son format ; l'écran « Formats reconnus » liste
 * le catalogue entier et coche ce que l'espace contient.
 */

export const formatFamilySchema = z.enum(['lock', 'tool']);
export type FormatFamily = z.infer<typeof formatFamilySchema>;

export const formatIdSchema = z.enum([
    'package-lock.json',
    'npm-shrinkwrap.json',
    'yarn.lock',
    'pnpm-lock.yaml',
    'bun.lock',
    'Cargo.lock',
    'poetry.lock',
    'uv.lock',
    'pdm.lock',
    'Pipfile.lock',
    'requirements.txt',
    'go.sum',
    'go.mod',
    'composer.lock',
    'Gemfile.lock',
    'pubspec.lock',
    'packages.lock.json',
    'gradle.lockfile',
    'mix.lock',
    'Package.resolved',
    'github-workflow',
    'Dockerfile',
    'compose',
    '.nvmrc',
    '.node-version',
    '.python-version',
    '.ruby-version',
    '.tool-versions',
    'rust-toolchain',
    'engines'
]);
export type FormatId = z.infer<typeof formatIdSchema>;

export interface ExposureFormat {
    id: FormatId;
    family: FormatFamily;
    /** Le nom tel qu'on le voit dans un dépôt. */
    label: string;
    /** Ce que le format apprend à la veille. */
    detail: string;
}

export const FORMAT_FAMILY_LABEL: Record<FormatFamily, string> = {
    lock: 'Fichiers de verrouillage',
    tool: 'Outils et images'
};

export const EXPOSURE_FORMATS: readonly ExposureFormat[] = [
    { id: 'package-lock.json', family: 'lock', label: 'package-lock.json', detail: 'npm' },
    { id: 'npm-shrinkwrap.json', family: 'lock', label: 'npm-shrinkwrap.json', detail: 'npm' },
    { id: 'yarn.lock', family: 'lock', label: 'yarn.lock', detail: 'Yarn' },
    { id: 'pnpm-lock.yaml', family: 'lock', label: 'pnpm-lock.yaml', detail: 'pnpm' },
    { id: 'bun.lock', family: 'lock', label: 'bun.lock', detail: 'Bun' },
    { id: 'Cargo.lock', family: 'lock', label: 'Cargo.lock', detail: 'Rust' },
    { id: 'poetry.lock', family: 'lock', label: 'poetry.lock', detail: 'Python (Poetry)' },
    { id: 'uv.lock', family: 'lock', label: 'uv.lock', detail: 'Python (uv)' },
    { id: 'pdm.lock', family: 'lock', label: 'pdm.lock', detail: 'Python (PDM)' },
    { id: 'Pipfile.lock', family: 'lock', label: 'Pipfile.lock', detail: 'Python (Pipenv)' },
    {
        id: 'requirements.txt',
        family: 'lock',
        label: 'requirements.txt',
        detail: 'Python, versions épinglées par « == » seulement'
    },
    { id: 'go.sum', family: 'lock', label: 'go.sum', detail: 'Go' },
    { id: 'go.mod', family: 'lock', label: 'go.mod', detail: 'La version de Go et sa bibliothèque standard' },
    { id: 'composer.lock', family: 'lock', label: 'composer.lock', detail: 'PHP' },
    { id: 'Gemfile.lock', family: 'lock', label: 'Gemfile.lock', detail: 'Ruby' },
    { id: 'pubspec.lock', family: 'lock', label: 'pubspec.lock', detail: 'Dart et Flutter' },
    { id: 'packages.lock.json', family: 'lock', label: 'packages.lock.json', detail: '.NET (NuGet)' },
    { id: 'gradle.lockfile', family: 'lock', label: 'gradle.lockfile', detail: 'Java et Kotlin (Gradle)' },
    { id: 'mix.lock', family: 'lock', label: 'mix.lock', detail: 'Elixir' },
    { id: 'Package.resolved', family: 'lock', label: 'Package.resolved', detail: 'Swift' },
    {
        id: 'github-workflow',
        family: 'lock',
        label: '.github/workflows/*.yml',
        detail: 'Les actions GitHub en version exacte'
    },
    { id: 'Dockerfile', family: 'tool', label: 'Dockerfile', detail: 'Les images de base (FROM)' },
    { id: 'compose', family: 'tool', label: 'docker-compose.yml', detail: 'Les images des services (image:)' },
    { id: '.nvmrc', family: 'tool', label: '.nvmrc', detail: 'La version de Node' },
    { id: '.node-version', family: 'tool', label: '.node-version', detail: 'La version de Node' },
    { id: '.python-version', family: 'tool', label: '.python-version', detail: 'La version de Python' },
    { id: '.ruby-version', family: 'tool', label: '.ruby-version', detail: 'La version de Ruby' },
    { id: '.tool-versions', family: 'tool', label: '.tool-versions', detail: 'Les outils épinglés par asdf ou mise' },
    { id: 'rust-toolchain', family: 'tool', label: 'rust-toolchain.toml', detail: 'La version de Rust' },
    { id: 'engines', family: 'tool', label: 'package.json (engines)', detail: 'La version de Node exigée' }
];
