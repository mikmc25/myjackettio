import { createClient } from 'redis';

const client = createClient({
  url: 'rediss://default:AXiuAAIncDFlOThmNWMzMTFhMjY0N2YwYmEyN2NkOGU1MWVmYmRmYnAxMzA4OTQ@relaxing-flea-30894.upstash.io:6379',
});

client.on('error', (err) => {
  console.error('Redis Client Error', err);
  process.exit(1); // Exit the process if Redis connection fails
});

await client.connect();

export default client;
