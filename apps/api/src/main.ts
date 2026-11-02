import 'reflect-metadata';
import { createApp } from './bootstrap';
import { migrate } from './migrate';

async function main() {
  await migrate();
  const app = await createApp();
  const port = Number(process.env.API_PORT || 4000);
  await app.listen(port);
  console.log(`API: http://localhost:${port}/api  (DEV_TOOLS=${process.env.DEV_TOOLS === 'true'})`);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
