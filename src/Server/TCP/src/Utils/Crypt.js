class MyCrypto {
    constructor(keyA, keyB) {
      this.keyA = keyA;
      this.keyB = keyB;
      this.cipherAlgo = { name: "AES-CTR" }; // AES-CTR configuration
      // Assurez-vous de convertir keyA et keyB en CryptoKey pour AES et HMAC respectivement
    }
  
    async encrypt(plaintext) {
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const encodedMessage = new TextEncoder().encode(plaintext);
      const keyA = await this.importKey(this.keyA, "AES");
      const ciphertext = await crypto.subtle.encrypt({ ...this.cipherAlgo, counter: nonce, length: 128 }, keyA, encodedMessage);
      
      const keyB = await this.importKey(this.keyB, "HMAC");
      const mac = await crypto.subtle.sign("HMAC", keyB, this.concatBuffers(nonce, new Uint8Array(ciphertext)));
  
      //@ts-ignore
      return btoa(String.fromCharCode(...new Uint8Array(this.concatBuffers(mac, nonce, ciphertext))));
    }
  
    async decrypt(message) {
      const decoded = atob(message);
      const buffer = new Uint8Array(decoded.length);
      for (let i = 0; i < decoded.length; i++) {
        buffer[i] = decoded.charCodeAt(i);
      }
  
      const mac = buffer.slice(0, 64);
      const nonce = buffer.slice(64, 80);
      const ciphertext = buffer.slice(80);
  
      const keyB = await this.importKey(this.keyB, "HMAC");
      const calc = await crypto.subtle.sign("HMAC", keyB, this.concatBuffers(nonce, ciphertext));
  
      if (!this.isEqualBuffers(mac, calc)) {
        return null;
      }
  
      const keyA = await this.importKey(this.keyA, "AES");
      const decrypted = await crypto.subtle.decrypt({ ...this.cipherAlgo, counter: nonce, length: 128 }, keyA, ciphertext);
      return new TextDecoder().decode(decrypted);
    }
  
    async importKey(key, type) {
      if (type === "AES") {
        return crypto.subtle.importKey("raw", new TextEncoder().encode(key), "AES-CTR", false, ["encrypt", "decrypt"]);
      } else if (type === "HMAC") {
        return crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: { name: "SHA-512" } }, false, ["sign"]);
      }
    }
  
    concatBuffers(...buffers) {
      const totalLength = buffers.reduce((acc, value) => acc + value.length, 0);
      const result = new Uint8Array(totalLength);
      let length = 0;
      for (const buffer of buffers) {
        result.set(buffer, length);
        length += buffer.length;
      }
      return result;
    }
  
    isEqualBuffers(buf1, buf2) {
      if (buf1.byteLength !== buf2.byteLength) {
        return false;
      }
      const view1 = new DataView(buf1);
      const view2 = new DataView(buf2);
      for (let i = 0; i < buf1.byteLength; i++) {
        if (view1.getUint8(i) !== view2.getUint8(i)) {
          return false;
        }
      }
      return true;
    }
  }

export default MyCrypto;
