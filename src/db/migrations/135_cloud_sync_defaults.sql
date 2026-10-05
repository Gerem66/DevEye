-- Valeurs par défaut d'un dossier CloudSync neuf : un point de restauration par
-- jour gardé 30 jours, corbeille locale des appareils de 7 jours. Les dossiers
-- existants gardent leurs valeurs, écrites dans leurs lignes.
ALTER TABLE sync_shares
    ALTER COLUMN snapshot_interval_hours SET DEFAULT 24,
    ALTER COLUMN snapshot_keep_days SET DEFAULT 30,
    ALTER COLUMN trash_keep_days SET DEFAULT 7;
