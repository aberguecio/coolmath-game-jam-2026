import { defineConfig, loadEnv } from 'vite';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';

const OBS_PATH = '/tmp/coolmath-obs.json';
const ACT_PATH = '/tmp/coolmath-actions.json';

// Plugin in-process: el browser POSTea obs y polea acciones al MISMO origen
// que sirve la app. Evita CORS y problemas de sandboxing del webview de cmux
// (que en algunos casos no puede alcanzar puertos distintos al de la app).
function bridgePlugin() {
  let lastObsDay = null;
  return {
    name: 'coolmath-bridge',
    configureServer(server) {
      server.middlewares.use('/__bridge/obs', (req, res, next) => {
        if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
        if (req.method !== 'POST') return next();
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { writeFileSync(OBS_PATH, raw); } catch {}
          try { lastObsDay = JSON.parse(raw)?.time?.totalDays ?? null; } catch {}
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ ok: true, day: lastObsDay }));
        });
      });
      server.middlewares.use('/__bridge/actions', (req, res, next) => {
        if (req.method !== 'GET') return next();
        let body = [];
        if (existsSync(ACT_PATH)) {
          try {
            const payload = JSON.parse(readFileSync(ACT_PATH, 'utf8'));
            if (payload?.forDay == null || lastObsDay == null || payload.forDay === lastObsDay) {
              body = payload?.actions ?? [];
              try { unlinkSync(ACT_PATH); } catch {}
            }
          } catch {}
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(body));
      });
      server.middlewares.use('/__bridge/status', (req, res, next) => {
        if (req.method !== 'GET') return next();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({
          lastObsDay,
          obsFileExists: existsSync(OBS_PATH),
          actFileExists: existsSync(ACT_PATH),
        }));
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const port = Number(env.PORT) || 3333;

  return {
    root: '.',
    publicDir: 'public',
    plugins: [bridgePlugin()],
    server: {
      port,
      strictPort: true,
      open: true,
      host: true,
    },
    preview: {
      port,
      strictPort: true,
    },
    build: {
      outDir: 'dist',
      target: 'es2020',
      minify: 'esbuild',
      sourcemap: true,
    },
  };
});
