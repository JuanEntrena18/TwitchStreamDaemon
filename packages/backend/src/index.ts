import Fastify, { type FastifyBaseLogger } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyMultipart from '@fastify/multipart';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from './config.js';
import { logger, redirectConsoleToLogger } from './logger.js';
import { setupAuth, onAuth } from './auth/index.js';
import { requireLocalAuth } from './auth/api-auth.js';
import { setupChat, setEnterGiveaway, setAddTickets, setupChatGreeting } from './chat/index.js';
import { setupPiper } from './chat/piper.js';
import { setupSocketIO, getIO } from './socket/index.js';
import { setupGiveaways, enterGiveaway, addTickets } from './giveaways/index.js';
import { setupPredictions } from './predictions/index.js';
import { setupEventSub, stopEventSub } from './eventsub/index.js';
import { setupTracker } from './tracker/index.js';
import { setupHud } from './hud/index.js';
import { setupTimer } from './timer/index.js';
import { setupScoreboard } from './scoreboard/index.js';
import { setupMod } from './mod/index.js';
import { setupSubathon } from './subathon/index.js';
import { setupActivity } from './activity/index.js';
import { setupCommands } from './commands/index.js';
import { setupChatTimers } from './chat-timers/index.js';
import { setupFortnite } from './fortnite/index.js';
import { setupWow } from './wow/index.js';
import { setupSecurity } from './security/index.js';
import { setupAlertSounds } from './alert-sounds/index.js';
import { setupAvatars } from './avatars/index.js';
import { setupStreamAvatar } from './stream-avatar/index.js';
import { setupKpi } from './kpi/index.js';
import { setupSpeedrun } from './speedrun/index.js';
import { setupCalendar } from './calendar/index.js';
import { setupDiary } from './diary/index.js';
import { setupAds } from './ads/index.js';
import { setupObs } from './obs/index.js';
import { setupLayouts } from './layouts/index.js';
import { setupVibeDaemon } from './vibe-daemon/index.js';
import { setupYouTube } from './youtube/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function startServer(opts?: { port?: number; frontendDir?: string }) {
  redirectConsoleToLogger();
  const app = Fastify({ loggerInstance: logger as FastifyBaseLogger });

  const allowedOrigins = ['http://localhost:3000', 'http://localhost:5173', 'http://127.0.0.1:3000', 'http://127.0.0.1:5173'];
  await app.register(cors, { origin: allowedOrigins, credentials: false, methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] });
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: 20 * 1024 * 1024, // 20MB
    }
  });

  // Rate limiting — 100 req/min per IP
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

  // Security headers
  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-XSS-Protection', '0');
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    reply.header('Content-Security-Policy',
      "default-src 'self'; " +
      "connect-src 'self' https://id.twitch.tv https://api.twitch.tv wss://eventsub.wss.twitch.tv https://www.googleapis.com https://oauth2.googleapis.com https://raider.io ws://localhost:3000 ws://127.0.0.1:3000; " +
      "frame-src 'self' https://player.twitch.tv https://www.youtube.com; " +
      "img-src 'self' https://static-cdn.jtvnw.net https://howlongtobeat.com https://*.ggpht.com https://*.googleusercontent.com https://i.ytimg.com data: blob:; " +
      "media-src 'self' blob:; " +
      "script-src 'self' 'unsafe-inline' blob:; " +
      "worker-src 'self' blob:; " +
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com"
    );
    return payload;
  });

  // Serve frontend static files in production / standalone mode
  if (opts?.frontendDir) {
    await app.register(fastifyStatic, {
      root: opts.frontendDir,
      prefix: '/',
      wildcard: true,
      index: ['index.html'],
    });

    // SPA fallback: client-side routes (paths without dots like /sorteos, /config)
    // return index.html. Actual assets (JS/CSS/overlay.html) are served by the
    // wildcard handler; missing file paths with dots get 404.
    app.setNotFoundHandler((req, reply) => {
      const url = req.url.split('?')[0];
      if (!url.includes('.')) {
        return reply.sendFile('index.html');
      }
      reply.status(404).send({ error: 'Not found', path: req.url });
    });
  }

  // Protect all state-changing endpoints except auth routes and health check
  app.addHook('onRequest', async (req, reply) => {
    const publicPrefixes = ['/auth/', '/health', '/overlays/', '/socket.io/', '/hud/start-poll'];
    const isPublic = publicPrefixes.some((p) => req.url.startsWith(p));
    if (isPublic) return;

    const protectedMethods = ['POST', 'PUT', 'PATCH', 'DELETE'];
    if (protectedMethods.includes(req.method)) {
      return requireLocalAuth(req, reply);
    }
  });

  await setupAuth(app);
  await setupYouTube(app);
  setupSocketIO(app);
  setupGiveaways(app);
  setEnterGiveaway(enterGiveaway);
  setAddTickets(addTickets);
  setupChat().catch((err) => logger.warn({ err }, 'Twitch chat initial connect warning'));
  setupChatGreeting(app);
  setupPiper(app);
  setupEventSub();
  onAuth(() => { 
    setupChat(); 
    setupEventSub(); 
    try { getIO().emit('auth:changed'); } catch {}
  });
  setupPredictions(app);
  setupTracker(app);
  setupHud(app);
  setupTimer(app);
  setupScoreboard(app);
  setupMod(app);
  setupSubathon(app);
  setupActivity(app);
  setupCommands(app);
  setupChatTimers(app);
  setupFortnite(app);
  setupWow(app);
  setupSecurity(app);
  setupAlertSounds(app);
  setupAvatars(app);
  setupStreamAvatar(app);
  setupKpi(app);
  setupSpeedrun(app);
  setupCalendar(app);
  setupDiary(app);
  setupAds(app);
  setupObs(app);
  setupLayouts(app);
  setupVibeDaemon(app);

  app.get('/health', async () => ({ status: 'ok', timestamp: Date.now() }));

  const initialPort = opts?.port ?? parseInt(config.PORT, 10);
  const tryPorts = [initialPort, initialPort + 1, initialPort + 2];
  let boundPort = initialPort;
  let listening = false;
  for (const p of tryPorts) {
    try {
      await app.listen({ port: p, host: '::' });
      boundPort = p;
      listening = true;
      break;
    } catch (err: unknown) {
      const isAddrInUse = err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'EADDRINUSE';
      if (isAddrInUse) {
        logger.warn({ port: p }, 'Port already in use, trying next port...');
        continue;
      }
      try {
        await app.listen({ port: p, host: '0.0.0.0' });
        boundPort = p;
        listening = true;
        break;
      } catch (err2: unknown) {
        const isAddrInUse2 = err2 && typeof err2 === 'object' && 'code' in err2 && (err2 as { code: string }).code === 'EADDRINUSE';
        if (isAddrInUse2) {
          logger.warn({ port: p }, 'Port already in use, trying next port...');
          continue;
        }
        throw err2;
      }
    }
  }

  if (!listening) {
    throw new Error(`Could not bind to any port in range [${tryPorts.join(', ')}]`);
  }
  logger.info({ port: boundPort }, 'Server running');

  return { app, port: boundPort };
}

// Auto-start when run directly (not imported)
const isMainModule = process.argv[1]?.includes('index');
if (isMainModule) {
  const frontendDir = path.resolve(__dirname, '../../frontend/dist');
  startServer({ frontendDir }).catch((err) => {
    logger.error(err, 'Failed to start server');
    process.exit(1);
  });
}
