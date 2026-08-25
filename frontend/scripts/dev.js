import { spawn } from 'child_process';

const args = process.argv.slice(2);
const env = { ...process.env };

// Strip out --project and its argument to hide it from Vite's strict CLI
const viteArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--project') {
    env.PROJECT_DIR = args[i + 1];
    i++; // Skip the value
  } else {
    viteArgs.push(args[i]);
  }
}

const child = spawn('bunx', ['vite', ...viteArgs], { 
  stdio: 'inherit', 
  env,
  shell: true
});

child.on('close', (code) => {
  process.exit(code);
});
