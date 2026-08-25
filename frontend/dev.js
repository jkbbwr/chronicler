import { createServer } from 'vite';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function start() {
  const args = process.argv.slice(2);
  
  // Start Vite server programmatically (bypassing strict CLI)
  const server = await createServer({
    configFile: path.resolve(__dirname, 'vite.config.ts'),
    root: __dirname,
    server: {
      port: 5173,
    }
  });
  
  await server.listen();
  server.printUrls();
}

start();
