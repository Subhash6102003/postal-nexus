import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config/index.js';

export interface UserPayload {
  userId: string;
  email: string;
  role: 'user' | 'admin';
  tier?: 'standard' | 'premium' | 'enterprise';
  rateLimitOverride?: number;
}

export class TokenManager {
  private static readonly secret = config.security.jwtSecret;

  static generateJwt(payload: UserPayload, expiresIn: string | number = '24h'): string {
    return jwt.sign(payload, this.secret, { expiresIn: expiresIn as any });
  }

  static verifyJwt(token: string): UserPayload {
    return jwt.verify(token, this.secret) as UserPayload;
  }

  static hashApiKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  static generateApiKey(prefix = 'pm_live_'): { rawKey: string; hash: string } {
    const randomBytes = crypto.randomBytes(24).toString('hex');
    const rawKey = `${prefix}${randomBytes}`;
    const hash = this.hashApiKey(rawKey);
    return { rawKey, hash };
  }
}
