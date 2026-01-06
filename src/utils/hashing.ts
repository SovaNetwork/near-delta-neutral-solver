import * as crypto from 'crypto';
import { BorshSchema, borshSerialize } from 'borsher';
import { SignStandardEnum } from '../interfaces/intents.interface';

const standardNumber = {
  [SignStandardEnum.nep413]: 413,
};

const nep413PayloadSchema = BorshSchema.Struct({
  message: BorshSchema.String,
  nonce: BorshSchema.Array(BorshSchema.u8, 32),
  recipient: BorshSchema.String,
  callback_url: BorshSchema.Option(BorshSchema.String),
});

export function serializeIntent(
  intentMessage: string,
  recipient: string,
  nonce: string,
  standard: SignStandardEnum,
): Buffer {
  if (!standardNumber[standard]) throw new Error(`Unsupported standard: ${standard}`);
  const nonceBuffer = Buffer.from(nonce, 'base64');
  const payload = {
    message: intentMessage,
    nonce: Array.from(nonceBuffer),
    recipient,
    callback_url: null
  };
  const payloadSerialized = borshSerialize(nep413PayloadSchema, payload);
  const baseInt = 2 ** 31 + standardNumber[standard];
  const baseIntSerialized = borshSerialize(BorshSchema.u32, baseInt);
  const combinedData = Buffer.concat([baseIntSerialized, payloadSerialized]);
  return crypto.createHash('sha256').update(combinedData).digest();
}

export function generateRandomNonce(): string {
  return Buffer.from(crypto.randomBytes(32)).toString('base64');
}
