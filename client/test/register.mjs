/**
 * Le préchargement des tests de composants (`npm run test:ui`) : ce que Vite
 * fait d'un import de style ou d'image, puis un DOM. Chargé par `NODE_OPTIONS`,
 * donc par chaque processus de la passe : seul celui d'un fichier de test se
 * donne un DOM.
 */
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);

if (process.argv.some((arg) => /\.test\.tsx$/.test(arg) && !arg.includes('*'))) {
    await import('./globals.mjs');
}
