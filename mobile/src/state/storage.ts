// 本地持久化（AsyncStorage + JSON）。
// 注意：API Key 等敏感信息后续改存 expo-secure-store（Android Keystore / iOS Keychain），不要放这里。

import AsyncStorage from '@react-native-async-storage/async-storage';

export const StorageKeys = {
  permissions: 'p2d.permissions.v1',
  knownComputers: 'p2d.knownComputers.v1',
} as const;

export async function loadJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function saveJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch {
    // 存储失败不影响使用
  }
}
