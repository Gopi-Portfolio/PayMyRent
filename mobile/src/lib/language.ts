// The language a person chose, remembered on this phone (also before they have signed in), and applied again when the app opens.
import * as SecureStore from 'expo-secure-store';

const KEY = 'rg.language';
export async function saveLanguage(code: string): Promise<void> {
  try { await SecureStore.setItemAsync(KEY, code); } catch { /* the choice still applies for this session */ }
}
export async function loadLanguage(): Promise<string | null> {
  try { return await SecureStore.getItemAsync(KEY); } catch { return null; }
}
