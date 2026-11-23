export interface EmailDispatchOptions {
  requestId: string;
  recipient: string;
  subject: string;
  bodyText?: string;
  bodyHtml?: string;
  sender?: string;
  headers?: Record<string, string>;
}

export interface ProviderSendResult {
  success: boolean;
  providerMessageId?: string;
  providerId: string;
  status: 'SENT' | 'FAILED';
  durationMs: number;
  error?: string;
  isTemporaryError?: boolean;
  rawResponse?: string;
}

export interface IEmailProvider {
  readonly id: string;
  readonly name: string;
  send(options: EmailDispatchOptions): Promise<ProviderSendResult>;
  verify(): Promise<boolean>;
  close?(): Promise<void>;
}
