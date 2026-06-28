import { mergeConfig, type UserConfig } from 'vite';

export default (config: UserConfig) => {
  return mergeConfig(config, {
    resolve: {
      dedupe: ['react', 'react-dom', 'styled-components', '@strapi/strapi'],
    },
  });
};
