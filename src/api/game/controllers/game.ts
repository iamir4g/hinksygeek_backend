import { factories } from '@strapi/strapi';

function withoutCommentsPopulate(populate: unknown) {
  if (!populate) return populate;

  if (Array.isArray(populate)) {
    return populate.filter((p) => !(typeof p === 'string' && p.startsWith('comments')));
  }

  if (typeof populate === 'string') {
    return populate.startsWith('comments') ? undefined : populate;
  }

  if (typeof populate === 'object') {
    const next = { ...(populate as Record<string, unknown>) };
    delete next['comments'];
    return next;
  }

  return populate;
}

export default factories.createCoreController('api::game.game', () => ({
  async find(ctx) {
    if (!ctx.state.user) {
      ctx.query = {
        ...ctx.query,
        populate: withoutCommentsPopulate(ctx.query?.populate),
      };
    }
    return await super.find(ctx);
  },

  async findOne(ctx) {
    if (!ctx.state.user) {
      ctx.query = {
        ...ctx.query,
        populate: withoutCommentsPopulate(ctx.query?.populate),
      };
    }
    return await super.findOne(ctx);
  },
}));
