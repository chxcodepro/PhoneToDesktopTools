// 局域网加密通道用的 AES-256-GCM：expo-crypto 调用系统原生实现（Android 上有硬件加速），
// 比纯 JavaScript 的 ChaCha20 快几十倍，虚拟桌面走 WiFi 时帧率才上得去。

import { aesDecryptAsync, aesEncryptAsync, AESEncryptionKey, AESSealedData } from 'expo-crypto';

import type { AesGcm } from './secure';

export const nativeAes: AesGcm = {
  importKey: (key) => AESEncryptionKey.import(key),
  encrypt: async (key, nonce, plaintext) => {
    const sealed = await aesEncryptAsync(plaintext, key as AESEncryptionKey, { nonce: { bytes: nonce } });
    return sealed.ciphertext({ includeTag: true });
  },
  decrypt: (key, nonce, sealed) => aesDecryptAsync(AESSealedData.fromParts(nonce, sealed, 16), key as AESEncryptionKey),
};
