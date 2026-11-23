export type EmailStatus =
  | 'ACCEPTED'
  | 'QUEUED'
  | 'PROCESSING'
  | 'SENT'
  | 'DELIVERED'
  | 'FAILED'
  | 'BOUNCED';

export interface UserRecord {
  id: string;
  email: string;
  api_key_hash?: string;
  role: 'user' | 'admin';
  tier: 'standard' | 'premium' | 'enterprise';
  rate_limit_per_minute: number;
  created_at: Date;
  updated_at: Date;
}

export interface EmailRequestRecord {
  id: string;
  user_id: string;
  recipient: string;
  subject: string;
  body_text?: string;
  body_html?: string;
  idempotency_key?: string;
  status: EmailStatus;
  attempt_count: number;
  max_retries: number;
  provider_id?: string;
  last_error?: string;
  created_at: Date;
  updated_at: Date;
  processed_at?: Date;
  sent_at?: Date;
  delivered_at?: Date;
}

export interface DeliveryLogRecord {
  id?: number | string;
  request_id: string;
  status: EmailStatus;
  attempt: number;
  provider_id?: string;
  provider_response?: string;
  error_message?: string;
  duration_ms?: number;
  created_at?: Date;
}

export interface IdempotencyRecord {
  key: string;
  user_id: string;
  request_id: string;
  created_at: Date;
  expires_at: Date;
}

export interface CreateEmailRequestDto {
  recipient: string;
  subject: string;
  body_text?: string;
  body_html?: string;
  idempotency_key?: string;
  template_id?: string;
  template_variables?: Record<string, string | number>;
}
