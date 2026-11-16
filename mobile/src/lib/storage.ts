// Small durable storage for what is kept on the phone for offline use (the saved cache, the queue of entries waiting to be sent, the signed-in profile).
// It is wiped on sign-out (see offlineData.ts).
import AsyncStorage from '@react-native-async-storage/async-storage';

export type KeyValue = {
  getJson<T>(key: string): Promise<T | null>;
  setJson(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
};

export const storage: KeyValue = {
  async getJson<T>(key: string) {
    try { const raw = await AsyncStorage.getItem(key); return raw ? (JSON.parse(raw) as T) : null; } catch { return null; }      // unreadable data is treated as empty
  },
  async setJson(key, value) { await AsyncStorage.setItem(key, JSON.stringify(value)); },
  async remove(key) { try { await AsyncStorage.removeItem(key); } catch { /* nothing to remove */ } },
};
