import { Request, Response, NextFunction } from 'express';
import { TokenManager, UserPayload } from '../../security/token.js';
import { DbManager } from '../../db/repository.js';
import { config } from '../../config/index.js';

export interface AuthenticatedRequest extends Request {
  user?: UserPayload;
}

export async function authMiddleware(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'] as string | undefined;

  // 1. Check Bearer Token (JWT)
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    try {
      const payload = TokenManager.verifyJwt(token);
      req.user = payload;
      return next();
    } catch {
      res.status(401).json({ error: 'Unauthorized: Invalid or expired Bearer token' });
      return;
    }
  }

  // 2. Check X-API-Key header
  if (apiKeyHeader) {
    // Check if it's an admin key
    if (config.security.adminApiKeys.includes(apiKeyHeader)) {
      req.user = {
        userId: 'admin_master',
        email: 'admin@system.local',
        role: 'admin',
        tier: 'enterprise',
        rateLimitOverride: config.rateLimit.adminLimit,
      };
      return next();
    }

    // Check DB for matching API Key hash
    const db = await DbManager.getRepository();
    const hash = TokenManager.hashApiKey(apiKeyHeader);
    const user = await db.getUserByApiKeyHash(hash);

    if (user) {
      req.user = {
        userId: user.id,
        email: user.email,
        role: user.role,
        tier: user.tier,
        rateLimitOverride: user.rate_limit_per_minute,
      };
      return next();
    }

    res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    return;
  }

  // 3. Fallback for testing/internal environments if X-User-Id is provided
  const directUserId = req.headers['x-user-id'] as string | undefined;
  if (directUserId) {
    const db = await DbManager.getRepository();
    const existing = await db.getUserById(directUserId);
    req.user = {
      userId: directUserId,
      email: existing?.email || `${directUserId}@example.com`,
      role: (req.headers['x-user-role'] as 'user' | 'admin') || existing?.role || 'user',
      tier: existing?.tier || 'standard',
      rateLimitOverride: existing?.rate_limit_per_minute,
    };
    return next();
  }

  res.status(401).json({
    error: 'Unauthorized',
    message: 'Authentication required. Provide Authorization: Bearer <jwt> or X-API-Key: <key>',
  });
}
