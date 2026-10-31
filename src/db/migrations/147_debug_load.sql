-- La montée en charge de la page Tests et débogage range ses essais avec les
-- autres. Élargir l'énumération ne touche aucune ligne existante, et se rejoue
-- sans effet.
ALTER TABLE debug_runs MODIFY COLUMN kind ENUM('e2e', 'bench', 'load') NOT NULL;
