export enum SignStandardEnum {
  nep413 = 'nep413',
}

export interface ITokenDiff {
  intent: 'token_diff';
  diff: { [key: string]: string };
  receiver_id?: string;
}

export interface ITransfer {
  intent: 'transfer';
  token_id: string;
  amount: string;
  receiver_id: string;
}

export interface IWithdraw {
  intent: 'ft_withdraw' | 'native_withdraw';
  token_id: string;
  amount: string;
  receiver_id: string;
}

export type IIntent = ITokenDiff | ITransfer | IWithdraw;

export interface IMessage {
  signer_id: string;
  deadline: string;
  intents: IIntent[];
}
