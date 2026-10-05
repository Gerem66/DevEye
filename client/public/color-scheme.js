// Le thème posé avant la première peinture, sans attendre le bundle : sinon une
// page claire s'ouvre sur un éclair sombre. Un fichier et non un script en ligne,
// que la politique de contenu (`script-src 'self'`) refuserait. Relit la clé que
// tient `src/stores/colorScheme.ts`, qui recalcule tout au chargement.
(function () {
    try {
        var stored = JSON.parse(localStorage.getItem('deveye:color-scheme') || 'null');
        var mode = stored && stored.mode;
        var light = false;
        if (mode === 'light') light = true;
        else if (mode === 'system') light = window.matchMedia('(prefers-color-scheme: light)').matches;
        else if (mode === 'auto' && stored.sun) {
            var now = new Date();
            var minutes = now.getHours() * 60 + now.getMinutes();
            light = minutes >= stored.sun.rise && minutes < stored.sun.set;
        }
        if (light) document.documentElement.setAttribute('data-theme', 'light');
    } catch {
        // Rien de lisible : le thème sombre par défaut.
    }
})();
