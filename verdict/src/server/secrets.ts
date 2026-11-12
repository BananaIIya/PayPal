// 静态加密：商家的 PayPal secret 用 AES-256-GCM 加密后存库，密钥来自环境变量 APP_ENCRYPTION_KEY。
// 密钥不写进数据目录：数据库文件或备份单独泄漏时，secret 仍然读不出来。
import crypto from 'node:crypto';

const VERSION = 'v1';

export class EncryptionKeyError extends Error {}

/** 接受 64 位十六进制或 base64（解码后 32 字节）。 */
export function encryptionKey(): Buffer | null {
  const raw = process.env.APP_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new EncryptionKeyError('APP_ENCRYPTION_KEY must be 32 bytes: 64 hex characters, or base64. Generate one with openssl rand -hex 32.');
  return key;
}

export function encryptionKeyState(): { configured: boolean; error: string | null } {
  try {
    return { configured: !!encryptionKey(), error: null };
  } catch (e) {
    return { configured: false, error: (e as Error).message };
  }
}

function requireKey(): Buffer {
  const key = encryptionKey();
  if (!key) throw new EncryptionKeyError('APP_ENCRYPTION_KEY is not configured, so credentials cannot be stored encrypted.');
  return key;
}

/**
 * aad 把密文绑定到用途和所属商家：把 A 商家的密文挪到 B 商家的行里会解密失败。
 * 格式：v1.<iv>.<tag>.<密文>，均为 base64url。
 */
export function encryptSecret(plain: string, aad: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', requireKey(), iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decryptSecret(enc: string, aad: string): string {
  const [version, iv, tag, ct] = enc.split('.');
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error('Unrecognized ciphertext format');
  const decipher = crypto.createDecipheriv('aes-256-gcm', requireKey(), Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new EncryptionKeyError('Decryption failed: APP_ENCRYPTION_KEY differs from the one used to encrypt, or the ciphertext was modified.');
  }
}
