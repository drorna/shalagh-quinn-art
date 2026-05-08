import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://shalaghquinn.com',
  image: {
    service: { entrypoint: 'astro/assets/services/sharp' },
  },
  build: {
    assets: 'assets',
  },
});
