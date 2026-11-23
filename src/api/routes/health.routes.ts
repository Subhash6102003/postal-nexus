import { Router } from 'express';
import { HealthController } from '../controllers/health.controller.js';

const router = Router();

// GET /health - Liveness & dependency checks
router.get('/health', HealthController.getHealth);

// GET /ready - Readiness check
router.get('/ready', HealthController.getReadiness);

// GET /metrics - Prometheus metrics scraping
router.get('/metrics', HealthController.getMetrics);

export default router;
