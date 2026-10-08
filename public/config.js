// Supabase-Verbindung. Wird beim Deployment über GitHub Actions automatisch
// aus den Repository-Variablen SUPABASE_URL und SUPABASE_KEY befüllt.
// Leer = lokaler Modus (Daten nur auf diesem Gerät).
window.EISSTOCK_CONFIG = {
  supabaseUrl: '',
  supabaseKey: '',
};
