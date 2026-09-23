/**
 * 密钥保险箱（《阶段4》§9）。
 *
 * 铁律：
 *  R1 所有权不转移 —— 使用条件恒为「owner == 当前房主 且 state=ACTIVE」
 *  R3 原文只进不出 —— 明文只在「入站请求体」与「出站调用前的一瞬」存在；
 *                     任何角色（含房主本人、新房主、运维）都取不回明文，接口只返回掩码
 *
 * 加密：AES-256-GCM + 单一 MASTER_KEY（来源于环境变量），AAD 绑定
 *      credential_id | owner_player_id | room_id，防止密文被搬运到别的记录上。
 * 销毁：**物理删除**密文/指纹/掩码（只保留行与原因，用于审计）。
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export type CredentialState = 'validating' | 'active' | 'suspended' | 'destroyed';

export interface EncryptedBlob {
  cipher: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyId: string;
}

export interface CredentialRecord {
  id: string;
  ownerPlayerId: string;
  roomId: string | null;
  provider: string;
  model: string;
  baseUrlHost: string;
  state: CredentialState;
  mask: string | null;
  fingerprint: string | null;
  blob: EncryptedBlob | null;
  ttlExpiresAt: number | null;
  suspendReason: string | null;
  destroyedReason: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

export const KEY_ID = 'mk1';

export class Vault {
  private readonly master: Buffer | null;
  private readonly aadSalt: Buffer;

  constructor(masterKey: Buffer | null, aadSalt?: Buffer) {
    this.master = masterKey;
    this.aadSalt = aadSalt ?? Buffer.from('ht-vault-v1');
  }

  /** 未配置 MASTER_KEY 时功能关闭（不弱加密、不明文存储）。 */
  get enabled(): boolean {
    return this.master !== null;
  }

  private derive(): Buffer {
    if (!this.master) throw new Error('VAULT_DISABLED');
    // HKDF-lite：用 HMAC 派生用途专用子密钥，避免直接用主密钥加密
    return createHmac('sha256', this.master).update('credential-encryption-v1').digest();
  }

  private aad(credentialId: string, ownerPlayerId: string, roomId: string | null): Buffer {
    return Buffer.concat([this.aadSalt, Buffer.from(`${credentialId}|${ownerPlayerId}|${roomId ?? '-'}`)]);
  }

  maskOf(apiKey: string): string {
    const clean = apiKey.trim();
    if (clean.length <= 8) return '****';
    return `${clean.slice(0, 3)}****${clean.slice(-4)}`;
  }

  fingerprintOf(apiKey: string): string {
    if (!this.master) throw new Error('VAULT_DISABLED');
    return createHmac('sha256', this.master).update(apiKey).digest('hex').slice(0, 16);
  }

  encrypt(apiKey: string, credentialId: string, ownerPlayerId: string, roomId: string | null): EncryptedBlob {
    const key = this.derive();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(this.aad(credentialId, ownerPlayerId, roomId));
    const enc = Buffer.concat([cipher.update(apiKey, 'utf8'), cipher.final()]);
    return { cipher: enc, iv, tag: cipher.getAuthTag(), keyId: KEY_ID };
  }

  /** 只有在"要出站调用"或"归还复测"时才解密，且调用方用完即弃。 */
  decrypt(blob: EncryptedBlob, credentialId: string, ownerPlayerId: string, roomId: string | null): string {
    const key = this.derive();
    const decipher = createDecipheriv('aes-256-gcm', key, blob.iv);
    decipher.setAAD(this.aad(credentialId, ownerPlayerId, roomId));
    decipher.setAuthTag(blob.tag);
    return Buffer.concat([decipher.update(blob.cipher), decipher.final()]).toString('utf8');
  }

  sameFingerprint(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && timingSafeEqual(ba, bb);
  }
}

/** 判断凭据此刻是否可用：必须 ACTIVE + 归属当前房主 + 未过 TTL。 */
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
