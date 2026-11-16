// Encryption at rest and anonymous identities.
// MASTER_KEY (a Worker secret, 32+ random characters) never touches the database.
//  - Text is sealed with AES-256-GCM. The row id is bound in as additional data, so a ciphertext cannot be moved to another row.
//  - A visitor's "mailbox key" is never stored. Only an HMAC of it is, so rows carry no key and no network address.
// Honest limit: whoever holds MASTER_KEY (the operator) can decrypt. This is encryption at rest, not end-to-end.

const enc = new TextEncoder(), dec = new TextDecoder();

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

export class Vault {
  constructor(b64) { this.raw = b64; this.ready = null; }

  // Any secret of 32+ characters works (a hex string from `openssl rand -hex 32`, or a long password-manager string).
  // HKDF below stretches it into separate encryption and HMAC keys.
  static valid(secret) { return typeof secret === 'string' && secret.trim().length >= 32; }

  async init() {
    if (!this.ready) {
      this.ready = (async () => {
        if (!Vault.valid(this.raw)) throw new Error('MASTER_KEY missing or shorter than 32 characters');
        const base = await crypto.subtle.importKey('raw', enc.encode(this.raw.trim()), 'HKDF', false, ['deriveKey', 'deriveBits']);
        const salt = new Uint8Array(32);
        this.aes = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('gohaeso/v1/aes') },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        const mac = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode('gohaeso/v1/mac') }, base, 256);
        this.mac = await crypto.subtle.importKey('raw', mac, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      })();
    }
    return this.ready;
  }

  async seal(text, aad) {
    await this.init();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, this.aes, enc.encode(text));
    return { ct: new Uint8Array(ct), iv };
  }

  async open(ct, iv, aad) {
    await this.init();
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(iv), additionalData: enc.encode(aad) }, this.aes, new Uint8Array(ct));
    return dec.decode(pt);
  }

  async tag(label, value) {
    await this.init();
    return hex(await crypto.subtle.sign('HMAC', this.mac, enc.encode(label + ':' + value))).slice(0, 32);
  }
}
