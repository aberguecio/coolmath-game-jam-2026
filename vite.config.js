import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, process.cwd(), ''), ...process.env };
  const port = Number(env.PORT) || 3333;

  return {
    root: '.',
    publicDir: 'public',
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
