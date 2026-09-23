/**
 * Workers 侧密钥保险箱（WebCrypto AES-256-GCM），与 Node 版 `packages/server/src/vault.ts` 行为等价：
 *  · 同一套 AAD 绑定（credential_id | owner_player_id | room_id）——密文不可被搬运到别的记录
 *  · 掩码是唯一可展示形态；指纹仅用于查重；销毁 = 物理清空
 *  · MASTER_KEY 缺失即关闭该功能（不退化为明文或弱加密）
 *
 * 与 Node 版的差异只在实现：node:crypto → WebCrypto（因此 encrypt/decrypt 是异步的）。
 */
import type { CredentialRecord, CredentialState, EncryptedBlob } from '../../server/src/vault.ts';

export interface VaultBlob {
  cipher: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyId: string;
}

export const KEY_ID = 'mk1';

export class WebCryptoVault {
  private readonly master: Uint8Array | null;
  private keyPromise: Promise<CryptoKey> | null = null;
  private readonly aadSalt: Uint8Array;

  constructor(masterKeyBase64: string | undefined | null) {
    const bytes = masterKeyBase64 ? base64ToBytes(masterKeyBase64.trim()) : null;
    this.master = bytes && bytes.length >= 32 ? bytes.subarray(0, 32) : null;
    this.aadSalt = new TextEncoder().encode('ht-vault-v1');
  }

  get enabled(): boolean { return this.master !== null; }

  private async aesKey(): Promise<CryptoKey> {
    if (!this.master) throw new Error('VAULT_DISABLED');
    this.keyPromise ??= crypto.subtle.importKey('raw', this.master, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    return this.keyPromise;
  }

  private aad(credentialId: string, ownerPlayerId: string, roomId: string | null): Uint8Array {
    const tail = new TextEncoder().encode(`${credentialId}|${ownerPlayerId}|${roomId ?? '-'}`);
    const out = new Uint8Array(this.aadSalt.length + tail.length);
    out.set(this.aadSalt, 0);
    out.set(tail, this.aadSalt.length);
    return out;
  }

  maskOf(apiKey: string): string {
    const clean = apiKey.trim();
    if (clean.length <= 8) return '****';
    return `${clean.slice(0, 3)}****${clean.slice(-4)}`;
  }

  /** 指纹：HMAC-SHA256(MASTER_KEY, apiKey) 前 16 个十六进制字符（与 Node 版同构，便于迁移核对）。 */
  async fingerprintOf(apiKey: string): Promise<string> {
    if (!this.master) throw new Error('VAULT_DISABLED');
    const key = await crypto.subtle.importKey('raw', this.master, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(apiKey));
    return [...new Uint8Array(mac).slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  async encrypt(apiKey: string, credentialId: string, ownerPlayerId: string, roomId: string | null): Promise<VaultBlob> {
    const key = await this.aesKey();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: this.aad(credentialId, ownerPlayerId, roomId) },
      key,
      new TextEncoder().encode(apiKey),
    );
    // WebCrypto 的 AES-GCM 输出把 tag 附在密文末尾
    const all = new Uint8Array(cipher);
    return { cipher: all.slice(0, all.length - 16), iv, tag: all.slice(all.length - 16), keyId: KEY_ID };
  }

  async decrypt(blob: VaultBlob, credentialId: string, ownerPlayerId: string, roomId: string | null): Promise<string> {
    const key = await this.aesKey();
    const joined = new Uint8Array(blob.cipher.length + blob.tag.length);
    joined.set(blob.cipher, 0);
    joined.set(blob.tag, blob.cipher.length);
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: blob.iv, additionalData: this.aad(credentialId, ownerPlayerId, roomId) },
      key,
      joined,
    );
    return new TextDecoder().decode(plain);
  }
}

function base64ToBytes(base64: string): Uint8Array | null {
  try {
    const normalized = base64.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(normalized);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** 凭据是否可用（与 Node 版 `credentialUsable` 同一规则）。 */
export function credentialUsable(
  cred: CredentialRecord | null,
  currentHostPlayerId: string | null,
  now: number,
): boolean {
  if (!cred) return false;
  if (cred.state !== 'active') return false;
  if (!currentHostPlayerId || cred.ownerPlayerId !== currentHostPlayerId) return false;
  if (cred.ttlExpiresAt !== null && now >= cred.ttlExpiresAt) return false;
  return true;
}

export type { CredentialRecord, CredentialState, EncryptedBlob };
export { WebCryptoVault as Vault };
