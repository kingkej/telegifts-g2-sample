import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, normalizePath } from 'vite'

const project = dirname(fileURLToPath(import.meta.url))
const speechModelFiles = new Map(['mdef', 'means', 'variances', 'sendump', 'transition_matrices'].map(name => {
  const file = resolve(project, 'node_modules/soundswallower/model/en-us', name)
  return [encodeURI('/@fs/' + normalizePath(file).replace(/^\//, '')), file]
}))

const assetFileNames = assetInfo => {
  const rawName = assetInfo.names?.[0] ?? assetInfo.name ?? ''
  return /\.[a-z0-9]+$/i.test(rawName) ? 'assets/[name]-[hash][extname]' : 'assets/[name]-[hash].bin'
}

export default defineConfig({
  root: project,
  base: './',
  plugins: [
    react(),
    {
      name: 'serve-speech-model-bytes',
      apply: 'serve',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://localhost')
          if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/telegifts-g2.ehpk') {
            const ehpkFile = resolve(project, 'telegifts-g2.ehpk')
            if (!existsSync(ehpkFile)) {
              response.statusCode = 404
              response.end()
              return
            }
            response.setHeader('Content-Type', 'application/octet-stream')
            response.setHeader('Content-Disposition', 'attachment; filename="telegifts-g2.ehpk"')
            response.setHeader('Content-Length', String(statSync(ehpkFile).size))
            if (request.method === 'HEAD') {
              response.end()
              return
            }
            createReadStream(ehpkFile).on('error', next).pipe(response)
            return
          }
          const file = speechModelFiles.get(url.pathname)
          if (
            request.method !== 'GET'
            || !file
            || !url.searchParams.has('no-inline')
            || url.searchParams.has('url')
            || url.searchParams.has('import')
          ) {
            return next()
          }
          response.setHeader('Content-Type', 'application/octet-stream')
          createReadStream(file).on('error', next).pipe(response)
        })
      },
    },
    {
      name: 'voice-recognition-notices',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'licenses/voice-recognition.txt',
          source: readFileSync(resolve(project, 'src/assets/voice-recognition/NOTICE.txt')),
        })
      },
    },
  ],
  worker: {
    format: 'es',
    rollupOptions: {
      output: { assetFileNames },
    },
  },
  optimizeDeps: { exclude: ['soundswallower'] },
  resolve: {
    alias: {
      '@': resolve(project, 'src'),
      '@telegifts/phone/style.css': resolve(project, 'vendor/telegifts-phone/style.css'),
      '@telegifts/phone': resolve(project, 'vendor/telegifts-phone/index.js'),
      '@telegifts/host-bridge': resolve(project, 'src/services/phoneHostBridge.ts'),
      'blob-polyfill': resolve(project, 'src/voiceRecognitionBlob.ts'),
    },
  },
  server: {
    host: 'localhost',
    port: 3000,
    strictPort: true,
    fs: { allow: [project] },
  },
  preview: {
    host: 'localhost',
    port: 3000,
    strictPort: true,
  },
  build: {
    outDir: resolve(project, 'dist'),
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      output: { assetFileNames },
    },
  },
})
