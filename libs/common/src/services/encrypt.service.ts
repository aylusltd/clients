import { CryptoFunctionService } from "@bitwarden/common/abstractions/cryptoFunction.service";
import { LogService } from "@bitwarden/common/abstractions/log.service";
import { Utils } from "@bitwarden/common/misc/utils";
import { EncString } from "@bitwarden/common/models/domain/encString";
import { EncryptedObject } from "@bitwarden/common/models/domain/encryptedObject";
import { SymmetricCryptoKey } from "@bitwarden/common/models/domain/symmetricCryptoKey";

import { AbstractEncryptService } from "../abstractions/abstractEncrypt.service";
import { EncryptionType } from "../enums/encryptionType";
import { EncArrayBuffer } from "../models/domain/encArrayBuffer";

export class EncryptService implements AbstractEncryptService {
  constructor(
    private cryptoFunctionService: CryptoFunctionService,
    private logService: LogService,
    private logMacFailures: boolean
  ) {}

  async encrypt(plainValue: string | ArrayBuffer, key: SymmetricCryptoKey): Promise<EncString> {
    if (key == null) {
      throw new Error("No encryption key provided.");
    }

    if (plainValue == null) {
      return Promise.resolve(null);
    }

    let plainBuf: ArrayBuffer;
    if (typeof plainValue === "string") {
      plainBuf = Utils.fromUtf8ToArray(plainValue).buffer;
    } else {
      plainBuf = plainValue;
    }

    const encObj = await this.aesEncrypt(plainBuf, key);
    const iv = Utils.fromBufferToB64(encObj.iv);
    const data = Utils.fromBufferToB64(encObj.data);
    const mac = encObj.mac != null ? Utils.fromBufferToB64(encObj.mac) : null;
    return new EncString(encObj.key.encType, data, iv, mac);
  }

  async encryptToBytes(plainValue: ArrayBuffer, key: SymmetricCryptoKey): Promise<EncArrayBuffer> {
    if (key == null) {
      throw new Error("No encryption key provided.");
    }

    const encValue = await this.aesEncrypt(plainValue, key);
    let macLen = 0;
    if (encValue.mac != null) {
      macLen = encValue.mac.byteLength;
    }

    const encBytes = new Uint8Array(1 + encValue.iv.byteLength + macLen + encValue.data.byteLength);
    encBytes.set([encValue.key.encType]);
    encBytes.set(new Uint8Array(encValue.iv), 1);
    if (encValue.mac != null) {
      encBytes.set(new Uint8Array(encValue.mac), 1 + encValue.iv.byteLength);
    }

    encBytes.set(new Uint8Array(encValue.data), 1 + encValue.iv.byteLength + macLen);
    return new EncArrayBuffer(encBytes.buffer);
  }

  async decryptToUtf8(encString: EncString, key: SymmetricCryptoKey): Promise<string> {
    if (key == null) {
      throw new Error("No encryption key provided.");
    }

    if (key.macKey != null && encString?.mac == null) {
      this.logService.error("mac required.");
      return null;
    }

    if (key.encType !== encString.encryptionType) {
      this.logService.error("encType unavailable.");
      return null;
    }

    const fastParams = this.cryptoFunctionService.aesDecryptFastParameters(
      encString.data,
      encString.iv,
      encString.mac,
      key
    );
    if (fastParams.macKey != null && fastParams.mac != null) {
      const computedMac = await this.cryptoFunctionService.hmacFast(
        fastParams.macData,
        fastParams.macKey,
        "sha256"
      );
      const macsEqual = await this.cryptoFunctionService.compareFast(fastParams.mac, computedMac);
      if (!macsEqual) {
        this.logMacFailed("mac failed.");
        return null;
      }
    }

    return this.cryptoFunctionService.aesDecryptFast(fastParams);
  }

  async decryptToBytes(encString: EncString, key: SymmetricCryptoKey): Promise<ArrayBuffer> {
    if (key == null) {
      throw new Error("No key provided for decryption.");
    }

    const iv = Utils.fromB64ToArray(encString.iv).buffer;
    const data = Utils.fromB64ToArray(encString.data).buffer;
    const mac = encString.mac ? Utils.fromB64ToArray(encString.mac).buffer : null;
    const decipher = await this.aesDecryptToBytes(encString.encryptionType, data, iv, mac, key);
    if (decipher == null) {
      return null;
    }

    return decipher;
  }

  async decryptFromBytes(encBuffer: EncArrayBuffer, key: SymmetricCryptoKey): Promise<ArrayBuffer> {
    if (key == null) {
      throw new Error("No key provided for decryption.");
    }

    return this.aesDecryptToBytes(
      encBuffer.encType,
      encBuffer.ctBytes,
      encBuffer.ivBytes,
      encBuffer.macBytes != null ? encBuffer.macBytes : null,
      key
    );
  }

  private async aesEncrypt(data: ArrayBuffer, key: SymmetricCryptoKey): Promise<EncryptedObject> {
    const obj = new EncryptedObject();
    obj.key = key;
    obj.iv = await this.cryptoFunctionService.randomBytes(16);
    obj.data = await this.cryptoFunctionService.aesEncrypt(data, obj.iv, obj.key.encKey);

    if (obj.key.macKey != null) {
      const macData = new Uint8Array(obj.iv.byteLength + obj.data.byteLength);
      macData.set(new Uint8Array(obj.iv), 0);
      macData.set(new Uint8Array(obj.data), obj.iv.byteLength);
      obj.mac = await this.cryptoFunctionService.hmac(macData.buffer, obj.key.macKey, "sha256");
    }

    return obj;
  }

  private async aesDecryptToBytes(
    encType: EncryptionType,
    data: ArrayBuffer,
    iv: ArrayBuffer,
    mac: ArrayBuffer,
    key: SymmetricCryptoKey
  ): Promise<ArrayBuffer> {
    if (key.macKey != null && mac == null) {
      return null;
    }

    if (key.encType !== encType) {
      return null;
    }

    if (key.macKey != null && mac != null) {
      const macData = new Uint8Array(iv.byteLength + data.byteLength);
      macData.set(new Uint8Array(iv), 0);
      macData.set(new Uint8Array(data), iv.byteLength);
      const computedMac = await this.cryptoFunctionService.hmac(
        macData.buffer,
        key.macKey,
        "sha256"
      );
      if (computedMac === null) {
        return null;
      }

      const macsMatch = await this.cryptoFunctionService.compare(mac, computedMac);
      if (!macsMatch) {
        this.logService.error("mac failed.");
        return null;
      }
    }

    return await this.cryptoFunctionService.aesDecrypt(data, iv, key.encKey);
  }

  private logMacFailed(msg: string) {
    if (this.logMacFailures) {
      this.logService.error(msg);
    }
  }
}